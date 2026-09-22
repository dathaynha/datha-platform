/**
 * Platform JetStream streams and durables (reconciled by `pnpm reconcile` — not on app startup).
 * Keep durable *names* in sync with each service `src/nats/streams.ts`.
 */
import {
  AckPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerConfig,
  type StreamConfig,
} from "@nats-io/jetstream";
import { maxDeliverForDurable } from "./max-deliver";

export const STREAM_EVENTS = "EVENTS";
export const STREAM_DLQ = "DLQ";

export const CONSUMER_FILE_CONVERSATION_CLEANUP =
  "file-service-conversation-cleanup";
export const CONSUMER_EVENT_STORE_INGEST = "event-store-ingest";
export const CONSUMER_EVENT_STORE_DLQ_INGEST = "event-store-dlq-ingest";
export const CONSUMER_NOTIFICATION_EVENTS = "notification-service-events";
export const CONSUMER_NOTIFICATION_DLQ = "notification-service-dlq";
export const CONSUMER_MESSENGER_CALLS = "messenger-service-calls";

export const SUBJECT_CONVERSATION_DELETED =
  "events.chatbot.conversation.deleted";

/** Call lifecycle events published by realtime-service, projected into history by messenger-service. */
export const SUBJECT_MESSENGER_CALLS = "events.messenger.call.>";

const ONE_GIB = 1024 * 1024 * 1024;

function daysToNs(days: number): number {
  return days * 24 * 60 * 60 * 1_000_000_000;
}

/** JetStream replay buffer — shorter than Postgres EVENTS_RETENTION_DAYS (see platform/event-store-architecture.md). */
function jetstreamEventsMaxAgeNs(): number {
  const raw = process.env.JETSTREAM_EVENTS_MAX_AGE_DAYS;
  const days = raw ? Number.parseInt(raw, 10) : 14;
  return daysToNs(Number.isFinite(days) && days > 0 ? days : 14);
}

function jetstreamDlqMaxAgeNs(): number {
  const raw = process.env.JETSTREAM_DLQ_MAX_AGE_DAYS;
  const days = raw ? Number.parseInt(raw, 10) : 30;
  return daysToNs(Number.isFinite(days) && days > 0 ? days : 30);
}

function pullConsumer(
  durableName: string,
  extra?: Partial<ConsumerConfig>,
): Partial<ConsumerConfig> {
  return {
    durable_name: durableName,
    ack_policy: AckPolicy.Explicit,
    max_deliver: maxDeliverForDurable(durableName),
    ...extra,
  };
}

export function eventsStreamConfig(): Partial<StreamConfig> & { name: string } {
  return {
    name: STREAM_EVENTS,
    subjects: [
      "events.chatbot.>",
      "events.file.>",
      "events.gateway.>",
      "events.analytics.>",
      "events.messenger.>",
    ],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: jetstreamEventsMaxAgeNs(),
    max_bytes: ONE_GIB,
  };
}

export function dlqStreamConfig(): Partial<StreamConfig> & { name: string } {
  return {
    name: STREAM_DLQ,
    subjects: ["events.dlq.>"],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: jetstreamDlqMaxAgeNs(),
    max_bytes: ONE_GIB,
  };
}

export function fileConversationCleanupConsumer(): Partial<ConsumerConfig> {
  return pullConsumer(CONSUMER_FILE_CONVERSATION_CLEANUP, {
    filter_subject: SUBJECT_CONVERSATION_DELETED,
  });
}

export function eventStoreIngestConsumer(): Partial<ConsumerConfig> {
  return pullConsumer(CONSUMER_EVENT_STORE_INGEST);
}

export function eventStoreDlqIngestConsumer(): Partial<ConsumerConfig> {
  return pullConsumer(CONSUMER_EVENT_STORE_DLQ_INGEST);
}

/** No filter_subject — notification mapping is service-side config; unmapped events are ignored there. */
export function notificationEventsConsumer(): Partial<ConsumerConfig> {
  return pullConsumer(CONSUMER_NOTIFICATION_EVENTS);
}

export function notificationDlqConsumer(): Partial<ConsumerConfig> {
  return pullConsumer(CONSUMER_NOTIFICATION_DLQ);
}

/**
 * messenger-service projects call history from realtime-service's call events.
 *
 * Filtered, unlike the notification consumer: this durable exists to build one
 * table, so anything outside `events.messenger.call.>` would be pulled and
 * acked for nothing. The EVENTS stream already carried `events.messenger.>`
 * before phase 2, so **only this consumer is new — the stream is unchanged**.
 */
export function messengerCallsConsumer(): Partial<ConsumerConfig> {
  return pullConsumer(CONSUMER_MESSENGER_CALLS, {
    filter_subject: SUBJECT_MESSENGER_CALLS,
  });
}
