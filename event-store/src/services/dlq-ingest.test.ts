import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { DlqMessageBody } from "../types/dlq";
import { ingestDlqMessage, parseDlqBody, sinkFromSubject } from "./dlq-ingest";

function validDlqBody(overrides: Partial<DlqMessageBody> = {}): DlqMessageBody {
  return {
    original_subject: "events.chatbot.conversation.deleted",
    correlation_id: "corr-1",
    owner_id: "google_owner",
    payload: { file_ids: [] },
    last_error: "max deliver exceeded",
    failed_at: "2026-01-01T00:00:00.000Z",
    envelope: { id: "11111111-1111-4111-8111-111111111111" },
    ...overrides,
  };
}

describe("sinkFromSubject", () => {
  it("extracts sink from events.dlq.{sink}", () => {
    expect(sinkFromSubject("events.dlq.file.conversation_cleanup")).toBe(
      "file.conversation_cleanup",
    );
  });

  it("rejects non-DLQ subjects", () => {
    expect(() => sinkFromSubject("events.file.file.deleted")).toThrow(
      "DLQ subject must start with events.dlq.",
    );
    expect(() => sinkFromSubject("events.dlq.")).toThrow(
      "DLQ subject missing sink segment",
    );
  });
});

describe("parseDlqBody", () => {
  it("parses a valid DLQ body", () => {
    const body = validDlqBody();
    const parsed = parseDlqBody(new TextEncoder().encode(JSON.stringify(body)));
    expect(parsed.original_subject).toBe("events.chatbot.conversation.deleted");
    expect(parsed.last_error).toBe("max deliver exceeded");
  });

  it("rejects non-object JSON", () => {
    expect(() => parseDlqBody(new TextEncoder().encode('"x"'))).toThrow(
      "DLQ body must be a JSON object",
    );
  });

  it("rejects missing original_subject and last_error", () => {
    expect(() =>
      parseDlqBody(
        new TextEncoder().encode(
          JSON.stringify({
            last_error: "x",
            failed_at: "2026-01-01T00:00:00.000Z",
          }),
        ),
      ),
    ).toThrow("DLQ original_subject is required");
    expect(() =>
      parseDlqBody(
        new TextEncoder().encode(
          JSON.stringify({
            original_subject: "events.test",
            failed_at: "2026-01-01T00:00:00.000Z",
          }),
        ),
      ),
    ).toThrow("DLQ last_error is required");
  });

  it("parses omitted correlation_id and owner_id as null", () => {
    const { correlation_id: _c, owner_id: _o, ...rest } = validDlqBody();
    const parsed = parseDlqBody(new TextEncoder().encode(JSON.stringify(rest)));
    expect(parsed.correlation_id).toBeNull();
    expect(parsed.owner_id).toBeNull();
  });

  it("rejects invalid failed_at and correlation_id", () => {
    expect(() =>
      parseDlqBody(
        new TextEncoder().encode(
          JSON.stringify({
            ...validDlqBody(),
            failed_at: "not-a-date",
          }),
        ),
      ),
    ).toThrow("DLQ failed_at must be ISO 8601");
    expect(() =>
      parseDlqBody(
        new TextEncoder().encode(
          JSON.stringify({
            ...validDlqBody(),
            correlation_id: 1,
          }),
        ),
      ),
    ).toThrow("DLQ correlation_id must be string or null");
    expect(() =>
      parseDlqBody(
        new TextEncoder().encode(
          JSON.stringify({
            ...validDlqBody(),
            owner_id: 1,
          }),
        ),
      ),
    ).toThrow("DLQ owner_id must be string or null");
  });
});

describe("ingestDlqMessage", () => {
  it("persists DLQ row with ON CONFLICT DO NOTHING", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const db = { query } as unknown as Pool;
    const body = validDlqBody();

    await ingestDlqMessage(db, "events.dlq.event_store.ingest", 42, body);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain(
      "ON CONFLICT (jetstream_stream, jetstream_sequence)",
    );
    expect(query.mock.calls[0][1][1]).toBe("event_store.ingest");
    expect(query.mock.calls[0][1][3]).toBe(42);
  });
});
