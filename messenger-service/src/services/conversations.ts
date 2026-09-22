import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  settleStaleCall,
  toCall,
  toMessage,
  toParticipant,
  type CallRow,
  type Conversation,
  type ConversationRow,
  type ConversationType,
  type MessageRow,
  type ParticipantRow,
} from "../types/messenger";
import { config } from "../config";

/**
 * Direct conversations are keyed by their sorted owner-id pair, so the unique
 * index collides instead of creating a second thread when two people open each
 * other at the same moment.
 */
export function directKeyFor(ownerIds: readonly string[]): string {
  return [...ownerIds].sort().join("|");
}

export interface CreateConversationInput {
  ownerId: string;
  tenantId: string;
  type: ConversationType;
  participantOwnerIds: string[];
  title?: string | null;
}

export interface CreateConversationResult {
  conversation: ConversationRow;
  participants: ParticipantRow[];
  /** false when an existing direct conversation was returned instead. */
  created: boolean;
}

export async function createConversation(
  db: Pool,
  input: CreateConversationInput,
): Promise<CreateConversationResult> {
  const members = [
    ...new Set([input.ownerId, ...input.participantOwnerIds]),
  ].filter(Boolean);

  if (input.type === "direct" && members.length !== 2) {
    throw new BadConversationInput(
      "a direct conversation needs exactly two distinct participants",
    );
  }
  if (members.length < 2) {
    throw new BadConversationInput("a conversation needs two participants");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const directKey = input.type === "direct" ? directKeyFor(members) : null;

    const inserted = await client.query<ConversationRow>(
      `INSERT INTO conversations (id, tenant_id, type, direct_key, title, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (direct_key) DO NOTHING
         RETURNING *`,
      [
        randomUUID(),
        input.tenantId,
        input.type,
        directKey,
        input.type === "group" ? (input.title ?? null) : null,
        input.ownerId,
      ],
    );

    let conversation = inserted.rows[0];
    let created = true;

    if (!conversation) {
      // Only reachable for direct conversations: the pair already exists.
      const existing = await client.query<ConversationRow>(
        "SELECT * FROM conversations WHERE direct_key = $1",
        [directKey],
      );
      conversation = existing.rows[0];
      created = false;
      if (!conversation) {
        throw new Error("conversation insert conflicted but no row was found");
      }
    }

    const participants = await upsertParticipants(client, {
      conversationId: conversation.id,
      ownerIds: members,
      adminOwnerId: created ? input.ownerId : null,
    });

    await client.query("COMMIT");
    return { conversation, participants, created };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Thrown for input the caller could have validated — routes map it to 400. */
export class BadConversationInput extends Error {}

/**
 * Adds members, and re-activates anyone who had left: rejoining a thread you
 * left must work without a second row appearing.
 */
export async function upsertParticipants(
  client: PoolClient | Pool,
  params: {
    conversationId: string;
    ownerIds: readonly string[];
    adminOwnerId: string | null;
  },
): Promise<ParticipantRow[]> {
  const { rows } = await client.query<ParticipantRow>(
    `INSERT INTO conversation_participants (conversation_id, owner_id, role)
          SELECT $1, owner_id, CASE WHEN owner_id = $3 THEN 'admin' ELSE 'member' END
            FROM UNNEST($2::text[]) AS owner_id
     ON CONFLICT (conversation_id, owner_id)
     DO UPDATE SET left_at = NULL
        RETURNING *`,
    [params.conversationId, [...params.ownerIds], params.adminOwnerId],
  );
  return rows;
}

export async function listParticipants(
  db: Pool,
  conversationIds: readonly string[],
): Promise<Map<string, ParticipantRow[]>> {
  const byConversation = new Map<string, ParticipantRow[]>();
  if (conversationIds.length === 0) return byConversation;

  const { rows } = await db.query<ParticipantRow>(
    `SELECT * FROM conversation_participants
      WHERE conversation_id = ANY($1::uuid[]) AND left_at IS NULL
      ORDER BY joined_at ASC`,
    [[...conversationIds]],
  );

  for (const row of rows) {
    const list = byConversation.get(row.conversation_id) ?? [];
    list.push(row);
    byConversation.set(row.conversation_id, list);
  }
  return byConversation;
}

export async function listLastMessages(
  db: Pool,
  conversationIds: readonly string[],
): Promise<Map<string, MessageRow>> {
  const byConversation = new Map<string, MessageRow>();
  if (conversationIds.length === 0) return byConversation;

  const { rows } = await db.query<MessageRow>(
    `SELECT m.*
       FROM UNNEST($1::uuid[]) AS wanted (conversation_id)
       JOIN LATERAL (
              SELECT * FROM messages
               WHERE conversation_id = wanted.conversation_id
                 AND deleted_at IS NULL
               ORDER BY created_at DESC
               LIMIT 1
            ) m ON TRUE`,
    [[...conversationIds]],
  );

  for (const row of rows) {
    byConversation.set(row.conversation_id, row);
  }
  return byConversation;
}

/**
 * The latest call per conversation, for the preview line.
 *
 * `settleStaleCall` is applied here for the same reason `calls.ts` applies it:
 * an unfinished row whose closer died reads as a call still in progress, and
 * the list would advertise an ongoing call forever. One rule, applied wherever
 * a call row is read.
 */
export async function listLastCalls(
  db: Pool,
  conversationIds: readonly string[],
): Promise<Map<string, CallRow>> {
  const byConversation = new Map<string, CallRow>();
  if (conversationIds.length === 0) return byConversation;

  const { rows } = await db.query<CallRow>(
    `SELECT k.*,
            COALESCE(parts.participant_owner_ids, '{}') AS participant_owner_ids,
            COALESCE(parts.joined_owner_ids, '{}') AS joined_owner_ids
       FROM UNNEST($1::uuid[]) AS wanted (conversation_id)
       JOIN LATERAL (
              SELECT * FROM calls
               WHERE conversation_id = wanted.conversation_id
               ORDER BY started_at DESC
               LIMIT 1
            ) k ON TRUE
       LEFT JOIN LATERAL (
              SELECT array_agg(cp.owner_id ORDER BY cp.owner_id)
                       AS participant_owner_ids,
                     array_agg(cp.owner_id ORDER BY cp.owner_id)
                       FILTER (WHERE cp.joined) AS joined_owner_ids
                FROM call_participants cp
               WHERE cp.call_id = k.id
            ) parts ON TRUE`,
    [[...conversationIds]],
  );

  for (const row of rows) {
    byConversation.set(
      row.conversation_id,
      settleStaleCall(row, config.CALL_MAX_LIFETIME_SECONDS),
    );
  }
  return byConversation;
}

/**
 * Unread is derived, never stored: the last message is newer than my watermark
 * and it is not mine. A stored counter corrupts permanently on one duplicated
 * frame; a derived set self-heals on every read.
 */
export function isUnreadFor(params: {
  ownerId: string;
  lastReadAt: Date | null;
  lastMessage: MessageRow | undefined;
}): boolean {
  const { lastMessage } = params;
  if (!lastMessage) return false;
  if (lastMessage.sender_owner_id === params.ownerId) return false;
  if (!params.lastReadAt) return true;
  return lastMessage.created_at.getTime() > params.lastReadAt.getTime();
}

export function toConversation(params: {
  row: ConversationRow;
  participants: ParticipantRow[];
  lastMessage: MessageRow | undefined;
  lastCall?: CallRow | undefined;
  ownerId: string;
}): Conversation {
  const { row, participants, lastMessage, lastCall, ownerId } = params;
  const mine = participants.find((p) => p.owner_id === ownerId);

  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    title: row.title,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
    lastActivityAt: row.last_activity_at.toISOString(),
    participants: participants.map(toParticipant),
    lastMessage: lastMessage ? toMessage(lastMessage) : null,
    lastCall: lastCall ? toCall(lastCall) : null,
    unread: isUnreadFor({
      ownerId,
      lastReadAt: mine?.last_read_at ?? null,
      lastMessage,
    }),
  };
}

export async function hydrateConversations(
  db: Pool,
  rows: readonly ConversationRow[],
  ownerId: string,
): Promise<Conversation[]> {
  const ids = rows.map((r) => r.id);
  const [participants, lastMessages, lastCalls] = await Promise.all([
    listParticipants(db, ids),
    listLastMessages(db, ids),
    listLastCalls(db, ids),
  ]);

  return rows.map((row) =>
    toConversation({
      row,
      participants: participants.get(row.id) ?? [],
      lastMessage: lastMessages.get(row.id),
      lastCall: lastCalls.get(row.id),
      ownerId,
    }),
  );
}

export interface ListConversationsInput {
  ownerId: string;
  limit: number;
  /**
   * Keyset cursor: `<last_activity_at ISO>|<id>` of the previous page's last
   * row.
   *
   * The id is half the key, not decoration. A timestamp-only cursor compared
   * with `<` drops every row that shares the boundary row's instant — which a
   * group created in one transaction, or two calls ending together, can
   * produce. The tuple compare below matches the ORDER BY exactly, so the walk
   * is total and each row is returned once.
   */
  cursor?: string | null;
}

/** Splits a cursor into its two halves; null when absent or malformed. */
export function parseCursor(
  cursor: string | null | undefined,
): { activityAt: string; id: string } | null {
  if (!cursor) return null;
  const at = cursor.lastIndexOf("|");
  if (at <= 0) return null;
  const activityAt = cursor.slice(0, at);
  const id = cursor.slice(at + 1);
  if (!id || Number.isNaN(Date.parse(activityAt))) return null;
  return { activityAt, id };
}

export interface ListConversationsResult {
  conversations: Conversation[];
  nextCursor: string | null;
}

export async function listConversations(
  db: Pool,
  input: ListConversationsInput,
): Promise<ListConversationsResult> {
  const cursor = parseCursor(input.cursor);
  const { rows } = await db.query<ConversationRow>(
    `SELECT c.*
       FROM conversations c
       JOIN conversation_participants p
         ON p.conversation_id = c.id
        AND p.owner_id = $1
        AND p.left_at IS NULL
      WHERE c.deleted_at IS NULL
        AND ($2::timestamptz IS NULL
             OR (c.last_activity_at, c.id) < ($2::timestamptz, $3::uuid))
      ORDER BY c.last_activity_at DESC, c.id DESC
      LIMIT $4`,
    [
      input.ownerId,
      cursor?.activityAt ?? null,
      cursor?.id ?? null,
      input.limit,
    ],
  );

  const conversations = await hydrateConversations(db, rows, input.ownerId);
  const last = rows[rows.length - 1];
  // A page shorter than the limit is the end. `last_activity_at` is NOT NULL,
  // so unlike the old `last_message_at` cursor there is no untraversable tail
  // of never-used conversations.
  const nextCursor =
    rows.length === input.limit && last
      ? `${last.last_activity_at.toISOString()}|${last.id}`
      : null;

  return { conversations, nextCursor };
}

export async function getConversation(
  db: Pool,
  conversationId: string,
  ownerId: string,
): Promise<Conversation | null> {
  const { rows } = await db.query<ConversationRow>(
    "SELECT * FROM conversations WHERE id = $1 AND deleted_at IS NULL",
    [conversationId],
  );
  const row = rows[0];
  if (!row) return null;

  const [hydrated] = await hydrateConversations(db, [row], ownerId);
  return hydrated ?? null;
}

export async function updateConversationTitle(
  db: Pool,
  params: { conversationId: string; title: string | null },
): Promise<ConversationRow | null> {
  const { rows } = await db.query<ConversationRow>(
    `UPDATE conversations
        SET title = $2
      WHERE id = $1 AND deleted_at IS NULL AND type = 'group'
      RETURNING *`,
    [params.conversationId, params.title],
  );
  return rows[0] ?? null;
}

export async function leaveConversation(
  db: Pool,
  params: { conversationId: string; ownerId: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE conversation_participants
        SET left_at = now()
      WHERE conversation_id = $1 AND owner_id = $2 AND left_at IS NULL`,
    [params.conversationId, params.ownerId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The badge resync: the set of conversation ids unread for this owner. Set
 * semantics all the way down — the client unions and deletes ids, so duplicate
 * frames are free and a dropped one self-heals here.
 */
export async function getUnreadConversationIds(
  db: Pool,
  ownerId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT c.id
       FROM conversations c
       JOIN conversation_participants p
         ON p.conversation_id = c.id
        AND p.owner_id = $1
        AND p.left_at IS NULL
       JOIN LATERAL (
              SELECT sender_owner_id, created_at
                FROM messages
               WHERE conversation_id = c.id AND deleted_at IS NULL
               ORDER BY created_at DESC
               LIMIT 1
            ) lm ON TRUE
      WHERE c.deleted_at IS NULL
        AND lm.sender_owner_id <> $1
        AND (p.last_read_at IS NULL OR lm.created_at > p.last_read_at)`,
    [ownerId],
  );
  return rows.map((r) => r.id);
}
