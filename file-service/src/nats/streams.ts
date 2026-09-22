/**
 * JetStream names used at runtime. Topology (streams + durables) is reconciled by
 * `platform-nats` repo (`pnpm reconcile`) — do not create or update broker config here.
 */
export const STREAM_EVENTS = "EVENTS";
export const STREAM_DLQ = "DLQ";
export const CONSUMER_CONVERSATION_CLEANUP =
  "file-service-conversation-cleanup";

/** Env var for app-side DLQ on this consumer — must match platform-nats `maxDeliverForDurable` for the same durable name. */
export const CONVERSATION_CLEANUP_MAX_DELIVER_ENV =
  "NATS_CONSUMER_MAX_DELIVER_FILE_SERVICE_CONVERSATION_CLEANUP";
export const SUBJECT_CONVERSATION_DELETED =
  "events.chatbot.conversation.deleted";
export const DLQ_SINK_CONVERSATION_CLEANUP = "file.conversation_cleanup";
