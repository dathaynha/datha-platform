import type { Pool } from "pg";
import type { PlatformEvent } from "../types/events";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseNullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`${label} must be string or null`);
}

export function parseEnvelope(data: Uint8Array): PlatformEvent {
  const raw = JSON.parse(new TextDecoder().decode(data)) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("envelope must be a JSON object");
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !UUID_RE.test(e.id)) {
    throw new Error("envelope.id must be a uuid v4 string");
  }
  if (typeof e.type !== "string" || !e.type) {
    throw new Error("envelope.type is required");
  }
  if (typeof e.service !== "string" || !e.service) {
    throw new Error("envelope.service is required");
  }
  const entityId = parseNullableString(e.entity_id, "envelope.entity_id");
  const ownerId = parseNullableString(e.owner_id, "envelope.owner_id");
  const correlationId = parseNullableString(
    e.correlation_id,
    "envelope.correlation_id",
  );
  if (
    typeof e.timestamp !== "string" ||
    Number.isNaN(Date.parse(e.timestamp))
  ) {
    throw new Error("envelope.timestamp must be ISO 8601");
  }
  if (!e.payload || typeof e.payload !== "object" || Array.isArray(e.payload)) {
    throw new Error("envelope.payload must be a JSON object");
  }

  return {
    id: e.id,
    type: e.type,
    service: e.service,
    entity_id: entityId,
    owner_id: ownerId,
    correlation_id: correlationId,
    timestamp: e.timestamp,
    payload: e.payload as Record<string, unknown>,
  };
}

/**
 * Idempotent persist — duplicate JetStream delivery is a no-op.
 *
 * The conflict target is `(id, timestamp)` because a partitioned table's unique
 * index must contain the partition key. Dedupe stays global: every republish
 * path, DLQ replay included, sends the stored envelope verbatim, so the
 * timestamp is the one the first insert used.
 */
export async function ingestEvent(
  db: Pool,
  envelope: PlatformEvent,
): Promise<void> {
  await db.query(
    `INSERT INTO events (id, type, service, entity_id, owner_id, correlation_id, timestamp, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (id, "timestamp") DO NOTHING`,
    [
      envelope.id,
      envelope.type,
      envelope.service,
      envelope.entity_id,
      envelope.owner_id,
      envelope.correlation_id,
      envelope.timestamp,
      JSON.stringify(envelope.payload),
    ],
  );
}
