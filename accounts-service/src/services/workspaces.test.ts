import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ensureWorkspace, listWorkspacesForOwner } from "./workspaces";

const WORKSPACE = {
  id: "ws-1",
  slug: "datha-platform",
  name: "DatHa Platform",
  created_at: new Date("2026-01-01T00:00:00Z"),
};

function mockDb(rows: unknown[]): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

describe("ensureWorkspace", () => {
  it("upserts on slug and returns the row", async () => {
    const db = mockDb([WORKSPACE]);
    const result = await ensureWorkspace(
      db,
      "datha-platform",
      "DatHa Platform",
    );
    expect(result).toEqual(WORKSPACE);
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("ON CONFLICT (slug)");
    expect(params).toEqual(["datha-platform", "DatHa Platform"]);
  });

  it("keeps the stored name so a rename is not undone by a restart", async () => {
    const db = mockDb([WORKSPACE]);
    await ensureWorkspace(db, "datha-platform", "Renamed");
    const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("SET name = workspaces.name");
  });
});

describe("listWorkspacesForOwner", () => {
  it("returns the caller's memberships with roles", async () => {
    const db = mockDb([
      {
        id: "ws-1",
        slug: "datha-platform",
        name: "DatHa Platform",
        role: "member",
      },
    ]);
    const result = await listWorkspacesForOwner(db, "google_1");
    expect(result).toEqual([
      {
        id: "ws-1",
        slug: "datha-platform",
        name: "DatHa Platform",
        role: "member",
      },
    ]);
    const [, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(params).toEqual(["google_1"]);
  });
});
