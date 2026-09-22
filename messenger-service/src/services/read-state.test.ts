import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { markRead } from "./read-state";

function mockDb(rows: unknown[]): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

const EARLIER = new Date("2026-09-08T10:00:00Z");
const LATER = new Date("2026-09-08T11:00:00Z");

const INPUT = {
  conversationId: "c1",
  ownerId: "google_1",
  messageId: "m1",
};

describe("markRead", () => {
  it("reports an advance when the watermark moves forward", async () => {
    const db = mockDb([
      { last_read_at: LATER, previous_read_at: EARLIER, advanced: true },
    ]);

    await expect(markRead(db, INPUT)).resolves.toEqual({
      lastReadAt: LATER,
      advanced: true,
    });
  });

  it("does not report an advance when a stale position is replayed", async () => {
    // GREATEST kept the newer stored value, so nothing moved: a second tab
    // reporting an older message must not mark the thread unread again.
    const db = mockDb([
      { last_read_at: LATER, previous_read_at: LATER, advanced: false },
    ]);

    await expect(markRead(db, INPUT)).resolves.toEqual({
      lastReadAt: LATER,
      advanced: false,
    });
  });

  it("returns null when the caller is not an active participant", async () => {
    await expect(markRead(mockDb([]), INPUT)).resolves.toBeNull();
  });

  it("never assigns the watermark directly", async () => {
    const db = mockDb([
      { last_read_at: LATER, previous_read_at: EARLIER, advanced: true },
    ]);
    await markRead(db, INPUT);
    const sql = String(vi.mocked(db.query).mock.calls[0]?.[0]);
    expect(sql).toContain("GREATEST");
  });

  it("takes the mark from the message row, never from a caller timestamp", async () => {
    // A timestamptz carries microseconds and a JS Date only milliseconds, so a
    // mark that travels through the driver arrives truncated — and the last
    // message then stays newer than the watermark, leaving the badge lit.
    // Proven live on 2026-09-08: watermark .289 vs message .289209.
    const db = mockDb([
      { last_read_at: LATER, previous_read_at: EARLIER, advanced: true },
    ]);
    await markRead(db, INPUT);
    const call = vi.mocked(db.query).mock.calls[0] as unknown[];
    const sql = String(call[0]);
    const params = call[1] as unknown[];
    expect(sql).toContain("m.created_at");
    expect(params).toEqual(["c1", "google_1", "m1"]);
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });
});
