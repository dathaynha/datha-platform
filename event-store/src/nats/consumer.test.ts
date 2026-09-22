import type { FastifyInstance } from "fastify";
import type { JetStreamClient, JsMsg } from "@nats-io/jetstream";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dlqPublish from "../services/dlq-publish";
import * as ingestModule from "../services/ingest";
import { handleMessage } from "./consumer";

vi.mock("../services/ingest", async () => {
  const actual =
    await vi.importActual<typeof ingestModule>("../services/ingest");
  return { ...actual, ingestEvent: vi.fn() };
});
vi.mock("../services/dlq-publish");

const ingestEvent = vi.mocked(ingestModule.ingestEvent);
const publishDlq = vi.mocked(dlqPublish.publishDlq);

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function validEnvelopeBytes(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id: EVENT_ID,
      type: "chatbot.conversation.deleted",
      service: "chatbot-service",
      entity_id: "22222222-2222-4222-8222-222222222222",
      owner_id: "google_owner",
      correlation_id: "corr-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: {
        conversation_id: "22222222-2222-4222-8222-222222222222",
        file_ids: [],
      },
    }),
  );
}

function mockFastify(): FastifyInstance {
  return {
    db: {} as Pool,
    js: { publish: vi.fn() } as unknown as JetStreamClient,
    log: { error: vi.fn(), info: vi.fn() },
  } as unknown as FastifyInstance;
}

function mockMsg(data: Uint8Array, deliveryCount = 1): JsMsg {
  return {
    data,
    subject: "events.chatbot.conversation.deleted",
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
    info: { deliveryCount },
  } as unknown as JsMsg;
}

describe("handleMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ingestEvent.mockResolvedValue(undefined);
    publishDlq.mockResolvedValue(undefined);
  });

  it("terms invalid envelopes (no DLQ, no retry)", async () => {
    const msg = mockMsg(new TextEncoder().encode("not-json"));
    await handleMessage(mockFastify(), msg);
    expect(msg.term).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.nak).not.toHaveBeenCalled();
    expect(ingestEvent).not.toHaveBeenCalled();
  });

  it("acks after successful ingest", async () => {
    const msg = mockMsg(validEnvelopeBytes());
    await handleMessage(mockFastify(), msg);
    expect(ingestEvent).toHaveBeenCalledOnce();
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.nak).not.toHaveBeenCalled();
  });

  it("naks when Postgres ingest fails before max_deliver", async () => {
    ingestEvent.mockRejectedValue(new Error("db down"));
    const msg = mockMsg(validEnvelopeBytes(), 1);
    await handleMessage(mockFastify(), msg);
    expect(msg.nak).toHaveBeenCalled();
    expect(publishDlq).not.toHaveBeenCalled();
  });

  it("publishes DLQ and acks on final delivery attempt", async () => {
    ingestEvent.mockRejectedValue(new Error("db down"));
    const msg = mockMsg(validEnvelopeBytes(), 3);
    await handleMessage(mockFastify(), msg);
    expect(publishDlq).toHaveBeenCalledWith(
      expect.anything(),
      "event_store.ingest",
      expect.objectContaining({
        last_error: "db down",
        original_subject: msg.subject,
      }),
    );
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.nak).not.toHaveBeenCalled();
  });
});
