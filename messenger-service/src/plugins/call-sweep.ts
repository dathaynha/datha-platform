import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { sweepStaleCalls } from "../services/calls";

/**
 * Closes calls that nobody ever told us had ended.
 *
 * `ended_at` is written only by projecting a `call.ended` event, and that event
 * is published by realtime-service — the process most likely to be the thing
 * that died. An instance killed or rolled mid-call took the only closer of its
 * calls with it, the Redis record expired in silence, and this row claimed a
 * call was in progress **forever**: the thread kept offering to join a call
 * that had been over for days (dathq, 2026-09-15).
 *
 * realtime-service now reaps calls whose instance has stopped heartbeating,
 * which handles that properly and promptly. This is the layer underneath: the
 * case where the *event* never arrives at all — NATS down, the consumer
 * stopped, the message dead-lettered — where no amount of care on the
 * publishing side helps. It depends on nothing but the clock, which is the
 * whole point of having it.
 */
export default fp(
  async (fastify: FastifyInstance) => {
    const sweep = async () => {
      try {
        const closed = await sweepStaleCalls(fastify.db);
        if (closed > 0) {
          // Worth a line at info: a non-zero sweep means events were lost, and
          // that is a fact about the system rather than about these rows.
          fastify.log.info(
            { closed, maxLifetimeSeconds: config.CALL_MAX_LIFETIME_SECONDS },
            "closed calls that never reported an ending",
          );
        }
      } catch (err) {
        // A failed sweep is not a failed service: every reader already applies
        // the same bound, so the rows are rendered correctly regardless.
        fastify.log.warn({ err }, "stale call sweep failed");
      }
    };

    void sweep();
    const timer = setInterval(sweep, config.CALL_SWEEP_INTERVAL_SECONDS * 1000);
    // Node keeps the process alive for a pending timer, which would hold a
    // shutdown open for a quarter of an hour.
    timer.unref();

    fastify.addHook("onClose", async () => {
      clearInterval(timer);
    });
  },
  { name: "call-sweep", dependencies: ["db"] },
);
