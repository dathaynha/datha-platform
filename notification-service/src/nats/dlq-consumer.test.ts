import type { FastifyInstance } from "fastify";
import type { JsMsg } from "@nats-io/jetstream";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as projectionModule from "../services/projection";
import { handleDlqMessage } from "./dlq-consumer";

vi.mock("../services/projection");

const insertNotification = vi.mocked(projectionModule.insertNotification);

function dlqBodyBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      original_subject: "events.chatbot.conversation.deleted",
      correlation_id: "corr-1",
      owner_id: "google_owner",
      payload: {},
      last_error: "boom",
      failed_at: "2026-01-01T00:00:00.000Z",
      ...overrides,
    }),
  );
}

function mockFastify(): FastifyInstance {
  return {
    db: {} as Pool,
    log: { error: vi.fn(), info: vi.fn() },
    metrics: { eventsConsumed: { inc: vi.fn() } },
    notificationStream: { subscribe: vi.fn(), publish: vi.fn() },
    sendPush: vi.fn(),
  } as unknown as FastifyInstance;
}

function mockMsg(
  data: Uint8Array,
  { deliveryCount = 1, subject = "events.dlq.file.conversation_cleanup" } = {},
): JsMsg {
  return {
    data,
    subject,
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
    info: { deliveryCount, streamSequence: 42 },
  } as unknown as JsMsg;
}

describe("handleDlqMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertNotification.mockResolvedValue(null);
  });

  it("broadcasts the inserted dlq.arrival notification over SSE", async () => {
    const dto = { id: "n1", type: "dlq.arrival" } as unknown as Awaited<
      ReturnType<typeof projectionModule.insertNotification>
    >;
    insertNotification.mockResolvedValue(dto);
    const fastify = mockFastify();
    await handleDlqMessage(fastify, mockMsg(dlqBodyBytes()));
    expect(fastify.notificationStream.publish).toHaveBeenCalledWith(
      "google_owner",
      dto,
    );
  });

  it("does not broadcast when the insert conflicts (redelivery)", async () => {
    const fastify = mockFastify();
    await handleDlqMessage(fastify, mockMsg(dlqBodyBytes()));
    expect(fastify.notificationStream.publish).not.toHaveBeenCalled();
  });

  it("projects a dlq.arrival notification keyed by stream sequence", async () => {
    const msg = mockMsg(dlqBodyBytes());
    await handleDlqMessage(mockFastify(), msg);
    expect(insertNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKey: "dlq:42",
        ownerId: "google_owner",
        type: "dlq.arrival",
      }),
    );
    expect(msg.ack).toHaveBeenCalled();
  });

  it("ignores DLQ records without owner_id", async () => {
    const msg = mockMsg(dlqBodyBytes({ owner_id: null }));
    await handleDlqMessage(mockFastify(), msg);
    expect(insertNotification).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
  });

  it("ignores its own projection-failure sink (loop guard)", async () => {
    const msg = mockMsg(dlqBodyBytes(), {
      subject: "events.dlq.notification_service.projection",
    });
    await handleDlqMessage(mockFastify(), msg);
    expect(insertNotification).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
  });

  it("terms invalid bodies", async () => {
    const msg = mockMsg(new TextEncoder().encode("not-json"));
    await handleDlqMessage(mockFastify(), msg);
    expect(msg.term).toHaveBeenCalled();
  });

  it("naks before max_deliver, drops (ack) after", async () => {
    insertNotification.mockRejectedValue(new Error("db down"));
    const early = mockMsg(dlqBodyBytes(), { deliveryCount: 1 });
    await handleDlqMessage(mockFastify(), early);
    expect(early.nak).toHaveBeenCalled();

    const final = mockMsg(dlqBodyBytes(), { deliveryCount: 3 });
    await handleDlqMessage(mockFastify(), final);
    expect(final.ack).toHaveBeenCalled();
    expect(final.nak).not.toHaveBeenCalled();
  });
});
