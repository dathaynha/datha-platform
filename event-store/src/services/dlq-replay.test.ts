import type { JetStreamClient } from "@nats-io/jetstream";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dlqQuery from "./dlq-query";
import { DlqReplayError, replayDlqRecord } from "./dlq-replay";

vi.mock("./dlq-query");

const getDlqRecordRowById = vi.mocked(dlqQuery.getDlqRecordRowById);
const markDlqReplayed = vi.mocked(dlqQuery.markDlqReplayed);

const VALID_ENVELOPE = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "file.uploaded",
  service: "file-service",
  entity_id: "f1",
  owner_id: "google_owner",
  correlation_id: "corr-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  payload: { file_id: "f1" },
};

describe("replayDlqRecord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when record missing", async () => {
    getDlqRecordRowById.mockResolvedValue(null);
    await expect(
      replayDlqRecord({} as Pool, {} as JetStreamClient, "missing"),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("returns 409 when record was already replayed", async () => {
    getDlqRecordRowById.mockResolvedValue({
      id: "dlq-1",
      original_subject: "events.test",
      envelope: VALID_ENVELOPE,
      replayed_at: new Date("2026-01-02T00:00:00.000Z"),
    } as Awaited<ReturnType<typeof getDlqRecordRowById>>);
    const publish = vi.fn();
    await expect(
      replayDlqRecord(
        {} as Pool,
        { publish } as unknown as JetStreamClient,
        "dlq-1",
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(markDlqReplayed).not.toHaveBeenCalled();
  });

  it("returns 409 when concurrent replay wins mark after publish", async () => {
    getDlqRecordRowById.mockResolvedValue({
      id: "dlq-1",
      original_subject: "events.test",
      envelope: VALID_ENVELOPE,
      replayed_at: null,
    } as Awaited<ReturnType<typeof getDlqRecordRowById>>);
    markDlqReplayed.mockResolvedValue(null);
    const publish = vi.fn().mockResolvedValue(undefined);
    await expect(
      replayDlqRecord(
        {} as Pool,
        { publish } as unknown as JetStreamClient,
        "dlq-1",
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("returns 400 when stored envelope fails validation", async () => {
    getDlqRecordRowById.mockResolvedValue({
      id: "dlq-1",
      original_subject: "events.test",
      envelope: { id: "not-a-uuid", type: "x", service: "y" },
      replayed_at: null,
    } as Awaited<ReturnType<typeof getDlqRecordRowById>>);
    await expect(
      replayDlqRecord({} as Pool, {} as JetStreamClient, "dlq-1"),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(markDlqReplayed).not.toHaveBeenCalled();
  });

  it("returns 400 when envelope missing", async () => {
    getDlqRecordRowById.mockResolvedValue({
      id: "dlq-1",
      original_subject: "events.test",
      envelope: null,
      replayed_at: null,
    } as Awaited<ReturnType<typeof getDlqRecordRowById>>);
    await expect(
      replayDlqRecord({} as Pool, {} as JetStreamClient, "dlq-1"),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(markDlqReplayed).not.toHaveBeenCalled();
  });

  it("marks replayed after publish (at-least-once on crash between steps)", async () => {
    const replayedAt = new Date("2026-01-02T00:00:00.000Z");
    getDlqRecordRowById.mockResolvedValue({
      id: "dlq-1",
      original_subject: "events.file.file.deleted",
      envelope: VALID_ENVELOPE,
      replayed_at: null,
    } as Awaited<ReturnType<typeof getDlqRecordRowById>>);
    markDlqReplayed.mockResolvedValue(replayedAt);
    const publish = vi.fn().mockResolvedValue(undefined);
    const js = { publish } as unknown as JetStreamClient;

    const result = await replayDlqRecord({} as Pool, js, "dlq-1");

    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(
      markDlqReplayed.mock.invocationCallOrder[0],
    );
    const payload = publish.mock.calls[0][1] as Uint8Array;
    expect(new TextDecoder().decode(payload)).toContain('"file.uploaded"');
    expect(result).toEqual({
      id: "dlq-1",
      originalSubject: "events.file.file.deleted",
      replayedAt: replayedAt.toISOString(),
    });
  });

  it("does not mark replayed when NATS publish fails", async () => {
    getDlqRecordRowById.mockResolvedValue({
      id: "dlq-1",
      original_subject: "events.file.file.deleted",
      envelope: VALID_ENVELOPE,
      replayed_at: null,
    } as Awaited<ReturnType<typeof getDlqRecordRowById>>);
    const publish = vi.fn().mockRejectedValue(new Error("nats down"));

    await expect(
      replayDlqRecord(
        {} as Pool,
        { publish } as unknown as JetStreamClient,
        "dlq-1",
      ),
    ).rejects.toThrow("nats down");
    expect(markDlqReplayed).not.toHaveBeenCalled();
  });

  it("exposes DlqReplayError name", () => {
    expect(new DlqReplayError("x", 400).name).toBe("DlqReplayError");
  });
});
