import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor";

describe("event cursor", () => {
  const cursor = {
    timestamp: "2026-09-01T10:00:00.000Z",
    id: "11111111-1111-4111-8111-111111111111",
  };

  it("round-trips", () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("is opaque — the caller cannot read the sort key off it", () => {
    const encoded = encodeCursor(cursor);
    expect(encoded).not.toContain(cursor.id);
    expect(encoded).not.toContain("2026-09-01");
  });

  it("is URL-safe, because it lives in a query string", () => {
    expect(encodeCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["empty", ""],
    ["not base64", "%%%"],
    ["no separator", Buffer.from("nothing-here").toString("base64url")],
    ["no id", Buffer.from("2026-09-01T10:00:00.000Z|").toString("base64url")],
    ["no timestamp", Buffer.from("|some-id").toString("base64url")],
    [
      "unparseable timestamp",
      Buffer.from("never|some-id").toString("base64url"),
    ],
  ])("rejects a cursor that is %s", (_name, raw) => {
    // Null, never a silent fall back to the first page: a deep page that
    // quietly restarts at the top reads as data loss to whoever is on it.
    expect(decodeCursor(raw)).toBeNull();
  });
});
