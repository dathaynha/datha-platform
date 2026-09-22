import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  getPreferences,
  upsertPreferences,
} from "./preferences";

function mockDb(rows: unknown[]): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

const ROW = {
  owner_id: "google_owner",
  locale: "de",
  push_enabled: true,
  push_min_severity: "warning",
  email_digest: true,
  email: "owner@example.com",
  updated_at: new Date("2026-01-01T00:00:00Z"),
};

describe("preferences", () => {
  it("returns defaults when no row exists", async () => {
    const prefs = await getPreferences(mockDb([]), "google_owner");
    expect(prefs).toEqual(DEFAULT_PREFERENCES);
  });

  it("maps a stored row to camelCase preferences", async () => {
    const prefs = await getPreferences(mockDb([ROW]), "google_owner");
    expect(prefs).toEqual({
      locale: "de",
      pushEnabled: true,
      pushMinSeverity: "warning",
      emailDigest: true,
      email: "owner@example.com",
    });
  });

  it("upserts with the captured email and returns the stored preferences", async () => {
    const db = mockDb([ROW]);
    const prefs = await upsertPreferences(
      db,
      "google_owner",
      {
        locale: "de",
        pushEnabled: true,
        pushMinSeverity: "warning",
        emailDigest: true,
      },
      "owner@example.com",
    );
    expect(prefs.pushMinSeverity).toBe("warning");
    expect(prefs.email).toBe("owner@example.com");
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (owner_id) DO UPDATE"),
      ["google_owner", "de", true, "warning", true, "owner@example.com"],
    );
  });

  it("never blanks a stored email — empty header falls back to the existing value", async () => {
    const db = mockDb([ROW]);
    await upsertPreferences(
      db,
      "google_owner",
      {
        locale: "de",
        pushEnabled: true,
        pushMinSeverity: "warning",
        emailDigest: true,
      },
      "",
    );
    const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain(
      "COALESCE(NULLIF(EXCLUDED.email, ''), notification_preferences.email)",
    );
  });
});
