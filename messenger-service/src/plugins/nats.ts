import fp from "fastify-plugin";
import { connect } from "@nats-io/transport-node";
import { jetstream, type JetStreamClient } from "@nats-io/jetstream";

type NatsConnection = Awaited<ReturnType<typeof connect>>;
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { startCallsConsumer } from "../nats/calls-consumer";

declare module "fastify" {
  interface FastifyInstance {
    nats: NatsConnection;
    js: JetStreamClient;
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    // Reconnect forever — the default ~10 attempts leaves a zombie service
    // after any broker outage longer than ~20 s.
    const nc = await connect({
      servers: config.NATS_URL,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
    });
    const js = jetstream(nc);
    fastify.log.info(
      "NATS connected (publish + call-history consumer; topology via platform-nats reconcile)",
    );

    fastify.decorate("nats", nc);
    fastify.decorate("js", js);

    const callsConsumer = startCallsConsumer(fastify);

    fastify.addHook("onClose", async () => {
      // Signal first, then drain, then await: an idle fetch only unblocks once
      // the connection drains, and the loop must finish before the pool closes.
      const callsDone = callsConsumer.stop();
      await nc.drain();
      await callsDone;
    });
  },
  { name: "nats", dependencies: ["db", "metrics"] },
);
