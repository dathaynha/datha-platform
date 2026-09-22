import fp from "fastify-plugin";
import { connect } from "@nats-io/transport-node";
import { jetstream, type JetStreamClient } from "@nats-io/jetstream";

type NatsConnection = Awaited<ReturnType<typeof connect>>;
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { startEventsConsumer } from "../nats/consumer";
import { startDlqConsumer } from "../nats/dlq-consumer";

declare module "fastify" {
  interface FastifyInstance {
    nats: NatsConnection;
    js: JetStreamClient;
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    // Reconnect forever — default ~10 attempts leaves a zombie service after
    // any broker outage longer than ~20 s (consumers never resume).
    const nc = await connect({
      servers: config.NATS_URL,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
    });
    const js = jetstream(nc);
    fastify.log.info(
      "NATS JetStream connected (projection consumers; topology via platform-nats reconcile)",
    );

    fastify.decorate("nats", nc);
    fastify.decorate("js", js);

    const eventsConsumer = startEventsConsumer(fastify);
    const dlqConsumer = startDlqConsumer(fastify);

    fastify.addHook("onClose", async () => {
      const eventsDone = eventsConsumer.stop();
      const dlqDone = dlqConsumer.stop();
      await nc.drain();
      await Promise.all([eventsDone, dlqDone]);
    });
  },
  { name: "nats", dependencies: ["db", "metrics"] },
);
