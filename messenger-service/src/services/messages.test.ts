import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { listMessages, sendMessage } from "./messages";

const ROW = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  sender_owner_id: "google_1",
  kind: "text" as const,
  body: "hey",
  attachment_file_id: null,
  client_message_id: "client-1",
  created_at: new Date("2026-09-08T10:00:00Z"),
  edited_at: null,
  deleted_at: null,
};

function mockPoolWithClient(client: Partial<PoolClient>): Pool {
  return {
    connect: vi.fn().mockResolvedValue(client as PoolClient),
  } as unknown as Pool;
}

function findCall(calls: unknown[][], needle: string): [string, unknown[]] {
  const call = calls.find((c) => String(c[0]).includes(needle));
  if (!call) throw new Error(`no query containing ${needle} was issued`);
  return [String(call[0]), call[1] as unknown[]];
}

describe("sendMessage", () => {
  it("inserts and advances last_message_at", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [ROW] }) // INSERT ... RETURNING
      .mockResolvedValueOnce({ rows: [] }) // UPDATE conversations
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const release = vi.fn();

    const result = await sendMessage(mockPoolWithClient({ query, release }), {
      conversationId: ROW.conversation_id,
      senderOwnerId: "google_1",
      clientMessageId: "client-1",
      kind: "text",
      body: "hey",
    });

    expect(result).toEqual({ message: ROW, created: true });
    const [sql, params] = findCall(query.mock.calls, "UPDATE conversations");
    // Forward-only: a retry landing late must not rewind the list ordering.
    expect(sql).toContain("GREATEST");
    expect(params[1]).toBe(ROW.created_at);
    expect(release).toHaveBeenCalled();
  });

  it("persists the sender's thumbnail and the original's dimensions", async () => {
    // Nothing else can supply them: file-service does not proxy bytes or read
    // their content, and this service never sees the blob either.
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [ROW] }) // INSERT ... RETURNING
      .mockResolvedValueOnce({ rows: [] }) // UPDATE conversations
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await sendMessage(mockPoolWithClient({ query, release: vi.fn() }), {
      conversationId: ROW.conversation_id,
      senderOwnerId: "google_1",
      clientMessageId: "client-1",
      kind: "attachment",
      body: "holiday.png",
      attachmentFileId: "file-original",
      thumbnailFileId: "file-thumb",
      mediaWidth: 4032,
      mediaHeight: 3024,
    });

    const [sql, params] = findCall(query.mock.calls, "INSERT INTO messages");
    expect(sql).toContain("thumbnail_file_id");
    expect(params).toContain("file-thumb");
    expect(params).toContain(4032);
    expect(params).toContain(3024);
  });

  it("writes nulls when the client sent no derivative", async () => {
    // An older client, or any non-image attachment: the columns stay null and
    // the reader renders the original, exactly as before this existed.
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [ROW] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await sendMessage(mockPoolWithClient({ query, release: vi.fn() }), {
      conversationId: ROW.conversation_id,
      senderOwnerId: "google_1",
      clientMessageId: "client-1",
      kind: "attachment",
      body: "spec.pdf",
      attachmentFileId: "file-original",
    });

    const [, params] = findCall(query.mock.calls, "INSERT INTO messages");
    // id, conversation, sender, kind, body, attachment, thumb, w, h, clientId
    expect(params.slice(6, 9)).toEqual([null, null, null]);
  });

  it("returns the original message when the client id is replayed", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT hit ON CONFLICT DO NOTHING
      .mockResolvedValueOnce({ rows: [ROW] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await sendMessage(
      mockPoolWithClient({ query, release: vi.fn() }),
      {
        conversationId: ROW.conversation_id,
        senderOwnerId: "google_1",
        clientMessageId: "client-1",
        kind: "text",
        body: "hey",
      },
    );

    expect(result).toEqual({ message: ROW, created: false });
    // No second bump of last_message_at: nothing new happened.
    expect(
      query.mock.calls.filter((c) =>
        String(c[0]).includes("UPDATE conversations"),
      ),
    ).toHaveLength(0);
  });

  it("rolls back and rethrows when the insert fails", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(new Error("constraint violated"))
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(
      sendMessage(mockPoolWithClient({ query, release: vi.fn() }), {
        conversationId: ROW.conversation_id,
        senderOwnerId: "google_1",
        clientMessageId: "client-1",
        kind: "text",
        body: "hey",
      }),
    ).rejects.toThrow("constraint violated");

    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
});

describe("listMessages", () => {
  function mockDb(rows: unknown[]): Pool {
    return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
  }

  it("returns a cursor only when the page is full", async () => {
    await expect(
      listMessages(mockDb([ROW]), {
        conversationId: ROW.conversation_id,
        limit: 1,
      }),
    ).resolves.toEqual({
      messages: [ROW],
      nextCursor: "2026-09-08T10:00:00.000Z",
    });

    await expect(
      listMessages(mockDb([ROW]), {
        conversationId: ROW.conversation_id,
        limit: 50,
      }),
    ).resolves.toEqual({ messages: [ROW], nextCursor: null });
  });
});
