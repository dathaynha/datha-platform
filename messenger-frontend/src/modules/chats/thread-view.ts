import { computed, effect, type Signal } from "@angular/core";
import { mergeByTime, separatorFor } from "src/helper/thread-timeline";
import { isImageAttachment } from "src/helper/attachment-kind";
import { senderTone } from "src/helper/sender-tone";
import type { CallRecord } from "src/models/call.model";
import type { Conversation, ThreadMessage } from "src/models/messenger.model";
import { ChatStore } from "src/services/implementations/chat-store.service";
import { RealtimeService } from "src/services/implementations/realtime.service";
import type { AvatarFace } from "src/modules/shared/avatar-stack/avatar-stack.component";
import type { GroupMember } from "./components/group-details-dialog/group-details-dialog.component";
import type {
  SeenReader,
  ThreadRow,
} from "./components/thread/thread.component";

export type Presence = "online" | "away" | "offline";

export interface ThreadViewDeps {
  store: ChatStore;
  realtime: RealtimeService;
  /** The conversation this view describes, or null for none. */
  conversationId: () => string | null;
  /**
   * A conversation that does not exist yet, addressed to this person.
   *
   * Only the chats page has drafts — a mini window is opened from a
   * conversation that already exists — so this is optional rather than a
   * concept every caller has to know about.
   */
  draftPeerId?: () => string | null;
}

/** Everything one thread needs to render itself. */
export interface ThreadView {
  conversation: Signal<Conversation | null>;
  title: Signal<string>;
  /** Null for a group, which has no single presence to report. */
  presence: Signal<Presence | null>;
  faces: Signal<readonly AvatarFace[]>;
  memberCount: Signal<number>;
  members: Signal<readonly GroupMember[]>;
  isAdmin: Signal<boolean>;
  callable: Signal<boolean>;
  ongoingCall: Signal<CallRecord | null>;
  loading: Signal<boolean>;
  /** Display names, not owner ids — the thread renders them as written. */
  typists: Signal<readonly string[]>;
  seenBy: Signal<readonly SeenReader[]>;
  rows: Signal<readonly ThreadRow[]>;
}

/** One person's face, resolved from the accounts directory the store holds. */
export function personFace(store: ChatStore, ownerId: string): AvatarFace {
  return {
    ownerId,
    url: store.pictureUrl(ownerId),
    name: store.displayName(ownerId),
    initial: store.initialOf(ownerId),
  };
}

/**
 * The faces of a conversation: the counterpart, or the group's members.
 *
 * A group used to fall back to a letter taken from its title — which is
 * derived from those same members' names, so the one tile that could have
 * shown several people showed a "G" instead.
 *
 * **A group's faces include this user, and are sorted by owner id.** Showing
 * only the *other* members made the picture viewer-relative: in a three-way
 * group every person saw a different pair, so it was not the group's picture
 * at all, it was a picture of everyone-but-you (dathq, 2026-09-14). A group
 * here is a first-class object with a name of its own, and its identity has to
 * look the same to everyone who can see it — which also means the order cannot
 * be the participant list's, since that is not guaranteed stable.
 *
 * A direct thread is the opposite case and keeps the counterpart only: there
 * the tile answers "who is this with", and your own face is not the answer.
 */
export function conversationFaces(
  store: ChatStore,
  conversation: Conversation,
): readonly AvatarFace[] {
  const ownerIds =
    conversation.type === "direct"
      ? [store.counterpart(conversation)]
      : [...conversation.participants]
          .map((participant) => participant.ownerId)
          .sort();
  return ownerIds.map((ownerId) => personFace(store, ownerId));
}

/**
 * Derives one conversation's whole presentation from the store.
 *
 * Written as a factory over a conversation id rather than as a dozen
 * `active…` computeds on the chats page, because **there is more than one
 * thread on screen now**: phase 3 slice 4 docks mini windows over whatever
 * page the user is on, and each is a second, third, complete thread.
 *
 * Copying the page's derivations into the dock was the alternative and it is
 * the mistake this codebase has already paid for twice — the shell's header
 * widget grew its own preview rule and showed a blank line for a call, and
 * every auth fix has had to be applied in four frontends. A merge rule, a run
 * rule, a seen rule and a callable rule that exist twice will disagree, and
 * the disagreement shows up as a bug report months later.
 *
 * Called from a component's field initializer: it opens an `effect`, so it
 * needs an injection context.
 */
