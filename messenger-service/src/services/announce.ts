import type { FastifyInstance } from "fastify";
import type { RealtimeFrame } from "../types/events";
import {
  publishEvent,
  publishOwnerFrames,
  type PublishEventInput,
} from "./publish";

/**
 * Both publishes happen after the transaction has committed, so neither may
 * fail the request: the write the caller asked for is already durable, and a
 * 500 here would report a lost message that in fact exists. What a failure must
 * do instead is be loud — an error log plus a counter, so a broken bus shows up
 * in Grafana rather than in a user's missing history.
 */

/** Core-NATS fanout of one live frame, per owner. */
export function announce(
  fastify: FastifyInstance,
  ownerIds: readonly string[],
  frame: RealtimeFrame,
): void {
  const result = publishOwnerFrames(fastify.nats, ownerIds, frame);
  if (result.published) {
    fastify.metrics.fanoutPublish.inc({ outcome: "ok" }, result.published);
  }
  if (result.failed) {
    fastify.metrics.fanoutPublish.inc({ outcome: "error" }, result.failed);
    fastify.log.error(
      { frame: frame.t, failed: result.failed },
      "core NATS fanout failed for some owners",
    );
  }
}

/** JetStream publish of the record. */
export async function recordEvent(
  fastify: FastifyInstance,
  input: PublishEventInput,
): Promise<void> {
  try {
    await publishEvent(fastify.js, input);
    fastify.metrics.eventPublish.inc({ outcome: "ok" });
  } catch (err) {
    fastify.metrics.eventPublish.inc({ outcome: "error" });
    fastify.log.error(
      { err, type: input.type, entity_id: input.entityId },
      "JetStream publish failed after commit — the row exists, the event does not",
    );
  }
}
