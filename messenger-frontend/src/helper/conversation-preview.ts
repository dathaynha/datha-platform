import type { CallRecord } from "src/models/call.model";
import type { Conversation } from "src/models/messenger.model";
import { callRowLabel } from "./call-row-label";

/**
 * What a conversation row needs in order to describe itself.
 *
 * Passed in rather than injected so this stays a pure function: the chats page
 * and the shell's header widget are different components with different
 * injectors, and the rule they share is the thing that must not fork.
 */
export interface PreviewContext {
  selfOwnerId: string;
  displayName: (ownerId: string) => string;
  translate: (key: string, params?: Record<string, string>) => string;
}

/**
 * The conversation's last call, when it is newer than its last message.
 *
 * Compared rather than trusted outright: a call from this morning must not
 * caption a conversation somebody has since written in. Ties go to the
 * message, which is the more specific thing to show.
 */
export function newestCall(conversation: Conversation): CallRecord | null {
  const call = conversation.lastCall;
  if (!call) return null;
  const callAt = Date.parse(call.endedAt ?? call.startedAt);
  const messageAt = conversation.lastMessage
    ? Date.parse(conversation.lastMessage.createdAt)
    : Number.NEGATIVE_INFINITY;
  return callAt > messageAt ? call : null;
}

/**
 * The one-line preview under a conversation's title.
 *
 * A group names whoever spoke, which is the convention in WhatsApp, Telegram,
 * Messenger and Slack alike: in a thread with five people, a bare line of text
 * says nothing about who is being replied to. A direct thread needs no name —
 * there is only one other person — so it keeps the arrow that marks your own
 * message instead.
 *
 * **A call can be the newest thing in a conversation** and since 2026-09-16 it
 * moves the row up the list, so the preview has to be able to say so.
 *
 * Shared with the shell's header widget, which had its own one-liner —
 * `lastMessage?.body ?? ""` — and so showed neither an attachment, nor who
 * spoke in a group, nor a call. One conversation row, two answers, and the
 * drift only became visible when calls started reaching the list.
 */
export function conversationPreview(
  conversation: Conversation,
  context: PreviewContext,
): string {
  const call = newestCall(conversation);
  if (call) {
    const label = callRowLabel(call);
    const what = context.translate(label.key, label.params);
    // A group names who placed it, for the same reason a message names who
    // sent it: "Missed call" in a thread of five says nothing about whose.
    if (conversation.type === "group") {
      const who =
        call.callerOwnerId === context.selfOwnerId
          ? context.translate("MESSENGER.GROUP.YOU_PREFIX")
          : context.displayName(call.callerOwnerId);
      return `${who}: ${what}`;
    }
    return what;
  }

  const message = conversation.lastMessage;
  if (!message) return "";
  const own = message.senderOwnerId === context.selfOwnerId;
  // An attachment with no caption is a picture, and a blank line would read as
  // a message that failed to arrive.
  const body =
    message.kind === "attachment" && !message.body ? "\u{1F4CE}" : message.body;
  if (conversation.type === "group") {
    const who = own
      ? context.translate("MESSENGER.GROUP.YOU_PREFIX")
      : context.displayName(message.senderOwnerId);
    return `${who}: ${body}`;
  }
  return own ? `→ ${body}` : body;
}
