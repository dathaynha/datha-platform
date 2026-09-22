import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { MessageKind, MessageRow } from "../types/messenger";

export interface SendMessageInput {
  conversationId: string;
  senderOwnerId: string;
  clientMessageId: string;
  kind: MessageKind;
  body: string;
  attachmentFileId?: string | null;
  /** A downscaled copy of an image attachment, uploaded by the same client. */
  thumbnailFileId?: string | null;
  /** The original's pixel size, so a bubble can reserve its shape. */
  mediaWidth?: number | null;
  mediaHeight?: number | null;
}

export interface SendMessageResult {
  message: MessageRow;
  /** false when the caller's client_message_id had already been accepted. */
  created: boolean;
}

/**
 * Accepts a message idempotently. The unique index on
 * (conversation_id, sender_owner_id, client_message_id) is what makes a retried
 * send return the original row instead of a duplicate — the client can retry a
 * timed-out POST without ever double-posting.
 *
 * `last_message_at` and `last_activity_at` are advanced in the same transaction
 * and only forward, so an out-of-order insert (a retry landing late) cannot
 * rewind the list ordering. A message advances both; a call advances only the
 * second, which is the whole reason the two columns are separate.
 */
export async function sendMessage(
  db: Pool,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const inserted = await client.query<MessageRow>(
      `INSERT INTO messages (id, conversation_id, sender_owner_id, kind, body,
                             attachment_file_id, thumbnail_file_id,
                             media_width, media_height, client_message_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (conversation_id, sender_owner_id, client_message_id) DO NOTHING
         RETURNING *`,
      [
        randomUUID(),
        input.conversationId,
        input.senderOwnerId,
        input.kind,
        input.body,
        input.attachmentFileId ?? null,
        input.thumbnailFileId ?? null,
        input.mediaWidth ?? null,
        input.mediaHeight ?? null,
        input.clientMessageId,
      ],
    );

    const message = inserted.rows[0];
    if (!message) {
      const existing = await client.query<MessageRow>(
        `SELECT * FROM messages
          WHERE conversation_id = $1
            AND sender_owner_id = $2
            AND client_message_id = $3`,
        [input.conversationId, input.senderOwnerId, input.clientMessageId],
      );
      await client.query("COMMIT");
      const row = existing.rows[0];
      if (!row) {
        throw new Error("message insert conflicted but no row was found");
      }
      return { message: row, created: false };
    }

    await client.query(
      `UPDATE conversations
          SET last_message_at = GREATEST(
                COALESCE(last_message_at, $2::timestamptz), $2::timestamptz),
              last_activity_at = GREATEST(last_activity_at, $2::timestamptz)
        WHERE id = $1`,
      [input.conversationId, message.created_at],
    );

    await client.query("COMMIT");
    return { message, created: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface ListMessagesInput {
  conversationId: string;
  limit: number;
  /** Keyset cursor: return messages strictly older than this ISO timestamp. */
  before?: string | null;
}

export interface ListMessagesResult {
  messages: MessageRow[];
  /** `createdAt` to pass as `before` for the next (older) page. */
  nextCursor: string | null;
}

/** Newest first — the order the thread renders and pages backwards in. */
export async function listMessages(
  db: Pool,
  input: ListMessagesInput,
): Promise<ListMessagesResult> {
  const { rows } = await db.query<MessageRow>(
    `SELECT * FROM messages
      WHERE conversation_id = $1
        AND deleted_at IS NULL
        AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
      ORDER BY created_at DESC
      LIMIT $3`,
    [input.conversationId, input.before ?? null, input.limit],
  );

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === input.limit && last ? last.created_at.toISOString() : null;

  return { messages: rows, nextCursor };
}

export async function getMessage(
  db: Pool,
  params: { conversationId: string; messageId: string },
): Promise<MessageRow | null> {
  const { rows } = await db.query<MessageRow>(
    "SELECT * FROM messages WHERE id = $1 AND conversation_id = $2",
    [params.messageId, params.conversationId],
  );
  return rows[0] ?? null;
}
