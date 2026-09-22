import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  BadConversationInput,
  createConversation,
  directKeyFor,
  isUnreadFor,
  listConversations,
  toConversation,
} from "./conversations";
import type { ConversationRow, MessageRow } from "../types/messenger";

const CONVERSATION: ConversationRow = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  tenant_id: "datha-platform",
  type: "direct",
  direct_key: "google_1|google_2",
  title: null,
  created_by: "google_1",
  created_at: new Date("2026-09-08T09:00:00Z"),
  last_message_at: new Date("2026-09-08T10:00:00Z"),
  last_activity_at: new Date("2026-09-08T10:00:00Z"),
  deleted_at: null,
};

const MESSAGE: MessageRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  conversation_id: CONVERSATION.id,
  sender_owner_id: "google_2",
  kind: "text",
  body: "hey",
  attachment_file_id: null,
  thumbnail_file_id: null,
  media_width: null,
  media_height: null,
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

describe("directKeyFor", () => {
  it("is stable whichever way round the pair arrives", () => {
    expect(directKeyFor(["google_2", "google_1"])).toBe("google_1|google_2");
    expect(directKeyFor(["google_1", "google_2"])).toBe("google_1|google_2");
  });
});

describe("createConversation", () => {
  it("rejects a direct conversation that is not exactly two people", async () => {
    const db = mockPoolWithClient({ query: vi.fn(), release: vi.fn() });

    await expect(
      createConversation(db, {
        ownerId: "google_1",
        tenantId: "datha-platform",
        type: "direct",
        participantOwnerIds: ["google_2", "google_3"],
      }),
    ).rejects.toBeInstanceOf(BadConversationInput);
  });

  it("returns the existing thread when the direct pair already exists", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT hit ON CONFLICT DO NOTHING
      .mockResolvedValueOnce({ rows: [CONVERSATION] }) // SELECT by direct_key
      .mockResolvedValueOnce({ rows: [] }) // participants upsert
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await createConversation(
      mockPoolWithClient({ query, release: vi.fn() }),
      {
        ownerId: "google_1",
        tenantId: "datha-platform",
        type: "direct",
        participantOwnerIds: ["google_2"],
      },
    );

    expect(result.created).toBe(false);
    expect(result.conversation).toEqual(CONVERSATION);
    const insert = query.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO conversations"),
    );
    expect(String(insert?.[0])).toContain(
      "ON CONFLICT (direct_key) DO NOTHING",
    );
    // The existing row is looked up by the same key that collided.
    expect(
      query.mock.calls.find((c) =>
        String(c[0]).includes("SELECT * FROM conversations"),
      )?.[1],
    ).toEqual(["google_1|google_2"]);
  });

  it("makes the creator an admin of a new group", async () => {
    const group = { ...CONVERSATION, type: "group" as const, direct_key: null };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [group] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // participants upsert
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    await createConversation(mockPoolWithClient({ query, release: vi.fn() }), {
      ownerId: "google_1",
      tenantId: "datha-platform",
      type: "group",
      participantOwnerIds: ["google_2", "google_3"],
      title: "Team",
    });

    const upsert = query.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO conversation_participants"),
    );
    expect(upsert?.[1]).toEqual([
      group.id,
      ["google_1", "google_2", "google_3"],
      "google_1",
    ]);
  });
});

describe("isUnreadFor", () => {
  it("is false for an empty conversation", () => {
    expect(
      isUnreadFor({
        ownerId: "google_1",
        lastReadAt: null,
        lastMessage: undefined,
      }),
    ).toBe(false);
  });

  it("is false when the last message is my own", () => {
    expect(
      isUnreadFor({
        ownerId: "google_2",
        lastReadAt: null,
        lastMessage: MESSAGE,
      }),
    ).toBe(false);
  });

  it("is true when I have never read the thread", () => {
    expect(
      isUnreadFor({
        ownerId: "google_1",
        lastReadAt: null,
        lastMessage: MESSAGE,
      }),
    ).toBe(true);
  });

  it("is false once my watermark reaches the last message", () => {
    expect(
      isUnreadFor({
        ownerId: "google_1",
        lastReadAt: MESSAGE.created_at,
        lastMessage: MESSAGE,
      }),
    ).toBe(false);
  });
});

describe("toConversation", () => {
  it("reads the watermark of the asking owner, not of the other party", () => {
    const conversation = toConversation({
      row: CONVERSATION,
      participants: [
        {
          conversation_id: CONVERSATION.id,
          owner_id: "google_1",
          role: "member",
          joined_at: CONVERSATION.created_at,
          left_at: null,
          last_read_at: null,
          muted_until: null,
        },
        {
          conversation_id: CONVERSATION.id,
          owner_id: "google_2",
          role: "member",
          joined_at: CONVERSATION.created_at,
          left_at: null,
          last_read_at: MESSAGE.created_at,
          muted_until: null,
        },
      ],
      lastMessage: MESSAGE,
      ownerId: "google_1",
    });

    expect(conversation.unread).toBe(true);
    expect(conversation.lastMessage?.id).toBe(MESSAGE.id);
    expect(conversation.participants).toHaveLength(2);
  });
});

describe("listConversations", () => {
  function mockDb(pages: unknown[][]): Pool {
    const query = vi.fn();
    for (const rows of pages) query.mockResolvedValueOnce({ rows });
    query.mockResolvedValue({ rows: [] });
    return { query } as unknown as Pool;
  }

  it("returns a keyset cursor only when the page is full", async () => {
    const full = await listConversations(
      mockDb([[CONVERSATION], [], [MESSAGE]]),
      { ownerId: "google_1", limit: 1 },
    );
    // `<activity>|<id>`: the id is half the key, so two conversations sharing
    // an instant cannot straddle a page boundary and lose one.
    expect(full.nextCursor).toBe(`2026-09-08T10:00:00.000Z|${CONVERSATION.id}`);

    const partial = await listConversations(
      mockDb([[CONVERSATION], [], [MESSAGE]]),
      { ownerId: "google_1", limit: 30 },
    );
    expect(partial.nextCursor).toBeNull();
  });

  /*
   * This used to assert the opposite, and the old assertion was a limitation
   * written down as a rule: the cursor compared `last_message_at`, which is
   * nullable, so the walk simply stopped at the first conversation nobody had
   * written in. Sorting on `last_activity_at` — NOT NULL, created with the
   * conversation — makes the key total, so the page walk continues (2026-09-16).
   */
  it("pages past a conversation that has no messages yet", async () => {
    const empty = { ...CONVERSATION, last_message_at: null };
    const result = await listConversations(mockDb([[empty], [], [], []]), {
      ownerId: "google_1",
      limit: 1,
    });
    expect(result.nextCursor).toBe(
      `${CONVERSATION.last_activity_at.toISOString()}|${CONVERSATION.id}`,
    );
    expect(result.conversations[0]?.unread).toBe(false);
  });
});
