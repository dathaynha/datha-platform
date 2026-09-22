import type { Pool } from "pg";

export interface MarkReadInput {
  conversationId: string;
  ownerId: string;
  /** The newest message the client rendered; its stored timestamp is the mark. */
  messageId: string;
}

export interface MarkReadResult {
  /** The watermark now in force, which may be the previous one. */
  lastReadAt: Date;
  /** true when this call actually moved it forward. */
  advanced: boolean;
}

/**
 * Advances the read watermark, never rewinds it. Two tabs reporting different
 * positions, or a late frame from a stale tab, must not mark a read
 * conversation unread again — so the write is a GREATEST, not an assignment.
 *
 * The mark is read from the message row **inside** the statement rather than
 * passed in from the caller. A timestamptz carries microseconds and a JS Date
 * only milliseconds, so a value that went through the driver comes back
 * truncated — enough to leave the last message looking newer than the
 * watermark and the badge permanently lit.
 *
 * The pre-update value is read in the same statement so `advanced` reports what
 * happened rather than what was asked for: a repeated call with the same
 * message is not an advance, and callers use that to skip a fanout frame.
 */
export async function markRead(
  db: Pool,
  input: MarkReadInput,
): Promise<MarkReadResult | null> {
  const { rows } = await db.query<{
    last_read_at: Date;
    previous_read_at: Date | null;
    advanced: boolean;
  }>(
    `UPDATE conversation_participants p
        SET last_read_at = GREATEST(
              COALESCE(p.last_read_at, m.created_at), m.created_at)
       FROM messages m,
            (
              SELECT last_read_at AS previous_read_at
                FROM conversation_participants
               WHERE conversation_id = $1 AND owner_id = $2
            ) old
      WHERE m.id = $3
        AND m.conversation_id = $1
        AND p.conversation_id = $1
        AND p.owner_id = $2
        AND p.left_at IS NULL
      RETURNING p.last_read_at,
                old.previous_read_at,
                (old.previous_read_at IS NULL
                 OR m.created_at > old.previous_read_at) AS advanced`,
    [input.conversationId, input.ownerId, input.messageId],
  );

  const row = rows[0];
  if (!row) return null;
  return { lastReadAt: row.last_read_at, advanced: row.advanced };
}
