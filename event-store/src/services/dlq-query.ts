import type { Pool } from "pg";
import type { DlqRecordRow } from "../types/dlq";
import { countCapped } from "./query";

export interface DlqQueryParams {
  ownerId?: string;
  sinks?: string[];
  correlationId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
  order?: "asc" | "desc";
  /** Ceiling on the reported total; see `countCapped` in `query.ts`. */
  countCap: number;
}

const DLQ_SELECT = `id, subject, sink, jetstream_stream, jetstream_sequence::text,
            original_subject, owner_id, correlation_id, last_error, failed_at,
            payload, envelope, ingested_at, replayed_at`;

function rowToDlq(row: DlqRecordRow) {
  return {
    id: row.id,
    subject: row.subject,
    sink: row.sink,
    originalSubject: row.original_subject,
    ownerId: row.owner_id,
    correlationId: row.correlation_id,
    lastError: row.last_error,
    failedAt: row.failed_at.toISOString(),
    payload: row.payload,
    envelope: row.envelope,
    ingestedAt: row.ingested_at.toISOString(),
    replayedAt: row.replayed_at?.toISOString() ?? null,
    jetstreamStream: row.jetstream_stream,
    jetstreamSequence: row.jetstream_sequence,
  };
}

export async function queryDlqRecords(
  db: Pool,
  params: DlqQueryParams,
): Promise<{
  data: ReturnType<typeof rowToDlq>[];
  total: number;
  totalCapped: boolean;
}> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.ownerId) {
    conditions.push(`owner_id = $${idx++}`);
    values.push(params.ownerId);
  }

  if (params.sinks?.length) {
    conditions.push(`sink = ANY($${idx++})`);
    values.push(params.sinks);
  }
  if (params.correlationId) {
    conditions.push(`correlation_id = $${idx++}`);
    values.push(params.correlationId);
  }
  if (params.from) {
    conditions.push(`failed_at >= $${idx++}`);
    values.push(params.from);
  }
  if (params.to) {
    conditions.push(`failed_at <= $${idx++}`);
    values.push(params.to);
  }

  const where = conditions.length > 0 ? conditions.join(" AND ") : "true";

  const counted = await countCapped(
    db,
    `SELECT 1 FROM dlq_records WHERE ${where}`,
    values,
    params.countCap,
  );

  const orderDir = params.order === "asc" ? "ASC" : "DESC";

  const limitIdx = idx++;
  const offsetIdx = idx++;
  const listResult = await db.query<DlqRecordRow>(
    `SELECT ${DLQ_SELECT}
     FROM dlq_records
     WHERE ${where}
     ORDER BY failed_at ${orderDir}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...values, params.limit, params.offset],
  );

  return {
    data: listResult.rows.map(rowToDlq),
    total: counted.total,
    totalCapped: counted.capped,
  };
}

export async function getDlqRecordRowById(
  db: Pool,
  id: string,
): Promise<DlqRecordRow | null> {
  const { rows } = await db.query<DlqRecordRow>(
    `SELECT ${DLQ_SELECT} FROM dlq_records WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getDlqRecordById(
  db: Pool,
  id: string,
): Promise<ReturnType<typeof rowToDlq> | null> {
  const row = await getDlqRecordRowById(db, id);
  return row ? rowToDlq(row) : null;
}

/** Atomically set replayed_at; returns null if already replayed or id missing. */
export async function markDlqReplayed(
  db: Pool,
  id: string,
): Promise<Date | null> {
  const { rows } = await db.query<{ replayed_at: Date }>(
    `UPDATE dlq_records SET replayed_at = now() WHERE id = $1 AND replayed_at IS NULL RETURNING replayed_at`,
    [id],
  );
  return rows[0]?.replayed_at ?? null;
}

/**
 * Every sink that has actually dead-lettered a record, ascending.
 *
 * Same loose index scan as `listEventServices`, over `dlq_records_sink_idx`.
 * See that function for why `SELECT DISTINCT` is not used.
 *
 * The constant this replaces was wrong in both directions: it offered two sinks
 * with zero records and omitted the only one that had any (measured
 * 2026-09-19), so every sink the filter offered returned an empty table.
 */
export async function listDlqSinks(db: Pool): Promise<string[]> {
  const result = await db.query<{ sink: string }>(
    `WITH RECURSIVE distinct_sink AS (
       (SELECT sink FROM dlq_records ORDER BY sink LIMIT 1)
       UNION ALL
       SELECT (SELECT r.sink
               FROM dlq_records r
               WHERE r.sink > d.sink
               ORDER BY r.sink
               LIMIT 1)
       FROM distinct_sink d
       WHERE d.sink IS NOT NULL
     )
     SELECT sink FROM distinct_sink WHERE sink IS NOT NULL`,
  );
  return result.rows.map((row) => row.sink);
}
