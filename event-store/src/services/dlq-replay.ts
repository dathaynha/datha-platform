import type { JetStreamClient } from "@nats-io/jetstream";
import type { Pool } from "pg";
import { parseEnvelope } from "./ingest";
import { getDlqRecordRowById, markDlqReplayed } from "./dlq-query";
import { encodeJsonPayload } from "../nats/encode-payload";

export class DlqReplayError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "DlqReplayError";
  }
}

/** Re-publish stored envelope to original_subject on EVENTS (domain consumers handle retry). */
export async function replayDlqRecord(
  db: Pool,
  js: JetStreamClient,
  id: string,
): Promise<{ id: string; originalSubject: string; replayedAt: string }> {
  const row = await getDlqRecordRowById(db, id);
  if (!row) {
    throw new DlqReplayError("DLQ record not found", 404);
  }
  if (
    row.envelope == null ||
    typeof row.envelope !== "object" ||
    Array.isArray(row.envelope)
  ) {
    throw new DlqReplayError("DLQ record has no envelope; cannot replay", 400);
  }

  if (row.replayed_at != null) {
    throw new DlqReplayError("DLQ record already replayed", 409);
  }

  let envelope;
  try {
    envelope = parseEnvelope(
      new TextEncoder().encode(JSON.stringify(row.envelope)),
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "invalid stored envelope";
    throw new DlqReplayError(message, 400);
  }

  const subject = row.original_subject;
  await js.publish(subject, encodeJsonPayload(envelope));

  const replayedAt = await markDlqReplayed(db, id);
  if (!replayedAt) {
    throw new DlqReplayError("DLQ record already replayed", 409);
  }

  return {
    id,
    originalSubject: subject,
    replayedAt: replayedAt.toISOString(),
  };
}
