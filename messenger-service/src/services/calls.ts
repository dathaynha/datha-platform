import type { Pool } from "pg";
import type {
  Call,
  CallEndReason,
  CallMedia,
  CallRow,
} from "../types/messenger";
import { settleStaleCall, toCall } from "../types/messenger";
import { config } from "../config";

/**
 * End reasons an **event** may carry.
 *
 * `expired` is deliberately absent: it is this service's own conclusion that a
 * call outlived any possible call, never something a producer gets to assert.
 */
const END_REASONS: readonly CallEndReason[] = [
  "hangup",
  "declined",
  "missed",
  "busy",
  "ice_failed",
];

/** Postgres foreign-key violation — here it means the conversation is gone. */
export const FK_VIOLATION = "23503";

export interface CallProjection {
  callId: string;
  conversationId: string;
  callerOwnerId: string;
  /** Null for a group call, which has no single person who was called. */
  calleeOwnerId: string | null;
  /** Everyone the call rang, caller included. Empty for a pre-phase-3 event. */
  participantOwnerIds: string[];
  /** Everyone who was on it at any point — a subset of the above. */
  joinedOwnerIds: string[];
  media: CallMedia;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: CallEndReason | null;
  durationSeconds: number;
}

/**
 * Narrows an unvalidated payload string to a media kind.
 *
 * Anything unrecognised — including the field being absent, which is every
 * event published before phase 2.5 — is audio, matching the column default.
 */
export function asMedia(value: unknown): CallMedia {
  return value === "video" ? "video" : "audio";
}

/** Narrows an unvalidated payload string to a known end reason. */
export function asEndReason(value: unknown): CallEndReason | null {
  return typeof value === "string" &&
    (END_REASONS as readonly string[]).includes(value)
    ? (value as CallEndReason)
    : null;
}

/**
 * Upserts one call row.
 *
 * Every column fills **monotonically**: an already-set timestamp or reason is
 * never overwritten, and the duration only grows. That makes the projection
 * both idempotent (a JetStream redelivery changes nothing) and independent of
 * order — an `ended` that overtakes its `started`, which a nak can cause,
 * converges on the same row either way.
 */
