import { describe, expect, it, vi } from "vitest";
import { publishDlq } from "./dlq.service";

describe("publishDlq", () => {
  it("publishes to events.dlq.{sink} with failed_at", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const js = { publish } as unknown as Parameters<typeof publishDlq>[0];

    await publishDlq(js, "file.conversation_cleanup", {
      original_subject: "events.chatbot.conversation.deleted",
      correlation_id: "corr-1",
      owner_id: "google_owner",
      payload: { file_ids: ["f1"] },
      last_error: "db down",
      failed_at: "2026-01-01T12:00:00.000Z",
    });

    expect(publish).toHaveBeenCalledOnce();
    const [subject, payload] = publish.mock.calls[0] as [string, Uint8Array];
    expect(subject).toBe("events.dlq.file.conversation_cleanup");
    const record = JSON.parse(new TextDecoder().decode(payload)) as {
      failed_at: string;
      last_error: string;
    };
    expect(record.failed_at).toBe("2026-01-01T12:00:00.000Z");
    expect(record.last_error).toBe("db down");
  });

  it("sets failed_at when omitted", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const js = { publish } as unknown as Parameters<typeof publishDlq>[0];

    await publishDlq(js, "test_sink", {
      original_subject: "events.test",
      correlation_id: null,
      owner_id: null,
      payload: {},
      last_error: "err",
    });

    const record = JSON.parse(
      new TextDecoder().decode(publish.mock.calls[0][1] as Uint8Array),
    ) as { failed_at: string };
    expect(record.failed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
