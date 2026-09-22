/**
 * JetStream names used at runtime. Topology (streams + durables) is reconciled by
 * `platform-nats` repo (`pnpm reconcile`) — do not create or update broker config here.
 */
import { config } from "../config";

export const STREAM_EVENTS = "EVENTS";
export const STREAM_DLQ = "DLQ";
export const CONSUMER_EVENTS = "notification-service-events";
export const CONSUMER_DLQ = "notification-service-dlq";

/** DLQ sink when EVENTS projection exhausts max_deliver (sync env with platform-nats). */
export const DLQ_SINK_PROJECTION = "notification_service.projection";

export const fetchOptions = {
  max_messages: config.NATS_INGEST_BATCH_SIZE,
  expires: 30_000,
} as const;
