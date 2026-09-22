/** Wire shapes as messenger-service and accounts-service return them. */
import type { CallRecord } from "./call.model";

export type ConversationType = "direct" | "group";
export type MessageKind = "text" | "attachment" | "system";

export interface ConversationParticipant {
  ownerId: string;
  role: "member" | "admin";
  /** Read watermark — how far this participant has read. */
  lastReadAt: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  senderOwnerId: string;
  kind: MessageKind;
  body: string;
  attachmentFileId: string | null;
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
  /** The last **message**'s time. The preview's own timestamp, nothing else. */
  lastMessageAt: string | null;
  /**
   * When anything last happened here — a message or a call.
   *
   * What the list sorts on. Separate from `lastMessageAt` because a call is
   * activity but is not a message, and bumping a column named for messages
   * would make its name a lie for every activity type added after it.
   */
  lastActivityAt: string;
  participants: ConversationParticipant[];
  lastMessage: Message | null;
  /** The most recent call, so the preview can say so when it is the newest thing. */
  lastCall: CallRecord | null;
  unread: boolean;
}

/** A user from the accounts-service directory. */
export interface DirectoryUser {
  ownerId: string;
  email: string;
  displayName: string;
  pictureUrl: string;
}

/**
 * A message the client has accepted but the server has not confirmed.
 * `clientMessageId` is the idempotency key, so a retry can never double-post.
 */
export interface PendingMessage extends Message {
  pending: true;
  failed: boolean;
}

export type ThreadMessage = Message | PendingMessage;

export function isPending(message: ThreadMessage): message is PendingMessage {
  return (message as PendingMessage).pending === true;
}
