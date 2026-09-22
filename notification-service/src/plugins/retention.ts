import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { config } from "../config";
import { purgeReadNotifications } from "../services/retention";

const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** In-app retention sweep — read notifications older than the retention window are deleted. */
export default fp(
  async (fastify: FastifyInstance) => {
    const sweep = async () => {
      try {
        const deleted = await purgeReadNotifications(
          fastify.db,
          config.NOTIFICATIONS_READ_RETENTION_DAYS,
        );
        if (deleted > 0) {
          fastify.log.info({ deleted }, "notification retention sweep");
        }
      } catch (err) {
        fastify.log.error({ err }, "notification retention sweep failed");
      }
    };

    void sweep();
    const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
    timer.unref();

    fastify.addHook("onClose", async () => {
      clearInterval(timer);
    });
  },
  { name: "retention", dependencies: ["db"] },
);
