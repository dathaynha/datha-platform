/** Row shapes as they come back from Postgres (snake_case, dates as Date). */

export type ConversationType = "direct" | "group";
export type ParticipantRole = "member" | "admin";
export type MessageKind = "text" | "attachment" | "system";

export interface ConversationRow {
  id: string;
  tenant_id: string;
  type: ConversationType;
  direct_key: string | null;
  title: string | null;
  created_by: string;
  created_at: Date;
  last_message_at: Date | null;
  /**
   * When anything last happened here: a message, or a call.
   *
   * The list's sort key and its keyset cursor, kept apart from
   * `last_message_at` so that column can go on meaning the preview's own
   * timestamp. NOT NULL, which is what makes the cursor total — see
   * `008_conversation_activity.sql`.
   */
  last_activity_at: Date;
  deleted_at: Date | null;
}

export interface ParticipantRow {
  conversation_id: string;
  owner_id: string;
  role: ParticipantRole;
  joined_at: Date;
  left_at: Date | null;
  last_read_at: Date | null;
  muted_until: Date | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_owner_id: string;
  kind: MessageKind;
  body: string;
  attachment_file_id: string | null;
  thumbnail_file_id: string | null;
  media_width: number | null;
  media_height: number | null;
  client_message_id: string;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
}

/** Wire shapes returned by the REST API (camelCase, ISO strings). */

export interface ConversationParticipant {
  ownerId: string;
  role: ParticipantRole;
  lastReadAt: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  senderOwnerId: string;
  kind: MessageKind;
  body: string;
  attachmentFileId: string | null;
  /**
   * A downscaled copy of an image attachment, when the sender made one.
   *
   * Null on every message sent before this existed, and on any client that
   * does not produce one — the bubble then renders the original, as it did.
   */
  thumbnailFileId: string | null;
  /** The original's pixel size, so the bubble reserves its shape up front. */
  mediaWidth: number | null;
  mediaHeight: number | null;
  clientMessageId: string;
  createdAt: string;
  editedAt: string | null;
}

export interface Conversation {
  id: string;
  tenantId: string;
  type: ConversationType;
  title: string | null;
  createdBy: string;
  createdAt: string;
  lastMessageAt: string | null;
  /** When anything last happened here. What the list sorts and pages on. */
  lastActivityAt: string;
  participants: ConversationParticipant[];
  lastMessage: Message | null;
  /**
   * The most recent call, so a row whose latest activity is a call can say so
   * instead of showing a message from hours earlier stamped with the call's
   * time. Null where there has never been one.
   */
  lastCall: Call | null;
  unread: boolean;
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderOwnerId: row.sender_owner_id,
    kind: row.kind,
    body: row.body,
    attachmentFileId: row.attachment_file_id,
    thumbnailFileId: row.thumbnail_file_id,
    mediaWidth: row.media_width,
    mediaHeight: row.media_height,
    clientMessageId: row.client_message_id,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
  };
}

export function toParticipant(row: ParticipantRow): ConversationParticipant {
  return {
    ownerId: row.owner_id,
    role: row.role,
    lastReadAt: row.last_read_at?.toISOString() ?? null,
  };
}

/** Call end reasons a projected event may carry. */
export type CallEndReason =
  | "hangup"
  | "declined"
  | "missed"
  | "busy"
  | "ice_failed"
  /**
   * Nobody ever said this call ended, so a time bound did.
   *
   * Written by the sweep, never by an event. Distinct from `hangup` because
   * they are different facts — somebody pressed a button, or the record simply
   * outlived any possible call — and only one of them is a completed call.
   */
  | "expired";

/**
 * Derived label for a call, computed from the stored facts rather than a
 * column: `status` would be a second source of truth for `answered_at` and
 * `end_reason`, and would need updating in the same upsert that sets them.
 */
export type CallStatus =
  "ringing" | "active" | "completed" | "missed" | "declined";

export type CallMedia = "audio" | "video";

export interface CallRow {
  id: string;
  conversation_id: string;
  caller_owner_id: string;
  /** NULL for a group call, which has no single person who was called. */
  callee_owner_id: string | null;
  media: CallMedia;
  started_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
  end_reason: CallEndReason | null;
  duration_seconds: number;
  /** Hydrated by the query, not a column — see `listConversationCalls`. */
  participant_owner_ids?: string[];
  joined_owner_ids?: string[];
}

export interface Call {
  id: string;
  conversationId: string;
  callerOwnerId: string;
  /** Null for a group call; read `participantOwnerIds` instead. */
  calleeOwnerId: string | null;
  media: CallMedia;
  status: CallStatus;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: CallEndReason | null;
  durationSeconds: number;
  /** Everyone the call rang, including the caller. Empty for pre-phase-3 rows. */
  participantOwnerIds: string[];
  /** Everyone who was actually on it at any point. A subset of the above. */
  joinedOwnerIds: string[];
}

/** `ringing` never arrives as an event — it exists for a row seen only mid-call. */
export function callStatus(row: CallRow): CallStatus {
  if (!row.ended_at) {
    return row.answered_at ? "active" : "ringing";
  }
  if (row.answered_at) {
    return "completed";
  }
  return row.end_reason === "declined" ? "declined" : "missed";
}

/**
 * The instant a call is no longer believable as live.
 *
 * A call is closed by projecting a `call.ended` event, and that event comes
 * from the process most likely to be the thing that died — so a crashed
 * instance leaves a row that claims a call is in progress for all time, which
 * is precisely what put a Join button on a call that had been over for hours
 * (2026-09-15). The sweep writes this bound durably; applying it at read time
 * too means a reader is never wrong in the window before the sweep runs, and
 * the two agree exactly because they use the same rule.
 */
function expiryOf(startedAt: Date, maxLifetimeSeconds: number): Date {
  return new Date(startedAt.getTime() + maxLifetimeSeconds * 1000);
}

/**
 * Applies that bound to a row that has no ending of its own.
 *
 * Returns the row untouched when it is already closed or still within its
 * lifetime, so the overwhelming majority of reads pay one comparison.
 */
export function settleStaleCall(
  row: CallRow,
  maxLifetimeSeconds: number,
  now: Date = new Date(),
): CallRow {
  if (row.ended_at) return row;
  const expiry = expiryOf(row.started_at, maxLifetimeSeconds);
  if (expiry > now) return row;
  return {
    ...row,
    ended_at: expiry,
    end_reason: "expired",
    // Deliberately not the elapsed time: nobody knows how long they talked,
    // and inventing six hours of call duration would poison every total built
    // on this column.
    duration_seconds: 0,
  };
}

export function toCall(row: CallRow): Call {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    callerOwnerId: row.caller_owner_id,
    calleeOwnerId: row.callee_owner_id,
    participantOwnerIds: row.participant_owner_ids ?? [],
    joinedOwnerIds: row.joined_owner_ids ?? [],
    media: row.media,
    status: callStatus(row),
    startedAt: row.started_at.toISOString(),
    answeredAt: row.answered_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    endReason: row.end_reason,
    durationSeconds: row.duration_seconds,
  };
}
