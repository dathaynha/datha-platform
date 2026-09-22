import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { expiredEventPartitions, runRetention } from "./retention";

/** The catalogue rows `runRetention` reads, in the order it reads them. */
function partitionRows(names: string[]) {
  return { rows: names.map((relname) => ({ relname })) };
}

const PARTITIONS = [
  "events_default",
  "events_y2026m05",
  "events_y2026m06",
  "events_y2026m07",
];

describe("expiredEventPartitions", () => {
  it("keeps a partition whose range still covers live rows", async () => {
    const query = vi.fn().mockResolvedValue(partitionRows(PARTITIONS));
    const db = { query } as unknown as Pool;

    // Mid-June: May is wholly expired, June is not — its upper bound (1 July)
    // is still in the future, and dropping it would take live rows with it.
    const expired = await expiredEventPartitions(
      db,
      new Date("2026-06-15T00:00:00Z"),
    );

    expect(expired).toEqual(["events_y2026m05"]);
  });

  it("expires a partition exactly on its upper bound, not before", async () => {
    const query = vi.fn().mockResolvedValue(partitionRows(PARTITIONS));
    const db = { query } as unknown as Pool;

    // The bound is exclusive: a partition FROM 1 May TO 1 June holds nothing
    // at or after 1 June, so 1 June is the first moment it can go.
    const onBound = await expiredEventPartitions(
      db,
      new Date("2026-06-01T00:00:00Z"),
    );
    const justBefore = await expiredEventPartitions(
      db,
      new Date("2026-05-31T23:59:59Z"),
    );

    expect(onBound).toEqual(["events_y2026m05"]);
    expect(justBefore).toEqual([]);
  });

  it("never returns the default partition", async () => {
    const query = vi.fn().mockResolvedValue(partitionRows(PARTITIONS));
    const db = { query } as unknown as Pool;

    // It cannot be dropped, and it is where an out-of-range replay lands. Its
    // expired rows are deleted row-wise instead.
    const expired = await expiredEventPartitions(
      db,
      new Date("2030-01-01T00:00:00Z"),
    );

    expect(expired).not.toContain("events_default");
    expect(expired).toEqual([
      "events_y2026m05",
      "events_y2026m06",
      "events_y2026m07",
    ]);
  });
});

describe("runRetention", () => {
  it("dry-run reports what it would drop and drops nothing", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ count: "5" }] })
      .mockResolvedValueOnce({ rows: [{ count: "2" }] })
      .mockResolvedValueOnce(
        partitionRows(["events_default", "events_y2020m01"]),
      )
      .mockResolvedValueOnce({ rows: [{ count: "4" }] });
    const db = { query } as unknown as Pool;

    const stats = await runRetention(db, {
      eventsRetentionDays: 90,
      dlqRetentionDays: 180,
      execute: false,
    });

    expect(stats).toEqual({
      eventsCandidates: 5,
      eventsDeleted: 0,
      eventsPartitionsDropped: ["events_y2020m01"],
      dlqCandidates: 2,
      dlqDeleted: 0,
    });
    // Two counts, the catalogue read, and the doomed partition's row count —
    // no DDL, no DELETE.
    expect(query).toHaveBeenCalledTimes(4);
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((s) => s.startsWith("DROP TABLE"))).toBe(false);
    expect(sql.some((s) => s.includes("DELETE"))).toBe(false);
  });

  it("execute drops whole partitions instead of deleting their rows", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ count: "3" }] })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      .mockResolvedValueOnce(
        partitionRows(["events_default", "events_y2020m01"]),
      )
      // The doomed partition holds 7 rows; 2 more stragglers sit in default.
      .mockResolvedValueOnce({ rows: [{ count: "7" }] })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 });
    const db = { query } as unknown as Pool;

    const stats = await runRetention(db, {
      eventsRetentionDays: 90,
      dlqRetentionDays: 180,
      execute: true,
    });

    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(
      sql.some((s) => s.includes('DROP TABLE IF EXISTS "events_y2020m01"')),
    ).toBe(true);
    // The point of the change: the expired rows are never read or written.
    expect(sql.some((s) => /DELETE FROM events\b/.test(s))).toBe(false);
    expect(sql.some((s) => s.includes("DELETE FROM events_default"))).toBe(
      true,
    );
    expect(sql.some((s) => s.includes("DELETE FROM dlq_records"))).toBe(true);
    expect(stats.eventsPartitionsDropped).toEqual(["events_y2020m01"]);
    // Rows genuinely removed, not rows merely past the cutoff: a partition
    // still holding live rows keeps its old ones until the whole month expires,
    // so reporting `eventsCandidates` here would overstate it (measured on a
    // clone: 64 candidates, 59 removed).
    expect(stats.eventsDeleted).toBe(9);
    expect(stats.dlqDeleted).toBe(1);
  });
});
