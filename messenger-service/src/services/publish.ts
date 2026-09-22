import { randomUUID } from "node:crypto";
import { encodeJsonPayload } from "../nats/encode-payload";
import { eventSubject, ownerFanoutSubject } from "../nats/streams";
import type { PlatformEvent, RealtimeFrame } from "../types/events";

export const SERVICE_NAME = "messenger-service";

/** The JetStream half of `@nats-io/jetstream`, narrowed to what is used here. */
export interface JetStreamPublisher {
  publish(subject: string, data: Uint8Array): Promise<unknown>;
}

/** The core-NATS half of a connection: fire-and-forget, no ack. */
export interface CorePublisher {
  publish(subject: string, data: Uint8Array): void;
}

export interface PublishEventInput {
  type: string;
  entityId: string | null;
  ownerId: string | null;
  correlationId: string | null;
  payload: Record<string, unknown>;
}

/**
 * Publishes the record to JetStream `EVENTS`. Called **after** the transaction
 * commits: publishing inside it can announce a write that later rolls back,
 * while publishing after means the worst case is a frame that arrives late,
 * which the client's resync already covers.
 */
export async function publishEvent(
  js: JetStreamPublisher,
  input: PublishEventInput,
): Promise<PlatformEvent> {
  const envelope: PlatformEvent = {
    id: randomUUID(),
    type: input.type,
    service: SERVICE_NAME,
    entity_id: input.entityId,
    owner_id: input.ownerId,
    correlation_id: input.correlationId,
    timestamp: new Date().toISOString(),
    payload: input.payload,
  };
  await js.publish(eventSubject(input.type), encodeJsonPayload(envelope));
  return envelope;
}

export interface FanoutResult {
  published: number;
  failed: number;
}

/**
 * Pushes one live frame per owner onto core NATS. Core is deliberate: these
 * frames are transport, not the record, so a dropped one self-heals on the
 * client's next resync. A durable consumer here would redeliver stale chat
 * frames on every socket reconnect.
 */
export function publishOwnerFrames(
  nc: CorePublisher,
  ownerIds: readonly string[],
  frame: RealtimeFrame,
): FanoutResult {
  const data = encodeJsonPayload(frame);
  let published = 0;
  let failed = 0;
  for (const ownerId of ownerIds) {
    try {
      nc.publish(ownerFanoutSubject(ownerId), data);
      published += 1;
    } catch {
      // The write is already durable; a lost live frame is not worth failing
      // the request over. The counter is what surfaces a broken fanout.
      failed += 1;
    }
  }
  return { published, failed };
}
