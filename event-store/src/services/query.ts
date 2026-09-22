import type { Pool } from "pg";
import { encodeCursor, type EventCursor } from "../lib/cursor";
import type { EventRow } from "../types/events";

/**
 * Count matching rows, but never read more than `cap` of them.
 *
 * `SELECT COUNT(*) WHERE …` reads every matching row, so an ops list that is
 * usually opened unfiltered gets slower forever as the store grows — and the
 * exact total is worth nothing past the first few pages, because nobody pages
 * to record 40,000. Counting a `LIMIT cap + 1` subquery reads at most cap + 1
 * rows whatever the table holds; one over the cap is what tells the caller the
 * number is a floor rather than a total, so the UI can say "10,000+" instead of
 * a confident wrong number.
 *
 * Deep `OFFSET` is bounded by the same cap, since the page links stop there.
 */
export async function countCapped(
  db: Pool,
  sql: string,
  values: unknown[],
  cap: number,
): Promise<{ total: number; capped: boolean }> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM (${sql} LIMIT ${cap + 1}) capped`,
    values,
  );
  const counted = parseInt(result.rows[0]?.count ?? "0", 10);
  return { total: Math.min(counted, cap), capped: counted > cap };
}

export interface EventQueryParams {
  ownerId?: string;
  types?: string[];
  services?: string[];
  entityId?: string;
  correlationId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
  order?: "asc" | "desc";
  /**
   * Equality filters on `payload` fields, e.g. `{ origin: "messenger" }`.
   *
   * Matched by containment so one GIN index serves every key. Values arrive
   * from a query string and are therefore text, but payloads hold numbers and
   * booleans too (measured on the dev database: 3,650 strings, 238 numbers, 1
   * boolean) — and containment is type-strict, so `{"size_bytes": "2048"}`
   * would silently never match the number `2048`. Each pair is therefore
   * matched as the string **or** as the JSON scalar it parses to, both of which
   * the same index answers.
   */
  payload?: Record<string, string>;
  /** Ceiling on the reported total; see {@link countCapped}. */
  countCap: number;
  /**
   * Keyset cursor: return the rows strictly after this one in the sort order.
   *
   * This is how the list continues past the count cap, where `offset` stops
   * being offered — an `OFFSET` of 10,000 reads and discards 10,000 rows, which
   * is the cost the cap exists to avoid, so continuing to offer it there would
   * hand back exactly what was just saved. When set, `offset` is ignored.
   */
  after?: EventCursor;
}

/**
 * The JSON scalar a query-string value stands for, or undefined when it is
 * only ever a string. `"2048"` is both; `"messenger"` is only the string.
 */
function jsonScalar(value: string): number | boolean | null | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  // `Number("")` is 0 and `Number(" 1 ")` is 1, so require a strict numeric
  // literal rather than trusting the coercion.
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

function rowToEvent(row: EventRow) {
  return {
    id: row.id,
    type: row.type,
    service: row.service,
    entityId: row.entity_id,
    ownerId: row.owner_id,
    correlationId: row.correlation_id,
    timestamp: row.timestamp.toISOString(),
    payload: row.payload,
  };
}

export async function queryEvents(
  db: Pool,
  params: EventQueryParams,
): Promise<{
  data: ReturnType<typeof rowToEvent>[];
  total: number;
  totalCapped: boolean;
  /** Feed back as `after` for the next page; null when this is the last one. */
  nextCursor: string | null;
}> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.ownerId) {
    conditions.push(`owner_id = $${idx++}`);
    values.push(params.ownerId);
  }

  if (params.types?.length) {
    conditions.push(`type = ANY($${idx++})`);
    values.push(params.types);
  }
  if (params.services?.length) {
    conditions.push(`service = ANY($${idx++})`);
    values.push(params.services);
  }
  if (params.entityId) {
    conditions.push(`entity_id = $${idx++}`);
    values.push(params.entityId);
  }
  if (params.correlationId) {
    conditions.push(`correlation_id = $${idx++}`);
    values.push(params.correlationId);
  }
  if (params.from) {
    conditions.push(`timestamp >= $${idx++}`);
    values.push(params.from);
  }
  if (params.to) {
    conditions.push(`timestamp <= $${idx++}`);
    values.push(params.to);
  }

  for (const [key, value] of Object.entries(params.payload ?? {})) {
    // The key never reaches the SQL text — it is part of a bound JSON value —
    // so there is no identifier to quote and nothing to inject through.
    const asText = JSON.stringify({ [key]: value });
    const typed = jsonScalar(value);
    if (typed === undefined) {
      conditions.push(`payload @> $${idx++}::jsonb`);
      values.push(asText);
    } else {
      conditions.push(
        `(payload @> $${idx++}::jsonb OR payload @> $${idx++}::jsonb)`,
      );
      values.push(asText, JSON.stringify({ [key]: typed }));
    }
  }

  // The count must not see the cursor: `total` describes the whole filtered
  // result, and narrowing it page by page would make the readout shrink as you
  // walk. Captured before the keyset predicate joins the list.
  const countWhere = conditions.length > 0 ? conditions.join(" AND ") : "true";

  const counted = await countCapped(
    db,
    `SELECT 1 FROM events WHERE ${countWhere}`,
    [...values],
    params.countCap,
  );

  const orderDir = params.order === "asc" ? "ASC" : "DESC";

  if (params.after) {
    // Row comparison, not `timestamp < $n OR (timestamp = $n AND id < $m)`:
    // the tuple form is what a `(timestamp, id)` index can seek on directly,
    // and it cannot be got subtly wrong at the boundary.
    const comparison = orderDir === "ASC" ? ">" : "<";
    conditions.push(
      `(timestamp, id) ${comparison} ($${idx++}, $${idx++}::uuid)`,
    );
    values.push(params.after.timestamp, params.after.id);
  }

  const where = conditions.length > 0 ? conditions.join(" AND ") : "true";

  // One more than asked for: whether a next page exists is a fact about the
  // data, and the alternative — inferring it from `total` — is exactly the
  // number the cap refuses to compute past the ceiling.
  const limitIdx = idx++;
  const listValues: unknown[] = [...values, params.limit + 1];
  let offsetClause = "";
  if (!params.after) {
    offsetClause = ` OFFSET $${idx++}`;
    listValues.push(params.offset);
  }

  const listResult = await db.query<EventRow>(
    `SELECT id, type, service, entity_id, owner_id, correlation_id, timestamp, payload
     FROM events
     WHERE ${where}
     ORDER BY timestamp ${orderDir}, id ${orderDir}
     LIMIT $${limitIdx}${offsetClause}`,
    listValues,
  );

  const hasMore = listResult.rows.length > params.limit;
  const rows = hasMore
    ? listResult.rows.slice(0, params.limit)
    : listResult.rows;
  const last = rows[rows.length - 1];

  return {
    data: rows.map(rowToEvent),
    total: counted.total,
    totalCapped: counted.capped,
    nextCursor:
      hasMore && last
        ? encodeCursor({ timestamp: last.timestamp.toISOString(), id: last.id })
        : null,
  };
}

export async function getEventById(
  db: Pool,
  id: string,
): Promise<ReturnType<typeof rowToEvent> | null> {
  const result = await db.query<EventRow>(
    `SELECT id, type, service, entity_id, owner_id, correlation_id, timestamp, payload
     FROM events
     WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? rowToEvent(row) : null;
}

