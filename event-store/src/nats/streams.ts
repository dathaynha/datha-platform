/**
 * JetStream names used at runtime. Topology (streams + durables) is reconciled by
 * `platform-nats` repo (`pnpm reconcile`) — do not create or update broker config here.
 */
import { config } from "../config";

export const STREAM_EVENTS = "EVENTS";
export const STREAM_DLQ = "DLQ";
export const CONSUMER_INGEST = "event-store-ingest";
export const CONSUMER_DLQ_INGEST = "event-store-dlq-ingest";

/** DLQ sink when EVENTS ingest exhausts max_deliver (sync env with platform-nats). */
export const DLQ_SINK_EVENT_STORE_INGEST = "event_store.ingest";

export const ingestFetchOptions = {
  max_messages: config.NATS_INGEST_BATCH_SIZE,
  expires: 30_000,
} as const;
