import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { FileRow } from "../types";
import { listFiles, softDeleteFile } from "./file.service";

function sampleFile(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    owner_id: "google_owner",
    name: "doc.pdf",
    mime_type: "application/pdf",
    size_bytes: 100,
    blob_path: "google_owner/11111111-1111-1111-1111-111111111111/doc.pdf",
    status: "uploaded",
    origin: "chatbot",
    correlation_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function mockPool(queryImpl: (sql: string) => unknown): Pool {
  return { query: vi.fn(queryImpl) } as unknown as Pool;
}

describe("softDeleteFile", () => {
  it("soft-deletes an uploaded file and removes the blob", async () => {
    const file = sampleFile();
    const deleteBlob = vi.fn().mockResolvedValue(undefined);
    const db = mockPool((sql) => {
      if (sql.includes("SELECT")) return { rows: [file] };
      if (sql.includes("UPDATE"))
        return { rows: [{ ...file, status: "deleted" as const }] };
      return { rows: [] };
    });

    const result = await softDeleteFile(db, file.id, file.owner_id, deleteBlob);

    expect(deleteBlob).toHaveBeenCalledWith(file.blob_path);
    expect(result.status).toBe("deleted");
  });

  it("returns 404 when the file is already deleted or missing (idempotent)", async () => {
    const deleteBlob = vi.fn();
    const db = mockPool(() => ({ rows: [] }));

    await expect(
      softDeleteFile(db, "missing-id", "google_owner", deleteBlob),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(deleteBlob).not.toHaveBeenCalled();
  });

  it("returns 403 when envelope owner_id does not match the file row", async () => {
    const file = sampleFile({ owner_id: "google_real" });
    const deleteBlob = vi.fn();
    const db = mockPool(() => ({ rows: [file] }));

    await expect(
      softDeleteFile(db, file.id, "google_other", deleteBlob),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(deleteBlob).not.toHaveBeenCalled();
  });
});

describe("listFiles", () => {
  it("filters by origin when provided (orphan reconcile uses origin=chatbot)", async () => {
    const file = sampleFile({ origin: "chatbot" });
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [file] })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });
    const db = { query } as unknown as Pool;

    const result = await listFiles(db, "google_owner", 10, 0, "chatbot");

    expect(result.data).toEqual([file]);
    expect(result.total).toBe(1);
    expect(query.mock.calls[0][0]).toContain("origin = $4");
    expect(query.mock.calls[0][1]).toEqual(["google_owner", 10, 0, "chatbot"]);
  });

  it("does not filter by origin when omitted", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });
    const db = { query } as unknown as Pool;

    await listFiles(db, "google_owner", 20, 5);

    expect(query.mock.calls[0][0]).not.toContain("origin =");
    expect(query.mock.calls[0][1]).toEqual(["google_owner", 20, 5]);
  });
});
