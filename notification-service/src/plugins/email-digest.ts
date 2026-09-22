import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { smtpConfigured, sweepDigests } from "../services/email-digest";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Hourly email digest sweep (retention twin) — owners due a daily digest get
 * one email per pass. Cadence is enforced per-owner via digest_state, so the
 * hourly tick only controls send latency, not frequency.
 */
export default fp(
  async (fastify: FastifyInstance) => {
    if (!smtpConfigured()) {
      fastify.log.warn("SMTP_HOST unset — email digest sending disabled");
      return;
    }

    const sweep = () =>
      sweepDigests({
        db: fastify.db,
        log: fastify.log,
        emailsSent: fastify.metrics.emailsSent,
      });

    void sweep();
    const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
    timer.unref();

    fastify.addHook("onClose", async () => {
      clearInterval(timer);
    });
  },
  { name: "email-digest", dependencies: ["db", "metrics"] },
);
