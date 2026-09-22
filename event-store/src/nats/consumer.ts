import type { FastifyInstance } from "fastify";
import type { JsMsg } from "@nats-io/jetstream";
import type { PlatformEvent } from "../types/events";
import { ingestEvent, parseEnvelope } from "../services/ingest";
import { publishDlq } from "../services/dlq-publish";
import { config } from "../config";
import {
  CONSUMER_INGEST,
  DLQ_SINK_EVENT_STORE_INGEST,
  STREAM_EVENTS,
} from "./streams";
import { runPullConsumer, type PullConsumerRunner } from "./run-pull-consumer";

async function handleMessage(
  fastify: FastifyInstance,
  msg: JsMsg,
): Promise<void> {
  const log = fastify.log;
  const js = fastify.js;
  let envelope: PlatformEvent;
  try {
    envelope = parseEnvelope(msg.data);
  } catch (err) {
    log.error(
      { err, subject: msg.subject },
      "invalid EVENTS message; terminating",
    );
    msg.term();
    return;
  }

  try {
    await ingestEvent(fastify.db, envelope);
    msg.ack();
  } catch (err) {
    const deliveryCount = msg.info?.deliveryCount ?? 1;
    const lastError = err instanceof Error ? err.message : String(err);
    log.error(
      { err, deliveryCount, subject: msg.subject, eventId: envelope.id },
      "event ingest failed",
    );

    if (deliveryCount >= config.NATS_CONSUMER_MAX_DELIVER_EVENT_STORE_INGEST) {
      await publishDlq(js, DLQ_SINK_EVENT_STORE_INGEST, {
        original_subject: msg.subject,
        correlation_id: envelope.correlation_id,
        owner_id: envelope.owner_id,
        payload: envelope.payload,
        last_error: lastError,
        envelope,
      });
      msg.ack();
      return;
    }
    msg.nak();
  }
}

/** Pull consumer on EVENTS only — never ingests DLQ stream. */
export { handleMessage };

export function startIngestConsumer(
  fastify: FastifyInstance,
): PullConsumerRunner {
  return runPullConsumer({
    fastify,
    js: fastify.js,
    stream: STREAM_EVENTS,
    consumerName: CONSUMER_INGEST,
    startedLog: "event-store JetStream ingest consumer started",
    fetchErrorLog: "event-store ingest fetch error",
    crashLog: "event-store ingest consumer crashed",
    handleMessage,
  });
}
