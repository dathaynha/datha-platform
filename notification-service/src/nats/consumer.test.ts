import type { FastifyInstance } from "fastify";
import type { JetStreamClient, JsMsg } from "@nats-io/jetstream";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dlqPublish from "../services/dlq-publish";
import * as projectionModule from "../services/projection";
import { handleMessage } from "./consumer";

vi.mock("../services/projection");
vi.mock("../services/dlq-publish");

const insertNotification = vi.mocked(projectionModule.insertNotification);
const publishDlq = vi.mocked(dlqPublish.publishDlq);

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function envelopeBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id: EVENT_ID,
      type: "file.deleted",
      service: "file-service",
      entity_id: "22222222-2222-4222-8222-222222222222",
      owner_id: "google_owner",
      correlation_id: "corr-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: {
        file_id: "22222222-2222-4222-8222-222222222222",
        mime_type: "image/png",
      },
      ...overrides,
    }),
  );
}

function mockFastify(): FastifyInstance {
  return {
    db: {} as Pool,
    js: { publish: vi.fn() } as unknown as JetStreamClient,
    log: { error: vi.fn(), info: vi.fn() },
    metrics: { eventsConsumed: { inc: vi.fn() } },
    notificationStream: { subscribe: vi.fn(), publish: vi.fn() },
    sendPush: vi.fn(),
  } as unknown as FastifyInstance;
}

function mockMsg(data: Uint8Array, deliveryCount = 1): JsMsg {
  return {
    data,
    subject: "events.file.file.deleted",
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
    info: { deliveryCount },
  } as unknown as JsMsg;
}

describe("handleMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertNotification.mockResolvedValue(null);
    publishDlq.mockResolvedValue(undefined);
  });

  it("terms invalid envelopes (no DLQ, no retry)", async () => {
    const msg = mockMsg(new TextEncoder().encode("not-json"));
    await handleMessage(mockFastify(), msg);
    expect(msg.term).toHaveBeenCalled();
    expect(insertNotification).not.toHaveBeenCalled();
  });

  it("acks unmapped event types without inserting", async () => {
    const msg = mockMsg(envelopeBytes({ type: "message.sent" }));
    await handleMessage(mockFastify(), msg);
    expect(msg.ack).toHaveBeenCalled();
    expect(insertNotification).not.toHaveBeenCalled();
  });

  it("acks mapped events without owner_id without inserting", async () => {
    const msg = mockMsg(envelopeBytes({ owner_id: null }));
    await handleMessage(mockFastify(), msg);
    expect(msg.ack).toHaveBeenCalled();
    expect(insertNotification).not.toHaveBeenCalled();
  });

  it("inserts a notification and acks for mapped events", async () => {
    const msg = mockMsg(envelopeBytes());
    await handleMessage(mockFastify(), msg);
    expect(insertNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKey: EVENT_ID,
        ownerId: "google_owner",
        type: "file.cleanup",
        titleKey: "NOTIFICATIONS.FILE_CLEANUP.TITLE",
        correlationId: "corr-1",
      }),
    );
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.nak).not.toHaveBeenCalled();
  });

  it("broadcasts the inserted notification to the owner over SSE", async () => {
    const dto = { id: "n1", type: "file.cleanup" } as unknown as Awaited<
      ReturnType<typeof projectionModule.insertNotification>
    >;
    insertNotification.mockResolvedValue(dto);
    const fastify = mockFastify();
    await handleMessage(fastify, mockMsg(envelopeBytes()));
    expect(fastify.notificationStream.publish).toHaveBeenCalledWith(
      "google_owner",
      dto,
    );
  });

  it("does not broadcast when the insert conflicts (redelivery)", async () => {
    insertNotification.mockResolvedValue(null);
    const fastify = mockFastify();
    await handleMessage(fastify, mockMsg(envelopeBytes()));
    expect(fastify.notificationStream.publish).not.toHaveBeenCalled();
  });

  it("naks when the insert fails before max_deliver", async () => {
    insertNotification.mockRejectedValue(new Error("db down"));
    const msg = mockMsg(envelopeBytes(), 1);
    await handleMessage(mockFastify(), msg);
    expect(msg.nak).toHaveBeenCalled();
    expect(publishDlq).not.toHaveBeenCalled();
  });

  it("publishes DLQ and acks on final delivery attempt", async () => {
    insertNotification.mockRejectedValue(new Error("db down"));
    const msg = mockMsg(envelopeBytes(), 3);
    await handleMessage(mockFastify(), msg);
    expect(publishDlq).toHaveBeenCalledWith(
      expect.anything(),
      "notification_service.projection",
      expect.objectContaining({
        last_error: "db down",
        original_subject: msg.subject,
      }),
    );
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.nak).not.toHaveBeenCalled();
  });
});