export function threadView(deps: ThreadViewDeps): ThreadView {
  const { store, realtime } = deps;
  const draftPeerId = deps.draftPeerId ?? (() => null);

  const presenceOfOwner = (ownerId: string): Presence =>
    realtime.presence().get(ownerId)?.state ?? "offline";

  const presenceOf = (conversation: Conversation): Presence =>
    presenceOfOwner(store.counterpart(conversation));

  const conversation = computed(() =>
    store.conversationById(deps.conversationId()),
  );

  const title = computed(() => {
    const draftPeer = draftPeerId();
    if (draftPeer) return store.displayName(draftPeer);
    const current = conversation();
    return current ? store.conversationTitle(current) : "";
  });

  const presence = computed<Presence | null>(() => {
    const draftPeer = draftPeerId();
    if (draftPeer) return presenceOfOwner(draftPeer);
    const current = conversation();
    if (!current) return "offline";
    // A group reports a member count instead; see `memberCount`.
    if (current.type !== "direct") return null;
    return presenceOf(current);
  });

  const faces = computed<readonly AvatarFace[]>(() => {
    const draftPeer = draftPeerId();
    if (draftPeer) return [personFace(store, draftPeer)];
    const current = conversation();
    return current ? conversationFaces(store, current) : [];
  });

  const memberCount = computed(() => {
    const current = conversation();
    return current?.type === "group" ? current.participants.length : 0;
  });

  const members = computed<readonly GroupMember[]>(() => {
    const current = conversation();
    if (!current) return [];
    const ownerId = store.currentOwnerId();
    return current.participants.map((participant) => ({
      ownerId: participant.ownerId,
      name: store.displayName(participant.ownerId),
      avatarUrl: store.pictureUrl(participant.ownerId),
      initial: store.initialOf(participant.ownerId),
      admin: participant.role === "admin",
      self: participant.ownerId === ownerId,
    }));
  });

  /** Gates the rename and add controls; the server gates the actions. */
  const isAdmin = computed(() => {
    const current = conversation();
    return current ? store.isAdminOf(current) : false;
  });

  const ongoingCall = computed(() =>
    store.ongoingCallOf(deps.conversationId()),
  );

  /**
   * Calling needs a conversation that exists, which a draft does not.
   *
   * There is deliberately no check here against the mesh's size limit:
   * `MAX_CALL_PARTICIPANTS` is realtime-service's configuration and this client
   * does not know it, so copying the number would be a second source of truth
   * that goes stale the day it is tuned. A conversation too big to call is
   * refused at invite time with a message naming both numbers.
   */
  const callable = computed(
    () =>
      draftPeerId() === null &&
      conversation() !== null &&
      // A call is already happening here, so the banner's Join is the action
      // and a second Call button beside it offers to start a rival call —
      // which is what one press used to do (2026-09-15). Messenger, Teams and
      // Slack all replace start with join for exactly this reason.
      ongoingCall() === null,
  );

  const loading = computed(() => store.loadingOf(deps.conversationId()));

  const typists = computed(() =>
    store.typistsOf(deps.conversationId()).map((id) => store.displayName(id)),
  );

  /**
   * Who has read the thread, shown only when **our** message is the newest.
   *
   * A reply is itself proof of reading, so once the other person answers the
   * marker is redundant — and leaving it pinned to the last own message parked
   * "Seen" in the middle of the conversation (reported 2026-09-10).
   */
  const seenBy = computed<readonly SeenReader[]>(() => {
    const current = conversation();
    const messages = store.messagesOf(deps.conversationId());
    const ownerId = store.currentOwnerId();
    const newest = messages[messages.length - 1];
    if (!current || !newest || newest.senderOwnerId !== ownerId) return [];
    if ("pending" in newest && newest.pending) return [];

    return store.readersOf(current, newest).map((readerId) => ({
      ownerId: readerId,
      name: store.displayName(readerId),
      avatarUrl: store.pictureUrl(readerId),
    }));
  });

  /**
   * Merges call history into the message timeline.
   *
   * Client-side rather than folded into `GET /conversations/:id/messages`: the
   * merge is presentation, and changing a route phase 1 already shipped — and
   * its paging contract — to carry a second kind of row is a bigger change
   * than this earns. Worth revisiting if the thread ever pages backwards.
   *
   * Calls carry a **synthetic message anchor** so one sorted list can hold both
   * kinds: the timeline is keyed and ordered by it, and nothing of it renders.
   */
  const withCallRows = (rows: readonly ThreadRow[]): readonly ThreadRow[] => {
    // A call still going on is not history: it renders as the thread's banner
    // instead, and a timeline row for it would sort to whenever it started —
    // which for a long call is a long way from where anyone is looking.
    const calls = store
      .callsOf(deps.conversationId())
      .filter((call) => call.endedAt);
    if (calls.length === 0) return rows;

    const ownerId = store.currentOwnerId();

    const callRows: ThreadRow[] = calls.map((call) => {
      // Attribution is the caller's, never the viewer's: a missed call sits on
      // the side of whoever placed it, which is how the row answers "who
      // called" without a word of extra text.
      const own = call.callerOwnerId === ownerId;
      return {
        message: {
          id: `call:${call.id}`,
          conversationId: call.conversationId,
          senderOwnerId: call.callerOwnerId,
          body: "",
          createdAt: call.startedAt,
        } as ThreadMessage,
        own,
        senderName: store.displayName(call.callerOwnerId),
        startsRun: true,
        endsRun: true,
        showName: false,
        senderTone: senderTone(call.callerOwnerId),
        avatarUrl: own ? "" : store.pictureUrl(call.callerOwnerId),
        separatorAt: null,
        separatorDay: "other",
        call,
      };
    });

    return mergeByTime(rows, callRows);
  };

  const rows = computed<readonly ThreadRow[]>(() => {
    const current = conversation();
    const ownerId = store.currentOwnerId();
    const messages = store.messagesOf(deps.conversationId());

    const isGroup = current?.type === "group";
    const previews = store.attachmentPreviews();
    const aspects = store.attachmentAspects();

    const built = messages.map((message, index) => {
      const previous = messages[index - 1];
      const next = messages[index + 1];
      const own = message.senderOwnerId === ownerId;
      const separator = separatorFor(message.createdAt, previous?.createdAt);
      // A separator ends the run it interrupts — otherwise the message above a
      // "Yesterday" marker stays grouped with the ones below it and loses its
      // avatar to a run it is visually no longer part of.
      const nextSeparated =
        next !== undefined &&
        separatorFor(next.createdAt, message.createdAt).at !== null;
      const startsRun =
        previous?.senderOwnerId !== message.senderOwnerId ||
        separator.at !== null;
      const endsRun =
        next?.senderOwnerId !== message.senderOwnerId || nextSeparated;

      return {
        message,
        own,
        senderName: store.displayName(message.senderOwnerId),
        startsRun,
        endsRun,
        // Only a group needs a name: a direct thread is already titled.
        showName: isGroup && startsRun && !own,
        senderTone: senderTone(message.senderOwnerId),
        avatarUrl: own ? "" : store.pictureUrl(message.senderOwnerId),
        previewUrl: previews.get(message.id) ?? "",
        previewAspect: aspects.get(message.id),
        separatorAt: separator.at,
        separatorDay: separator.day,
      };
    });

    return withCallRows(built);
  });

  // Image attachments resolve as they arrive: the store asks for each link
  // once and ignores everything that is not a picture, so this runs on every
  // thread change without costing a request per render. It belongs to the view
  // rather than to the page, or a picture in a mini window would stay a file
  // card forever.
  effect(() => {
    const conversationId = deps.conversationId();
    const messages = store.messagesOf(conversationId);
    if (!conversationId) return;
    for (const message of messages) {
      if (message.kind !== "attachment") continue;
      if (message.id.startsWith("pending:")) continue;
      if (!isImageAttachment(message.body)) continue;
      void store.ensureAttachmentPreview(
        conversationId,
        message.id,
        message.body,
      );
    }
  });

  return {
    conversation,
    title,
    presence,
    faces,
    memberCount,
    members,
    isAdmin,
    callable,
    ongoingCall,
    loading,
    typists,
    seenBy,
    rows,
  };
}
