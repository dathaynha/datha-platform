import type { FastifyInstance } from "fastify";
import type { JsMsg } from "@nats-io/jetstream";
import type { PlatformEvent } from "../types/events";
import { parseEnvelope } from "../services/envelope";
import { mapEvent } from "../services/mapping";
import { insertNotification } from "../services/projection";
import { publishDlq } from "../services/dlq-publish";
import { config } from "../config";
import { CONSUMER_EVENTS, DLQ_SINK_PROJECTION, STREAM_EVENTS } from "./streams";
import { runPullConsumer, type PullConsumerRunner } from "./run-pull-consumer";

async function handleMessage(
  fastify: FastifyInstance,
  msg: JsMsg,
): Promise<void> {
  const log = fastify.log;
  const consumed = fastify.metrics.eventsConsumed;
  let envelope: PlatformEvent;
  try {
    envelope = parseEnvelope(msg.data);
  } catch (err) {
    log.error(
      { err, subject: msg.subject },
      "invalid EVENTS message; terminating",
    );
    consumed.inc({ stream: STREAM_EVENTS, outcome: "invalid" });
    msg.term();
    return;
  }

  const draft = mapEvent(envelope);
  if (!draft || !envelope.owner_id) {
    consumed.inc({ stream: STREAM_EVENTS, outcome: "ignored" });
    msg.ack();
    return;
  }

  try {
    const inserted = await insertNotification(fastify.db, {
      sourceKey: envelope.id,
      ownerId: envelope.owner_id,
      type: draft.type,
      severity: draft.severity,
      sourceService: envelope.service,
      titleKey: draft.titleKey,
      bodyKey: draft.bodyKey,
      params: draft.params,
      correlationId: envelope.correlation_id,
    });
    // Conflict (redelivery) inserts nothing — never re-push over SSE or Web Push.
    if (inserted) {
      fastify.notificationStream.publish(envelope.owner_id, inserted);
      fastify.sendPush(envelope.owner_id, inserted);
    }
    consumed.inc({ stream: STREAM_EVENTS, outcome: "projected" });
    msg.ack();
  } catch (err) {
    const deliveryCount = msg.info?.deliveryCount ?? 1;
    const lastError = err instanceof Error ? err.message : String(err);
    log.error(
      { err, deliveryCount, subject: msg.subject, eventId: envelope.id },
      "notification projection failed",
    );

    if (
      deliveryCount >=
      config.NATS_CONSUMER_MAX_DELIVER_NOTIFICATION_SERVICE_EVENTS
    ) {
      await publishDlq(fastify.js, DLQ_SINK_PROJECTION, {
        original_subject: msg.subject,
        correlation_id: envelope.correlation_id,
        owner_id: envelope.owner_id,
        payload: envelope.payload,
        last_error: lastError,
        envelope,
      });
      consumed.inc({ stream: STREAM_EVENTS, outcome: "dlq" });
      msg.ack();
      return;
    }
    msg.nak();
  }
}

export { handleMessage };

/** Pull consumer on EVENTS only — DLQ arrivals have their own consumer (dlq-consumer.ts). */
export function startEventsConsumer(
  fastify: FastifyInstance,
): PullConsumerRunner {
  return runPullConsumer({
    fastify,
    js: fastify.js,
    stream: STREAM_EVENTS,
    consumerName: CONSUMER_EVENTS,
    startedLog: "notification-service JetStream events consumer started",
    fetchErrorLog: "notification-service events fetch error",
    crashLog: "notification-service events consumer crashed",
    handleMessage,
  });
}
