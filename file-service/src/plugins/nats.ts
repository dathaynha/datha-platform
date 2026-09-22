import fp from "fastify-plugin";
import { connect } from "@nats-io/transport-node";
import { jetstream, type JetStreamClient } from "@nats-io/jetstream";

type NatsConnection = Awaited<ReturnType<typeof connect>>;
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { startConversationCleanupConsumer } from "../services/conversation-cleanup.consumer";

declare module "fastify" {
  interface FastifyInstance {
    /** null when NATS is down — HTTP upload/download/delete still work. */
    nats: NatsConnection | null;
    js: JetStreamClient | null;
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    let nc: NatsConnection | null = null;
    let js: JetStreamClient | null = null;

    try {
      // Reconnect forever — default ~10 attempts leaves a zombie service after
      // any broker outage longer than ~20 s (cleanup consumer never resumes).
      nc = await connect({
        servers: config.NATS_URL,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
      });
      js = jetstream(nc);
      fastify.log.info(
        "NATS JetStream connected (publish + conversation cleanup consumer; topology via platform-nats reconcile)",
      );
    } catch (err) {
      fastify.log.warn(
        { err },
        "NATS unavailable; file HTTP API continues without event publish or conversation-delete consumer",
      );
    }

    fastify.decorate("nats", nc);
    fastify.decorate("js", js);

    if (js) {
      startConversationCleanupConsumer(fastify);
    }

    fastify.addHook("onClose", async () => {
      if (nc) {
        await nc.drain();
      }
    });
  },
  { name: "nats", dependencies: ["db", "blob"] },
);
