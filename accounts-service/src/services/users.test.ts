import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  deriveDisplayName,
  getUserByOwnerId,
  lookupUsers,
  searchDirectory,
  syncUser,
} from "./users";

const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  owner_id: "google_1",
  email: "dat@example.com",
  display_name: "Dat Ha",
  picture_url: "",
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
  last_seen_at: new Date("2026-01-01T00:00:00Z"),
};

function mockDb(rows: unknown[]): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

function mockPoolWithClient(client: Partial<PoolClient>): Pool {
  return {
    connect: vi.fn().mockResolvedValue(client as PoolClient),
  } as unknown as Pool;
}

/** The users upsert among the transaction's queries; fails loudly if absent. */
function findUsersUpsert(calls: unknown[][]): [string, unknown[]] {
  const call = calls.find((c) => String(c[0]).includes("INSERT INTO users"));
  if (!call) throw new Error("no users upsert was issued");
  return [String(call[0]), call[1] as unknown[]];
}

describe("deriveDisplayName", () => {
  it("prefers the provider name", () => {
    expect(deriveDisplayName("Dat Ha", "dat@example.com", "google_1")).toBe(
      "Dat Ha",
    );
  });

  it("falls back to the email local part", () => {
    expect(deriveDisplayName("  ", "dat@example.com", "google_1")).toBe("dat");
  });

  it("falls back to the owner id when nothing else is known", () => {
    expect(deriveDisplayName("", "", "entra_abc")).toBe("entra_abc");
  });
});

describe("syncUser", () => {
  function client(inserted: boolean) {
    return {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ ...ROW, inserted }] })
        .mockResolvedValueOnce({ rows: [] }) // membership upsert
        .mockResolvedValueOnce({ rows: [] }), // COMMIT
      release: vi.fn(),
    };
  }

  it("returns the profile and reports a first-time insert", async () => {
    const c = client(true);
    const result = await syncUser(mockPoolWithClient(c), {
      ownerId: "google_1",
      email: "dat@example.com",
      name: "Dat Ha",
      pictureUrl: "https://pic.example/dat.png",
      workspaceId: "ws-1",
    });

    expect(result).toEqual({
      profile: {
        ownerId: "google_1",
        email: "dat@example.com",
        displayName: "Dat Ha",
        pictureUrl: "",
      },
      created: true,
    });
    expect(c.release).toHaveBeenCalled();
  });

  it("reports an existing user as not created", async () => {
    const result = await syncUser(mockPoolWithClient(client(false)), {
      ownerId: "google_1",
      email: "dat@example.com",
      name: "Dat Ha",
      pictureUrl: "https://pic.example/dat.png",
      workspaceId: "ws-1",
    });
    expect(result.created).toBe(false);
  });

  it("never lets the derived fallback overwrite a stored provider name", async () => {
    const c = client(false);
    await syncUser(mockPoolWithClient(c), {
      ownerId: "google_1",
      email: "dat@example.com",
      name: "",
      pictureUrl: "",
      workspaceId: "ws-1",
    });

    const upsert = findUsersUpsert(c.query.mock.calls);
    // $3 is the insert-time fallback, $4 the raw provider name the update uses.
    expect(upsert[0]).toContain("display_name = COALESCE(NULLIF($5::text, '')");
    expect(upsert[1]).toEqual(["google_1", "dat@example.com", "dat", "", ""]);
  });

  it("keeps a stored picture when the provider sends none", async () => {
    const c = client(false);
    await syncUser(mockPoolWithClient(c), {
      ownerId: "google_1",
      email: "dat@example.com",
      name: "Dat Ha",
      pictureUrl: "",
      workspaceId: "ws-1",
    });

    const upsert = findUsersUpsert(c.query.mock.calls);
    expect(upsert[0]).toContain(
      "picture_url  = COALESCE(NULLIF(EXCLUDED.picture_url, '')",
    );
    // $4 is the picture: empty in, stored value preserved by the COALESCE.
    expect(upsert[1][3]).toBe("");
  });

  it("rolls back and rethrows when the upsert fails", async () => {
    const queries: string[] = [];
    const c = {
      query: vi.fn().mockImplementation((sql: string) => {
        queries.push(sql.trim().split(/\s+/)[0]);
        if (sql.includes("INSERT INTO users")) throw new Error("boom");
        return Promise.resolve({ rows: [] });
      }),
      release: vi.fn(),
    };

    await expect(
      syncUser(mockPoolWithClient(c), {
        ownerId: "google_1",
        email: "",
        name: "",
        pictureUrl: "",
        workspaceId: "ws-1",
      }),
    ).rejects.toThrow("boom");
    expect(queries).toContain("ROLLBACK");
    expect(c.release).toHaveBeenCalled();
  });
});

describe("directory", () => {
  it("returns null when the caller has never synced", async () => {
    expect(await getUserByOwnerId(mockDb([]), "google_1")).toBeNull();
  });

  it("excludes the caller from search results", async () => {
    const db = mockDb([]);
    await searchDirectory(db, { ownerId: "google_1", q: "dat", limit: 25 });
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("u.owner_id <> $1");
    expect(params).toEqual(["google_1", "dat", 25]);
  });

  it("scopes search to workspaces the caller belongs to", async () => {
    const db = mockDb([]);
    await searchDirectory(db, { ownerId: "google_1", q: "", limit: 10 });
    const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("m.workspace_id IN");
  });

  it("short-circuits an empty lookup without touching the database", async () => {
    const db = mockDb([]);
    expect(await lookupUsers(db, "google_1", [])).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("maps lookup rows to profiles", async () => {
    const db = mockDb([
      {
        owner_id: "google_2",
        email: "min@example.com",
        display_name: "Minh",
        picture_url: "https://pic",
      },
    ]);
    expect(await lookupUsers(db, "google_1", ["google_2"])).toEqual([
      {
        ownerId: "google_2",
        email: "min@example.com",
        displayName: "Minh",
        pictureUrl: "https://pic",
      },
    ]);
  });
});