export async function projectCall(
  db: Pool,
  input: CallProjection,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO calls (
         id, conversation_id, caller_owner_id, callee_owner_id, media,
         started_at, answered_at, ended_at, end_reason, duration_seconds
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       -- media is deliberately absent below: every event of one call carries
       -- the same kind, so the first write wins and a redelivery cannot flip
       -- it. callee_owner_id is absent for the same reason, and because a group
       -- call has none — a later event must never invent one.
       ON CONFLICT (id) DO UPDATE SET
         answered_at      = COALESCE(calls.answered_at, EXCLUDED.answered_at),
         ended_at         = COALESCE(calls.ended_at, EXCLUDED.ended_at),
         end_reason       = COALESCE(calls.end_reason, EXCLUDED.end_reason),
         duration_seconds = GREATEST(calls.duration_seconds, EXCLUDED.duration_seconds)`,
      [
        input.callId,
        input.conversationId,
        input.callerOwnerId,
        input.calleeOwnerId,
        input.media,
        input.startedAt,
        input.answeredAt,
        input.endedAt,
        input.endReason,
        input.durationSeconds,
      ],
    );

    // Participants land in the same transaction as the call they belong to:
    // the foreign key means they cannot be written first, and a call row
    // without its participants is a group call that looks like it had nobody
    // in it.
    if (
      input.participantOwnerIds.length > 0 ||
      input.joinedOwnerIds.length > 0
    ) {
      await client.query(
        `INSERT INTO call_participants (call_id, owner_id, joined)
         SELECT $1, ids.owner_id, ids.owner_id = ANY($3::text[])
           FROM (
             SELECT DISTINCT unnest($2::text[] || $3::text[]) AS owner_id
           ) AS ids
         -- The union is deliberate. The joined set is a subset of the invited
         -- set by construction — realtime-service refuses a join from anyone
         -- outside it — so the two arrays normally agree. If a producer
         -- bug ever broke that, recording the person is the right failure:
         -- they were on the call, and intersecting against an already-wrong
         -- invited list would erase a real participant to satisfy it.
         --
         -- joined only ever goes false -> true, so a redelivery or an out-of-
         -- order event cannot un-join somebody who was on the call.
         ON CONFLICT (call_id, owner_id) DO UPDATE
           SET joined = call_participants.joined OR EXCLUDED.joined`,
        [input.callId, input.participantOwnerIds, input.joinedOwnerIds],
      );
    }

    /*
     * A call is activity, so it moves the conversation up the list — the one
     * thing the projection never used to do (dathq, 2026-09-16: "the call in
     * the chat doesn't affect the ordering in the chat list?").
     *
     * Forward-only, like the message path, so a redelivered `started` arriving
     * after its `ended` cannot rewind the list. `ended_at` is preferred where
     * it exists because a call that ran an hour is activity at the point it
     * finished, not at the point it was dialled -- but an ongoing call still
     * sorts to the top immediately on its `started` event, which is what makes
     * a live call findable while it is happening.
     *
     * Only `last_activity_at` moves. `last_message_at` stays the preview's own
     * timestamp; bumping it here is exactly the lie this column exists to
     * avoid.
     */
    await client.query(
      `UPDATE conversations
          SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz)
        WHERE id = $1`,
      [input.conversationId, input.endedAt ?? input.startedAt],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Hydrates each row with its participants.
 *
 * A lateral join rather than a second round trip keyed on the ids: the list is
 * already bounded by LIMIT, and keeping it one statement means a call and its
 * participants can never be read from two different moments.
 */
/**
 * A row read back with the lifetime bound applied.
 *
 * Applied on the way out rather than in SQL so that one rule — `settleStaleCall`
 * — governs both the read and the sweep that writes the same values durably. A
 * `CASE` in each query would be a second place for it to drift.
 */
function settled(row: CallRow): CallRow {
  return settleStaleCall(row, config.CALL_MAX_LIFETIME_SECONDS);
}

const WITH_PARTICIPANTS = `
  LEFT JOIN LATERAL (
    SELECT array_agg(cp.owner_id ORDER BY cp.owner_id) AS participant_owner_ids,
           array_agg(cp.owner_id ORDER BY cp.owner_id)
             FILTER (WHERE cp.joined) AS joined_owner_ids
      FROM call_participants cp
     WHERE cp.call_id = calls.id
  ) parts ON true`;

/** The selected columns, with the aggregates defaulted to empty arrays. */
const CALL_COLUMNS = `
  calls.*,
  COALESCE(parts.participant_owner_ids, '{}') AS participant_owner_ids,
  COALESCE(parts.joined_owner_ids, '{}') AS joined_owner_ids`;

/** One conversation's calls, newest first. Membership is checked by the route. */
export async function listConversationCalls(
  db: Pool,
  conversationId: string,
  limit: number,
): Promise<Call[]> {
  const { rows } = await db.query<CallRow>(
    `SELECT ${CALL_COLUMNS}
       FROM calls ${WITH_PARTICIPANTS}
      WHERE calls.conversation_id = $1
      ORDER BY calls.started_at DESC
      LIMIT $2`,
    [conversationId, limit],
  );
  return rows.map(settled).map(toCall);
}

/**
 * The caller's own call history across conversations, newest first.
 *
 * Authorization is the query: a row is yours only if you were on the call, so
 * there is no conversation join and no membership lookup.
 *
 * The caller/callee columns are still checked alongside the participants table
 * because rows projected before phase 3 have no participant rows at all —
 * dropping the old predicate would silently empty everyone's call history.
 */
export async function listOwnerCalls(
  db: Pool,
  ownerId: string,
  limit: number,
): Promise<Call[]> {
  const { rows } = await db.query<CallRow>(
    `SELECT ${CALL_COLUMNS}
       FROM calls ${WITH_PARTICIPANTS}
      WHERE calls.caller_owner_id = $1
         OR calls.callee_owner_id = $1
         OR EXISTS (
              SELECT 1 FROM call_participants cp
               WHERE cp.call_id = calls.id AND cp.owner_id = $1
            )
      ORDER BY calls.started_at DESC
      LIMIT $2`,
    [ownerId, limit],
  );
  return rows.map(settled).map(toCall);
}

/**
 * Closes stale rows for good.
 *
 * The read-time bound keeps every reader honest immediately; this is what stops
 * the database itself being permanently wrong, which matters for anything that
 * aggregates rather than renders — and for the next person to query it by hand.
 * Idempotent, so running it on every instance at boot and on a ticker is safe.
 */
export async function sweepStaleCalls(db: Pool): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE calls
        SET ended_at   = started_at + ($1 || ' seconds')::interval,
            end_reason = 'expired'
      WHERE ended_at IS NULL
        AND started_at < now() - ($1 || ' seconds')::interval`,
    [config.CALL_MAX_LIFETIME_SECONDS],
  );
  return rowCount ?? 0;
}
