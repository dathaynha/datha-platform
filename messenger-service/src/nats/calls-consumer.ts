import type { FastifyInstance } from "fastify";
import type { JsMsg } from "@nats-io/jetstream";
import { config } from "../config";
import { parseEnvelope } from "../services/envelope";
import { publishDlq } from "../services/dlq-publish";
import {
  FK_VIOLATION,
  asEndReason,
  asMedia,
  projectCall,
  type CallProjection,
} from "../services/calls";
import type { PlatformEvent } from "../types/events";
import {
  CONSUMER_CALLS,
  DLQ_SINK_CALLS,
  EVENT_CALL_ENDED,
  EVENT_CALL_MISSED,
  EVENT_CALL_STARTED,
  STREAM_EVENTS,
} from "./streams";
import { runPullConsumer, type PullConsumerRunner } from "./run-pull-consumer";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Owner ids from a payload array, ignoring anything that is not a string. */
function ownerIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

/**
 * Reads a call envelope into a projection row, or null when it is not usable.
 *
 * Returning null rather than throwing is deliberate: a malformed or foreign
 * event is the producer's problem and must never be retried three times and
 * then dumped in the DLQ — only a *failed write* deserves that.
 */
export function toProjection(envelope: PlatformEvent): CallProjection | null {
  if (
    envelope.type !== EVENT_CALL_STARTED &&
    envelope.type !== EVENT_CALL_ENDED &&
    envelope.type !== EVENT_CALL_MISSED
  ) {
    return null;
  }

  const payload = envelope.payload;
  const callId = typeof payload.call_id === "string" ? payload.call_id : null;
  const conversationId =
    typeof payload.conversation_id === "string"
      ? payload.conversation_id
      : null;
  const callerOwnerId =
    typeof payload.caller_id === "string" ? payload.caller_id : null;
  const calleeOwnerId =
    typeof payload.callee_id === "string" ? payload.callee_id : null;
  const startedAt = isoOrNull(payload.started_at);
  const participantOwnerIds = ownerIds(payload.participant_ids);
  const joinedOwnerIds = ownerIds(payload.joined_ids);

  // Both ids are database keys, so a non-uuid would fail the insert rather
  // than the parse — check here and ignore instead.
  if (
    !callId ||
    !UUID_RE.test(callId) ||
    !conversationId ||
    !UUID_RE.test(conversationId) ||
    !callerOwnerId ||
    !startedAt
  ) {
    return null;
  }

  // A 1:1 call names its callee; a group call has none and describes itself
  // with its participants instead. An event with neither is not a call this
  // projection understands — before phase 3 that was every group event, which
  // is why they were ignored rather than projected.
  if (!calleeOwnerId && participantOwnerIds.length === 0) {
    return null;
  }

  const ended =
    envelope.type === EVENT_CALL_ENDED || envelope.type === EVENT_CALL_MISSED;
  const duration =
    typeof payload.duration_seconds === "number" &&
    Number.isFinite(payload.duration_seconds) &&
    payload.duration_seconds > 0
      ? Math.floor(payload.duration_seconds)
      : 0;

  return {
    callId,
    conversationId,
    callerOwnerId,
    calleeOwnerId,
    participantOwnerIds,
    joinedOwnerIds,
    media: asMedia(payload.media),
    startedAt,
    answeredAt: isoOrNull(payload.answered_at),
    // The event's own timestamp is when the call ended; the payload carries no
    // ended_at, because the publisher stamps the envelope at that moment.
    endedAt: ended ? envelope.timestamp : null,
    endReason: ended
      ? (asEndReason(payload.reason) ??
        (envelope.type === EVENT_CALL_MISSED ? "missed" : "hangup"))
      : null,
    durationSeconds: duration,
  };
}

async function handleMessage(
  fastify: FastifyInstance,
  msg: JsMsg,
): Promise<void> {
  const log = fastify.log;
  const projected = fastify.metrics.callsProjected;

  let envelope: PlatformEvent;
  try {
    envelope = parseEnvelope(msg.data);
  } catch (err) {
    log.error({ err, subject: msg.subject }, "invalid call event; terminating");
    projected.inc({ outcome: "invalid" });
    msg.term();
    return;
  }

  const input = toProjection(envelope);
  if (!input) {
    projected.inc({ outcome: "ignored" });
    msg.ack();
    return;
  }

  try {
    await projectCall(fastify.db, input);
    projected.inc({ outcome: "projected" });
    msg.ack();
  } catch (err) {
    // The conversation is gone (deleted between the call and this event), so
    // its calls cascaded away with it. Retrying cannot succeed.
    if ((err as { code?: string }).code === FK_VIOLATION) {
      log.warn(
        { callId: input.callId, conversationId: input.conversationId },
        "call event for a deleted conversation; dropping",
      );
      projected.inc({ outcome: "orphaned" });
      msg.term();
      return;
    }

    const deliveryCount = msg.info?.deliveryCount ?? 1;
    const lastError = err instanceof Error ? err.message : String(err);
    log.error(
      { err, deliveryCount, subject: msg.subject, eventId: envelope.id },
      "call history projection failed",
    );

    if (
      deliveryCount >= config.NATS_CONSUMER_MAX_DELIVER_MESSENGER_SERVICE_CALLS
    ) {
      await publishDlq(fastify.js, DLQ_SINK_CALLS, {
        original_subject: msg.subject,
        correlation_id: envelope.correlation_id,
        owner_id: envelope.owner_id,
        payload: envelope.payload,
        last_error: lastError,
        envelope,
      });
      projected.inc({ outcome: "dlq" });
      msg.ack();
      return;
    }
    msg.nak();
  }
}

export { handleMessage };

/**
 * This service's only JetStream consumer. Everything else it does with NATS is
 * publishing — the topology, including this durable, belongs to platform-nats.
 */
export function startCallsConsumer(
  fastify: FastifyInstance,
): PullConsumerRunner {
  return runPullConsumer({
    fastify,
    js: fastify.js,
    stream: STREAM_EVENTS,
    consumerName: CONSUMER_CALLS,
    startedLog: "messenger-service call-history consumer started",
    fetchErrorLog: "messenger-service calls fetch error",
    crashLog: "messenger-service calls consumer crashed",
    handleMessage,
  });
}
