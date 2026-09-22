import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  AttachmentNotFound,
  createFileServiceClient,
  resolveAttachment,
} from "./attachments";

const MESSAGE = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  sender_owner_id: "google_uploader",
  kind: "attachment" as const,
  body: "spec.pdf",
  attachment_file_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  thumbnail_file_id: null,
  media_width: null,
  media_height: null,
  client_message_id: "cm-1",
  created_at: new Date("2026-09-08T10:00:00Z"),
  edited_at: null,
  deleted_at: null,
};

function mockDb(rows: unknown[]): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

describe("resolveAttachment", () => {
  it("returns the file id and the uploader, not the caller", async () => {
    const target = await resolveAttachment(mockDb([MESSAGE]), {
      conversationId: MESSAGE.conversation_id,
      messageId: MESSAGE.id,
    });

    // file-service is owner-scoped, so the download must be requested as the
    // person who uploaded it — the reader is authorized by membership instead.
    expect(target).toEqual({
      fileId: MESSAGE.attachment_file_id,
      ownerId: "google_uploader",
      name: "spec.pdf",
      thumbnailFileId: null,
      width: null,
      height: null,
    });
  });

  it("carries the sender's thumbnail and the original's size", async () => {
    // Only the uploading client ever holds the bytes — file-service does not
    // proxy or interpret them — so the derivative and the dimensions travel
    // with the message and come back out here.
    const db = mockDb([
      {
        ...MESSAGE,
        body: "holiday.png",
        thumbnail_file_id: "11111111-1111-4111-8111-111111111111",
        media_width: 4032,
        media_height: 3024,
      },
    ]);

    const target = await resolveAttachment(db, {
      conversationId: MESSAGE.conversation_id,
      messageId: MESSAGE.id,
    });

    expect(target.thumbnailFileId).toBe("11111111-1111-4111-8111-111111111111");
    expect(target.width).toBe(4032);
    expect(target.height).toBe(3024);
    // Still the uploader, never the reader.
    expect(target.ownerId).toBe("google_uploader");
  });

  it("refuses a message that carries no attachment", async () => {
    const db = mockDb([{ ...MESSAGE, attachment_file_id: null }]);
    await expect(
      resolveAttachment(db, {
        conversationId: MESSAGE.conversation_id,
        messageId: MESSAGE.id,
      }),
    ).rejects.toBeInstanceOf(AttachmentNotFound);
  });

  it("refuses a deleted message", async () => {
    const db = mockDb([{ ...MESSAGE, deleted_at: new Date() }]);
    await expect(
      resolveAttachment(db, {
        conversationId: MESSAGE.conversation_id,
        messageId: MESSAGE.id,
      }),
    ).rejects.toBeInstanceOf(AttachmentNotFound);
  });

  it("refuses a missing message", async () => {
    await expect(
      resolveAttachment(mockDb([]), {
        conversationId: MESSAGE.conversation_id,
        messageId: MESSAGE.id,
      }),
    ).rejects.toBeInstanceOf(AttachmentNotFound);
  });
});

describe("createFileServiceClient", () => {
  it("asks file-service as the uploader and returns the grant", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        sasDownloadUrl: "https://blob.example.com/spec.pdf?sig=abc",
        expiresAt: "2026-09-08T10:05:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createFileServiceClient("http://file-service:3001");
    const grant = await client.downloadUrl("file-1", "google_uploader");

    expect(grant).toEqual({
      url: "https://blob.example.com/spec.pdf?sig=abc",
      expiresAt: "2026-09-08T10:05:00.000Z",
    });
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe("http://file-service:3001/files/file-1/download-url");
    expect(init.headers["X-Owner-ID"]).toBe("google_uploader");
    vi.unstubAllGlobals();
  });

  it("maps a 404 to AttachmentNotFound", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    const client = createFileServiceClient("http://file-service:3001");
    await expect(
      client.downloadUrl("file-1", "google_uploader"),
    ).rejects.toBeInstanceOf(AttachmentNotFound);
    vi.unstubAllGlobals();
  });

  it("reports any other failure rather than pretending it is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    const client = createFileServiceClient("http://file-service:3001");
    await expect(
      client.downloadUrl("file-1", "google_uploader"),
    ).rejects.toThrow("file-service returned 500");
    vi.unstubAllGlobals();
  });

  it("rejects a response with no url instead of handing back an empty one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ expiresAt: "2026-09-08T10:05:00.000Z" }),
      }),
    );
    const client = createFileServiceClient("http://file-service:3001");
    await expect(
      client.downloadUrl("file-1", "google_uploader"),
    ).rejects.toThrow("no download url");
    vi.unstubAllGlobals();
  });

  it("fails loudly when file-service is not configured", async () => {
    const client = createFileServiceClient("");
    await expect(
      client.downloadUrl("file-1", "google_uploader"),
    ).rejects.toThrow("FILE_SERVICE_URL is not configured");
  });
});
