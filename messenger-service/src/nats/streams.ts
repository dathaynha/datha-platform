/**
 * Subjects used at runtime. Topology (streams + durables) is reconciled by the
 * `platform-nats` repo (`pnpm reconcile`) — never create or update broker
 * config here (critical-behaviors #7).
 */

/**
 * Event types published by this service, in envelope `type` form. They land on
 * JetStream `EVENTS` (the stream itself is created by platform-nats).
 * `messenger.conversation.deleted` arrives with the delete endpoint and the
 * attachment cleanup choreography — it is not published yet.
 */
export const EVENT_CONVERSATION_CREATED = "messenger.conversation.created";
export const EVENT_MESSAGE_SENT = "messenger.message.sent";

/** The stream this service both publishes to and consumes from. */
export const STREAM_EVENTS = "EVENTS";

/**
 * Call-history projection durable. The name must match `topology.ts` in
 * `platform-nats` exactly; it is filtered there to `events.messenger.call.>`.
 */
export const CONSUMER_CALLS = "messenger-service-calls";

/** DLQ sink when the call projection exhausts max_deliver. */
export const DLQ_SINK_CALLS = "messenger_service.calls";

/**
 * Call events **published by realtime-service** and consumed here. Listed for
 * the projection's switch, not for publishing — this service never emits them.
 */
export const EVENT_CALL_STARTED = "messenger.call.started";
export const EVENT_CALL_ENDED = "messenger.call.ended";
export const EVENT_CALL_MISSED = "messenger.call.missed";

/** JetStream subject for an envelope type: events.<type>. */
export function eventSubject(type: string): string {
  return `events.${type}`;
}

/** JetStream subject for a DLQ sink: events.dlq.<sink>. */
export function dlqSubject(sink: string): string {
  return `events.dlq.${sink}`;
}

/**
 * Pull batch for the calls consumer. Calls are low volume compared with
 * messages, so a small batch keeps latency low without idle churn.
 */
export const fetchOptions = {
  max_messages: 25,
  expires: 30_000,
} as const;

/**
 * Core NATS subject carrying live frames for one owner. Fire-and-forget by
 * design: realtime-service instances subscribe per connected owner, so the
 * subscription set is the routing table and no sticky sessions are needed.
 */
export function ownerFanoutSubject(ownerId: string): string {
  return `rt.owner.${ownerId}`;
}