/**
 * Every service that has actually published an event, ascending.
 *
 * A "loose index scan": walk `events_service_idx` one distinct value at a time
 * rather than reading it end to end. `SELECT DISTINCT service` would scan the
 * whole table today and the whole index once it is indexed — Postgres 16 has no
 * index skip scan — so the cost would grow with the event count, which is the
 * one number this table guarantees will grow. This form costs N+1 index probes
 * for N services and does not care how many rows sit behind them.
 *
 * The frontend's filter was a hard-coded constant before this existed, and it
 * had drifted to the point where 78% of events could not be filtered at all
 * (measured 2026-09-19: 560 of 715).
 */
export async function listEventServices(db: Pool): Promise<string[]> {
  const result = await db.query<{ service: string }>(
    `WITH RECURSIVE distinct_service AS (
       (SELECT service FROM events ORDER BY service LIMIT 1)
       UNION ALL
       SELECT (SELECT e.service
               FROM events e
               WHERE e.service > d.service
               ORDER BY e.service
               LIMIT 1)
       FROM distinct_service d
       WHERE d.service IS NOT NULL
     )
     SELECT service FROM distinct_service WHERE service IS NOT NULL`,
  );
  return result.rows.map((row) => row.service);
}

/**
 * Distinct event types, ascending.
 *
 * Same loose index scan as `listEventServices`, over `events_type_idx` — PG16
 * has no index skip scan, so a plain `SELECT DISTINCT type` reads every index
 * entry while this costs N+1 probes for N types.
 *
 * The filter this feeds was free text over about ten values, which meant a
 * typo returned an empty list that looks exactly like "no events of that kind".
 */
