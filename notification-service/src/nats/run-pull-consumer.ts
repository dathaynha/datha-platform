import type { JetStreamClient, JsMsg } from "@nats-io/jetstream";
import type { FastifyInstance } from "fastify";
import { fetchOptions } from "./streams";
import { getConsumerWithRetry } from "./get-consumer-with-retry";

export type PullConsumerRunner = {
  stop: () => Promise<void>;
};

type RunPullConsumerOptions = {
  fastify: FastifyInstance;
  js: JetStreamClient;
  stream: string;
  consumerName: string;
  startedLog: string;
  fetchErrorLog: string;
  crashLog: string;
  handleMessage: (fastify: FastifyInstance, msg: JsMsg) => Promise<void>;
};

/** Background JetStream pull loop with graceful shutdown (await `stop()` before closing DB). */
export function runPullConsumer(
  options: RunPullConsumerOptions,
): PullConsumerRunner {
  const {
    fastify,
    js,
    stream,
    consumerName,
    startedLog,
    fetchErrorLog,
    crashLog,
    handleMessage,
  } = options;

  let stopped = false;

  const run = async () => {
    const consumer = await getConsumerWithRetry(
      js,
      stream,
      consumerName,
      fastify.log,
      () => stopped,
    );
    fastify.log.info(startedLog);

    while (!stopped) {
      try {
        const batch = await consumer.fetch(fetchOptions);
        for await (const msg of batch) {
          if (stopped) {
            msg.nak();
            break;
          }
          await handleMessage(fastify, msg);
        }
      } catch (err) {
        if (stopped) break;
        fastify.log.error({ err }, fetchErrorLog);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };

  const runPromise = run().catch((err) => fastify.log.error({ err }, crashLog));

  return {
    /** Signal stop and return the loop promise (await after draining NATS to unblock idle fetch). */
    stop: () => {
      stopped = true;
      return runPromise;
    },
  };
}
