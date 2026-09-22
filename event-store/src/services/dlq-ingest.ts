import type { Pool } from "pg";
import type { DlqMessageBody } from "../types/dlq";
import { STREAM_DLQ } from "../nats/streams";

const DLQ_PREFIX = "events.dlq.";

function parseNullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`${label} must be string or null`);
}

export function sinkFromSubject(subject: string): string {
  if (!subject.startsWith(DLQ_PREFIX)) {
    throw new Error(`DLQ subject must start with ${DLQ_PREFIX}`);
  }
  const sink = subject.slice(DLQ_PREFIX.length);
  if (!sink) {
    throw new Error("DLQ subject missing sink segment");
  }
  return sink;
}

export function parseDlqBody(data: Uint8Array): DlqMessageBody {
  const raw = JSON.parse(new TextDecoder().decode(data)) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("DLQ body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.original_subject !== "string" || !b.original_subject) {
    throw new Error("DLQ original_subject is required");
  }
  if (typeof b.last_error !== "string" || !b.last_error) {
    throw new Error("DLQ last_error is required");
  }
  if (
    typeof b.failed_at !== "string" ||
    Number.isNaN(Date.parse(b.failed_at))
  ) {
    throw new Error("DLQ failed_at must be ISO 8601");
  }
  const correlationId = parseNullableString(
    b.correlation_id,
    "DLQ correlation_id",
  );
  const ownerId = parseNullableString(b.owner_id, "DLQ owner_id");
  return {
    original_subject: b.original_subject,
    correlation_id: correlationId,
    owner_id: ownerId,
    payload: b.payload,
    last_error: b.last_error,
    failed_at: b.failed_at,
    envelope: b.envelope,
  };
}

export async function ingestDlqMessage(
  db: Pool,
  subject: string,
  streamSequence: number,
  body: DlqMessageBody,
): Promise<void> {
  const sink = sinkFromSubject(subject);
  await db.query(
    `INSERT INTO dlq_records (
       subject, sink, jetstream_stream, jetstream_sequence,
       original_subject, owner_id, correlation_id, last_error, failed_at, payload, envelope
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
     ON CONFLICT (jetstream_stream, jetstream_sequence) DO NOTHING`,
    [
      subject,
      sink,
      STREAM_DLQ,
      streamSequence,
      body.original_subject,
      body.owner_id,
      body.correlation_id,
      body.last_error,
      body.failed_at,
      body.payload != null ? JSON.stringify(body.payload) : null,
      body.envelope != null ? JSON.stringify(body.envelope) : null,
    ],
  );
}
