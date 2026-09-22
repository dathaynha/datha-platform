import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";

export interface StreamSubscriber {
  send: (data: string) => void;
  end: () => void;
}

declare module "fastify" {
  interface FastifyInstance {
    notificationStream: {
      /** Register an SSE connection for an owner. Returns an idempotent unsubscribe. */
      subscribe(ownerId: string, subscriber: StreamSubscriber): () => void;
      publish(ownerId: string, payload: unknown): void;
    };
  }
}

/**
 * In-memory per-owner SSE fanout — consumers publish inserted notifications,
 * the /notifications/stream route subscribes browser connections.
 * Single-instance assumption: multi-instance deploys need a NATS core
 * pub/sub fanout instead (platform/platform-notifications.md).
 */
export default fp(
  async (fastify: FastifyInstance) => {
    const subscribers = new Map<string, Set<StreamSubscriber>>();

    fastify.decorate("notificationStream", {
      subscribe(ownerId: string, subscriber: StreamSubscriber) {
        let set = subscribers.get(ownerId);
        if (!set) {
          set = new Set();
          subscribers.set(ownerId, set);
        }
        set.add(subscriber);
        fastify.metrics.sseConnections.inc();
        return () => {
          if (!set.delete(subscriber)) return;
          if (set.size === 0) subscribers.delete(ownerId);
          fastify.metrics.sseConnections.dec();
        };
      },
      publish(ownerId: string, payload: unknown) {
        const set = subscribers.get(ownerId);
        if (!set) return;
        const data = JSON.stringify(payload);
        for (const subscriber of set) subscriber.send(data);
      },
    });

    // Open SSE sockets would keep fastify.close() waiting forever.
    fastify.addHook("onClose", async () => {
      for (const set of subscribers.values()) {
        for (const subscriber of set) subscriber.end();
      }
    });
  },
  { name: "notification-stream", dependencies: ["metrics"] },
);
