import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { countCapped, queryEvents } from "./query";

/**
 * The arithmetic around the cap, which is where this can quietly go wrong: an
 * off-by-one either reports `cap + 1` as a real total or flags an exact total
 * as capped. The SQL itself is checked against Postgres — a mocked pool cannot
 * tell you whether `LIMIT` inside a counted subquery does what you think.
 */
describe("countCapped", () => {
  const poolReturning = (count: string) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count }] });
    return { db: { query } as unknown as Pool, query };
  };

  it("reports an exact total below the cap", async () => {
    const { db } = poolReturning("42");

    expect(await countCapped(db, "SELECT 1 FROM events", [], 100)).toEqual({
      total: 42,
      capped: false,
    });
  });

  it("reads one row past the cap, which is what detects the ceiling", async () => {
    const { db, query } = poolReturning("101");

    const result = await countCapped(db, "SELECT 1 FROM events", [], 100);

    expect(query.mock.calls[0][0]).toContain("LIMIT 101");
    expect(result).toEqual({ total: 100, capped: true });
  });

  it("does not flag a total that lands exactly on the cap", async () => {
    const { db } = poolReturning("100");

    expect(await countCapped(db, "SELECT 1 FROM events", [], 100)).toEqual({
      total: 100,
      capped: false,
    });
  });

  it("passes the filter values through to the subquery", async () => {
    const { db, query } = poolReturning("0");

    await countCapped(
      db,
      "SELECT 1 FROM events WHERE service = ANY($1)",
      [["file-service"]],
      10,
    );

    expect(query.mock.calls[0][1]).toEqual([["file-service"]]);
  });
});

/**
 * The SQL the payload filter builds. What it means against a real database is
 * checked there — a mocked pool cannot tell you whether `@>` matches a number.
 */
describe("queryEvents payload filters", () => {
  const capture = () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });
    return { db: { query } as unknown as Pool, query };
  };

  const base = { limit: 10, offset: 0, countCap: 1000 };

  it("matches a non-numeric value as a string only", async () => {
    const { db, query } = capture();

    await queryEvents(db, { ...base, payload: { origin: "messenger" } });

    const [sql, values] = query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("payload @> $");
    expect(sql).not.toContain(" OR payload @> ");
    expect(values).toContain('{"origin":"messenger"}');
  });

  it.each([
    ["a number", "2048", '{"size_bytes":2048}'],
    ["a boolean", "true", '{"size_bytes":true}'],
    ["null", "null", '{"size_bytes":null}'],
  ])(
    "also matches %s as the JSON scalar it parses to",
    async (_name, raw, typed) => {
      const { db, query } = capture();

      await queryEvents(db, { ...base, payload: { size_bytes: raw } });

      const [sql, values] = query.mock.calls[1] as [string, unknown[]];
      // Containment is type-strict, so a query string — which is always text —
      // would silently never match a numeric payload field without this.
      expect(sql).toContain(" OR payload @> ");
      expect(values).toContain(`{"size_bytes":"${raw}"}`);
      expect(values).toContain(typed);
    },
  );

  it("does not mistake padded or empty input for a number", async () => {
    const { db, query } = capture();

    await queryEvents(db, { ...base, payload: { note: " 1 " } });

    const [sql] = query.mock.calls[1] as [string];
    expect(sql).not.toContain(" OR payload @> ");
  });

  it("ANDs multiple pairs", async () => {
    const { db, query } = capture();

    await queryEvents(db, {
      ...base,
      payload: { origin: "messenger", mime_type: "image/png" },
    });

    const [sql] = query.mock.calls[1] as [string];
    expect(sql.match(/payload @> \$/g)).toHaveLength(2);
    expect(sql).toContain(" AND ");
  });
});
