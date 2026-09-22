import type { FastifyInstance } from "fastify";
import type { JetStreamClient, JsMsg } from "@nats-io/jetstream";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformEvent } from "../types/events";
import * as dlqService from "./dlq.service";
import * as eventsService from "./events.service";
import * as fileService from "./file.service";
import {
  handleMessage,
  parseEnvelope,
  processConversationDeleted,
} from "./conversation-cleanup.consumer";

vi.mock("./file.service");
vi.mock("./events.service");
vi.mock("./dlq.service");
vi.mock("./sas.service", () => ({
  createSasService: () => ({ deleteBlob: vi.fn() }),
}));

const softDeleteFile = vi.mocked(fileService.softDeleteFile);
const publishEvent = vi.mocked(eventsService.publishEvent);
const publishDlq = vi.mocked(dlqService.publishDlq);

function baseEnvelope(fileIds: string[]): PlatformEvent {
  return {
    id: "evt-1",
    type: "chatbot.conversation.deleted",
    service: "chatbot-service",
    entity_id: "22222222-2222-2222-2222-222222222222",
    owner_id: "google_owner",
    correlation_id: "corr-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: {
      conversation_id: "22222222-2222-2222-2222-222222222222",
      file_ids: fileIds,
    },
  };
}

function mockFastify(): FastifyInstance {
  return {
    blobServiceClient: {},
    db: {} as Pool,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as FastifyInstance;
}

function mockMsg(data: Uint8Array, deliveryCount = 1): JsMsg {
  return {
    data,
    subject: "events.chatbot.conversation.deleted",
    ack: vi.fn(),
    nak: vi.fn(),
    info: { deliveryCount },
  } as unknown as JsMsg;
}

describe("parseEnvelope", () => {
  it("parses a valid platform envelope", () => {
    const envelope = baseEnvelope(["f1"]);
    const parsed = parseEnvelope(
      new TextEncoder().encode(JSON.stringify(envelope)),
    );
    expect(parsed.owner_id).toBe("google_owner");
    expect(parsed.payload.file_ids).toEqual(["f1"]);
  });

  it("throws when payload is missing", () => {
    expect(() =>
      parseEnvelope(new TextEncoder().encode(JSON.stringify({ type: "x" }))),
    ).toThrow("invalid event envelope");
  });

  it("throws on invalid JSON", () => {
    expect(() =>
      parseEnvelope(new TextEncoder().encode("{not json")),
    ).toThrow();
  });
});

describe("processConversationDeleted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishEvent.mockResolvedValue(undefined);
  });

  it("deletes orphan files and publishes file.deleted for each success", async () => {
    softDeleteFile.mockResolvedValue({
      id: "f1",
      owner_id: "google_owner",
      mime_type: "application/pdf",
      blob_path: "path/f1",
    } as Awaited<ReturnType<typeof fileService.softDeleteFile>>);

    await processConversationDeleted(
      mockFastify(),
      {} as JetStreamClient,
      {} as Pool,
      baseEnvelope(["f1"]),
      mockFastify().log,
    );

    expect(softDeleteFile).toHaveBeenCalledWith(
      expect.anything(),
      "f1",
      "google_owner",
      expect.any(Function),
    );
    expect(publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "file.deleted", fileId: "f1" }),
    );
  });

  it("skips missing files without failing (idempotent redelivery)", async () => {
    softDeleteFile.mockRejectedValue(
      Object.assign(new Error("File not found"), { statusCode: 404 }),
    );

    await processConversationDeleted(
      mockFastify(),
      {} as JetStreamClient,
      {} as Pool,
      baseEnvelope(["gone-file"]),
      mockFastify().log,
    );

    expect(publishEvent).not.toHaveBeenCalled();
  });

  it("skips files with ownership mismatch", async () => {
    softDeleteFile.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { statusCode: 403 }),
    );
    const log = mockFastify().log;

    await processConversationDeleted(
      mockFastify(),
      {} as JetStreamClient,
      {} as Pool,
      baseEnvelope(["wrong-owner"]),
      log,
    );

    expect(log.warn).toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it("throws when envelope owner_id is missing", async () => {
    const envelope = { ...baseEnvelope([]), owner_id: "" };
    await expect(
      processConversationDeleted(
        mockFastify(),
        {} as JetStreamClient,
        {} as Pool,
        envelope,
        mockFastify().log,
      ),
    ).rejects.toThrow("envelope missing owner_id");
  });

  it("ignores invalid entries in file_ids", async () => {
    await processConversationDeleted(
      mockFastify(),
      {} as JetStreamClient,
      {} as Pool,
      baseEnvelope(["", "ok-id"] as unknown as string[]),
      mockFastify().log,
    );

    expect(softDeleteFile).toHaveBeenCalledTimes(1);
    expect(softDeleteFile).toHaveBeenCalledWith(
      expect.anything(),
      "ok-id",
      "google_owner",
      expect.any(Function),
    );
  });

  it("logs and continues when file.deleted publish fails", async () => {
    softDeleteFile.mockResolvedValue({
      id: "f1",
      owner_id: "google_owner",
      mime_type: null,
      blob_path: "path/f1",
    } as Awaited<ReturnType<typeof fileService.softDeleteFile>>);
    publishEvent.mockRejectedValue(new Error("nats publish failed"));
    const log = mockFastify().log;

    await processConversationDeleted(
      mockFastify(),
      {} as JetStreamClient,
      {} as Pool,
      baseEnvelope(["f1"]),
      log,
    );

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "f1" }),
      "Failed to publish file.deleted event",
    );
  });
});

describe("handleMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishEvent.mockResolvedValue(undefined);
    softDeleteFile.mockResolvedValue({
      id: "f1",
      owner_id: "google_owner",
      mime_type: null,
      blob_path: "p",
    } as Awaited<ReturnType<typeof fileService.softDeleteFile>>);
  });

  it("acks invalid JSON without retry", async () => {
    const msg = mockMsg(new TextEncoder().encode("not-json"));
    await handleMessage(mockFastify(), {} as JetStreamClient, msg);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.nak).not.toHaveBeenCalled();
  });

  it("acks after successful cleanup", async () => {
    const msg = mockMsg(
      new TextEncoder().encode(JSON.stringify(baseEnvelope([]))),
    );
    await handleMessage(mockFastify(), {} as JetStreamClient, msg);
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.nak).not.toHaveBeenCalled();
  });

  it("naks when cleanup fails before max_deliver", async () => {
    softDeleteFile.mockRejectedValue(new Error("db down"));
    const msg = mockMsg(
      new TextEncoder().encode(JSON.stringify(baseEnvelope(["f1"]))),
      1,
    );
    await handleMessage(mockFastify(), {} as JetStreamClient, msg);
    expect(msg.nak).toHaveBeenCalled();
    expect(publishDlq).not.toHaveBeenCalled();
  });

  it("publishes DLQ and acks on final delivery attempt", async () => {
    softDeleteFile.mockRejectedValue(new Error("db down"));
    publishDlq.mockResolvedValue(undefined);
    const msg = mockMsg(
      new TextEncoder().encode(JSON.stringify(baseEnvelope(["f1"]))),
      3,
    );
    await handleMessage(mockFastify(), {} as JetStreamClient, msg);
    expect(publishDlq).toHaveBeenCalledWith(
      expect.anything(),
      "file.conversation_cleanup",
      expect.objectContaining({ last_error: "db down" }),
    );
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.nak).not.toHaveBeenCalled();
  });
});
