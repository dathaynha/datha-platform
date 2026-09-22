import type { JetStreamClient } from "@nats-io/jetstream";
import type { FastifyBaseLogger } from "fastify";

/** Retry until platform-nats reconcile creates the durable or the app shuts down. */
export async function getConsumerWithRetry(
  js: JetStreamClient,
  stream: string,
  consumerName: string,
  log: FastifyBaseLogger,
  isStopped: () => boolean,
) {
  while (!isStopped()) {
    try {
      return await js.consumers.get(stream, consumerName);
    } catch (err) {
      if (isStopped()) throw err;
      log.warn(
        { err, stream, consumer: consumerName },
        "JetStream consumer not ready; retrying",
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("consumer startup aborted");
}
