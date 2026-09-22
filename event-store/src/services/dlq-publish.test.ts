import { describe, expect, it, vi } from "vitest";
import { publishDlq } from "./dlq-publish";

describe("publishDlq", () => {
  it("publishes to events.dlq.{sink}", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const js = { publish } as unknown as Parameters<typeof publishDlq>[0];

    await publishDlq(js, "event_store.ingest", {
      original_subject: "events.file.file.uploaded",
      correlation_id: "corr-1",
      owner_id: "google_owner",
      payload: { file_id: "f1" },
      last_error: "postgres timeout",
      failed_at: "2026-01-01T00:00:00.000Z",
    });

    const [subject, payload] = publish.mock.calls[0] as [string, Uint8Array];
    expect(subject).toBe("events.dlq.event_store.ingest");
    expect(JSON.parse(new TextDecoder().decode(payload)).last_error).toBe(
      "postgres timeout",
    );
  });

  it("sets failed_at when omitted", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const js = { publish } as unknown as Parameters<typeof publishDlq>[0];

    await publishDlq(js, "event_store.ingest", {
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