export async function listEventTypes(db: Pool): Promise<string[]> {
  const result = await db.query<{ type: string }>(
    `WITH RECURSIVE distinct_type AS (
       (SELECT type FROM events ORDER BY type LIMIT 1)
       UNION ALL
       SELECT (SELECT e.type
               FROM events e
               WHERE e.type > d.type
               ORDER BY e.type
               LIMIT 1)
       FROM distinct_type d
       WHERE d.type IS NOT NULL
     )
     SELECT type FROM distinct_type WHERE type IS NOT NULL`,
  );
  return result.rows.map((row) => row.type);
}

/**
 * How many recent events the payload-key and payload-value lookups read.
 *
 * `jsonb_object_keys` over the whole table is a scan that cannot be index-fed,
 * and this store only grows — the same problem the count cap exists for. These
 * lists feed a filter's dropdown, where "the fields events actually carry
 * lately" is the useful answer and a full-history sweep is not, so the work is
 * bounded instead: newest N rows, then distinct within them.
 */
export const PAYLOAD_SAMPLE_ROWS = 5000;
/** Upper bound on a value list, so one high-cardinality key cannot flood it. */
export const PAYLOAD_VALUE_LIMIT = 200;

/** Payload field names present in the recent sample, ascending. */
export async function listPayloadKeys(db: Pool): Promise<string[]> {
  const result = await db.query<{ key: string }>(
    `SELECT DISTINCT k.key
     FROM (
       SELECT payload FROM events ORDER BY timestamp DESC LIMIT $1
     ) recent,
     LATERAL jsonb_object_keys(recent.payload) AS k(key)
     ORDER BY k.key`,
    [PAYLOAD_SAMPLE_ROWS],
  );
  return result.rows.map((row) => row.key);
}

/**
 * Values seen for one payload field, ascending.
 *
 * Scalars only: an array or an object has no single value a user could pick,
 * and `->>` would render it as JSON text that matches nothing when filtered.
 */
export async function listPayloadValues(
  db: Pool,
  key: string,
): Promise<string[]> {
  const result = await db.query<{ value: string }>(
    `SELECT DISTINCT recent.payload ->> $1 AS value
     FROM (
       SELECT payload FROM events ORDER BY timestamp DESC LIMIT $2
     ) recent
     WHERE recent.payload ? $1
       AND jsonb_typeof(recent.payload -> $1) NOT IN ('object', 'array')
       AND recent.payload ->> $1 IS NOT NULL
     ORDER BY value
     LIMIT $3`,
    [key, PAYLOAD_SAMPLE_ROWS, PAYLOAD_VALUE_LIMIT],
  );
  return result.rows.map((row) => row.value);
}
