import type { FastifyInstance } from "fastify";
import type { JsMsg } from "@nats-io/jetstream";
import { ingestDlqMessage, parseDlqBody } from "../services/dlq-ingest";
import { CONSUMER_DLQ_INGEST, STREAM_DLQ } from "./streams";
import { runPullConsumer, type PullConsumerRunner } from "./run-pull-consumer";

async function handleDlqMessage(
  fastify: FastifyInstance,
  msg: JsMsg,
): Promise<void> {
  const log = fastify.log;
  const streamSequence = msg.info?.streamSequence;
  if (streamSequence == null) {
    log.error(
      { subject: msg.subject },
      "DLQ message missing stream sequence; terminating",
    );
    msg.term();
    return;
  }

  try {
    const body = parseDlqBody(msg.data);
    await ingestDlqMessage(fastify.db, msg.subject, streamSequence, body);
    msg.ack();
  } catch (err) {
    log.error(
      { err, subject: msg.subject, streamSequence },
      "DLQ ingest failed",
    );
    if (
      err instanceof SyntaxError ||
      (err instanceof Error && err.message.startsWith("DLQ"))
    ) {
      msg.term();
      return;
    }
    msg.nak();
  }
}

/** Pull consumer on DLQ stream only — separate from business-event ingest. */
export function startDlqIngestConsumer(
  fastify: FastifyInstance,
): PullConsumerRunner {
  return runPullConsumer({
    fastify,
    js: fastify.js,
    stream: STREAM_DLQ,
    consumerName: CONSUMER_DLQ_INGEST,
    startedLog: "event-store JetStream DLQ ingest consumer started",
    fetchErrorLog: "event-store DLQ ingest fetch error",
    crashLog: "event-store DLQ ingest consumer crashed",
    handleMessage: handleDlqMessage,
  });
}
