import type { FastifyInstance } from "fastify";
import type { JsMsg } from "@nats-io/jetstream";
import type { DlqMessageBody } from "../types/dlq";
import { insertNotification } from "../services/projection";
import { config } from "../config";
import { CONSUMER_DLQ, STREAM_DLQ } from "./streams";
import { runPullConsumer, type PullConsumerRunner } from "./run-pull-consumer";

function parseDlqBody(data: Uint8Array): DlqMessageBody {
  const raw = JSON.parse(new TextDecoder().decode(data)) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("DLQ body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.original_subject !== "string" || !b.original_subject) {
    throw new Error("DLQ body original_subject is required");
  }
  if (typeof b.last_error !== "string") {
    throw new Error("DLQ body last_error is required");
  }
  return b as unknown as DlqMessageBody;
}

async function handleDlqMessage(
  fastify: FastifyInstance,
  msg: JsMsg,
): Promise<void> {
  const log = fastify.log;
  const consumed = fastify.metrics.eventsConsumed;
  const streamSequence = msg.info?.streamSequence;
  if (streamSequence == null) {
    log.error(
      { subject: msg.subject },
      "DLQ message missing stream sequence; terminating",
    );
    consumed.inc({ stream: STREAM_DLQ, outcome: "invalid" });
    msg.term();
    return;
  }

  let body: DlqMessageBody;
  try {
    body = parseDlqBody(msg.data);
  } catch (err) {
    log.error(
      { err, subject: msg.subject },
      "invalid DLQ message; terminating",
    );
    consumed.inc({ stream: STREAM_DLQ, outcome: "invalid" });
    msg.term();
    return;
  }

  // Skip our own projection-failure sink — notifying about a failed notification would loop.
  if (
    !body.owner_id ||
    msg.subject === "events.dlq.notification_service.projection"
  ) {
    consumed.inc({ stream: STREAM_DLQ, outcome: "ignored" });
    msg.ack();
    return;
  }

  try {
    const inserted = await insertNotification(fastify.db, {
      sourceKey: `dlq:${streamSequence}`,
      ownerId: body.owner_id,
      type: "dlq.arrival",
      severity: "warning",
      sourceService: "platform",
      titleKey: "NOTIFICATIONS.DLQ_ARRIVAL.TITLE",
      bodyKey: "NOTIFICATIONS.DLQ_ARRIVAL.BODY",
      params: {
        original_subject: body.original_subject,
        last_error: body.last_error,
      },
      link: "/event-store/dlq",
      correlationId: body.correlation_id,
    });
    if (inserted) {
      fastify.notificationStream.publish(body.owner_id, inserted);
      fastify.sendPush(body.owner_id, inserted);
    }
    consumed.inc({ stream: STREAM_DLQ, outcome: "projected" });
    msg.ack();
  } catch (err) {
    const deliveryCount = msg.info?.deliveryCount ?? 1;
    log.error(
      { err, deliveryCount, subject: msg.subject, streamSequence },
      "DLQ notification projection failed",
    );
    // Never DLQ-publish from the DLQ consumer (loop risk) — drop after max deliveries.
    if (
      deliveryCount >=
      config.NATS_CONSUMER_MAX_DELIVER_NOTIFICATION_SERVICE_EVENTS
    ) {
      consumed.inc({ stream: STREAM_DLQ, outcome: "dropped" });
      msg.ack();
      return;
    }
    msg.nak();
  }
}

export { handleDlqMessage };

/** Pull consumer on DLQ stream — surfaces dead-lettered work as ops notifications. */
export function startDlqConsumer(fastify: FastifyInstance): PullConsumerRunner {
  return runPullConsumer({
    fastify,
    js: fastify.js,
    stream: STREAM_DLQ,
    consumerName: CONSUMER_DLQ,
    startedLog: "notification-service JetStream DLQ consumer started",
    fetchErrorLog: "notification-service DLQ fetch error",
    crashLog: "notification-service DLQ consumer crashed",
    handleMessage: handleDlqMessage,
  });
}
