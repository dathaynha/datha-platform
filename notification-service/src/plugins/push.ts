import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import type { NotificationDto } from "../services/query";
import { sendPush, vapidConfigured } from "../services/push-sender";

declare module "fastify" {
  interface FastifyInstance {
    /** Fire-and-forget Web Push fanout — never blocks the caller. */
    sendPush: (ownerId: string, notification: NotificationDto) => void;
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    if (!vapidConfigured()) {
      fastify.log.warn("VAPID keys unset — web push sending disabled");
    }

    fastify.decorate(
      "sendPush",
      (ownerId: string, notification: NotificationDto) => {
        void sendPush(
          {
            db: fastify.db,
            log: fastify.log,
            pushSent: fastify.metrics.pushSent,
          },
          ownerId,
          notification,
        );
      },
    );
  },
  { name: "push", dependencies: ["metrics"] },
);
