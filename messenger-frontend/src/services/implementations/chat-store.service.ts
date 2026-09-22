import {
  computed,
  DestroyRef,
  effect,
  Injectable,
  inject,
  signal,
  untracked,
  type Signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { OAuthService } from "angular-oauth2-oidc";
import { firstValueFrom } from "rxjs";
import type {
  Conversation,
  ConversationParticipant,
  DirectoryUser,
  Message,
  ThreadMessage,
} from "src/models/messenger.model";
import type { CallRecord } from "src/models/call.model";
import type { AttachmentGrant } from "src/models/file-service.model";
import { FileUploadService } from "./file-upload.service";
import { MessengerApiService } from "./messenger-api.service";
import { RealtimeService } from "./realtime.service";
import { WebrtcCallService } from "./webrtc-call.service";
import { ownerIdFromAccessToken } from "src/helper/owner-id";
import { isImageAttachment } from "src/helper/attachment-kind";
import { imageDerivative } from "src/helper/image-derivative";

/**
 * When to refetch a thread's calls after one ends, in ms from the previous
 * attempt. The first is immediate for the common case where the projection has
 * already landed; the rest cover a consumer that is briefly behind.
 */
const CALL_REFRESH_DELAYS_MS = [0, 600, 1500, 3000];

/** Typing frames are cheap but not free; one per this window while typing. */
const TYPING_THROTTLE_MS = 2_000;

/** Owner ids out of a frame payload, ignoring anything that is not a string. */
function ownerIdList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Newest activity first.
 *
 * `lastActivityAt` and not `lastMessageAt`: a call is activity, and sorting on
 * the message time left a conversation exactly where it was after an hour-long
 * call (dathq, 2026-09-16). The server sorts by the same field, so the list
 * does not reshuffle when a fetch lands on top of live frames.
 */
function byRecency(a: Conversation, b: Conversation): number {
  return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
}

/**
 * The chat state the UI renders: conversations, the open thread, and the people
 * behind the owner ids.
 *
 * Two sources feed it and they have different jobs. **REST is truth** —
 * conversations, message pages, and the read watermark all come from
 * messenger-service. **The socket is a delta stream** that keeps what is
 * already on screen live. Anything the socket misses is corrected the next time
 * a list or page is loaded, which is why a dropped frame is not a bug.
 */
@Injectable({ providedIn: "root" })
export class ChatStore {
  private readonly api = inject(MessengerApiService);
  private readonly uploads = inject(FileUploadService);
  private readonly realtime = inject(RealtimeService);
  private readonly calls = inject(WebrtcCallService);
  private readonly oauth = inject(OAuthService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly conversationList = signal<readonly Conversation[]>([]);
  private readonly threads = signal<
    ReadonlyMap<string, readonly ThreadMessage[]>
  >(new Map());
  private readonly callHistory = signal<
    ReadonlyMap<string, readonly CallRecord[]>
  >(new Map());
  /**
   * Image attachments, by message id, ready to paint.
   *
   * Held here rather than on the row because the URL outlives a re-render and
   * must be fetched exactly once: an image bubble that re-minted its SAS link
   * on every change detection would hammer the gateway.
   */
  private readonly previews = signal<ReadonlyMap<string, string>>(new Map());
  /** Grants already asked for, so a failed one is not retried in a loop. */
  private readonly previewsAsked = new Set<string>();
  /**
   * Aspect ratios for image attachments, by message id.
   *
   * The bubble reserves the picture's shape before a byte of it arrives, so a
   * thread does not jump as images resolve — worst while someone is scrolling
   * through history. Only possible because the sender recorded the size.
   */
  private readonly aspects = signal<ReadonlyMap<string, number>>(new Map());
  /** `blob:` URLs this store created and therefore has to release. */
  private readonly ownedPreviews = new Set<string>();
  private readonly activeId = signal<string | null>(null);
  /**
   * Conversations fetched by id, held in their own right rather than looked up
   * in the list. The list is one page ordered by recency, so a thread opened
   * by URL may legitimately not be in it — and `loadConversations` replaces
   * the list wholesale, so a refresh must never make an open thread disappear.
   *
   * Keyed by id rather than held as "the active one" because there is no
   * longer only one open thread: a docked mini window needs exactly the same
   * protection for a conversation the page is not showing.
   */
  private readonly conversationDetails = signal<
    ReadonlyMap<string, Conversation>
  >(new Map());
  /**
   * The person a not-yet-created conversation is addressed to.
   *
   * Picking someone from the directory used to POST a conversation straight
   * away, so a misclick put an empty thread in **both** people's lists
   * (reported 2026-09-10). The row is now created by the first message.
   */
  private readonly draftPeer = signal<string | null>(null);
  private readonly directory = signal<ReadonlyMap<string, DirectoryUser>>(
    new Map(),
  );
  private readonly loadingList = signal(false);
  /**
   * Conversations whose first page is in flight.
   *
   * A set rather than one boolean: a docked mini window is a second open
   * thread, so two can be loading at once, and a single flag let one thread's
   * fetch drive the other thread's skeleton. Keyed by id, so a spinner answers
   * for the thread it is drawn in and nothing else.
   */
  private readonly loadingThreads = signal<ReadonlySet<string>>(new Set());
  private readonly failure = signal<string | null>(null);

  readonly conversations: Signal<readonly Conversation[]> =
    this.conversationList.asReadonly();
  readonly activeConversationId: Signal<string | null> =
    this.activeId.asReadonly();
  readonly loadingConversations: Signal<boolean> =
    this.loadingList.asReadonly();
  readonly error: Signal<string | null> = this.failure.asReadonly();
  readonly people: Signal<ReadonlyMap<string, DirectoryUser>> =
    this.directory.asReadonly();
  /** Owner id a draft is addressed to, or null when none is open. */
  readonly draftPeerId: Signal<string | null> = this.draftPeer.asReadonly();

  readonly activeConversation = computed(() =>
    this.conversationById(this.activeId()),
  );

  /**
   * One conversation by id, or null when it is not loaded.
   *
   * Prefers the list row: it carries the live unread flag and the receipts.
   * Falls back to a detail fetched by id, because a call — or a docked window
   * — can name a conversation the list page has not reached.
   *
   * Reads signals, so it composes inside a `computed`. That is what lets one
   * derivation serve the page and a mini window instead of being written
   * twice.
   */
  conversationById(id: string | null): Conversation | null {
    if (!id) return null;
    const fromList = this.conversationList().find((c) => c.id === id);
    if (fromList) return fromList;
    return this.conversationDetails().get(id) ?? null;
  }

  /** True while this conversation's first page is being fetched. */
  loadingOf(id: string | null): boolean {
    return id !== null && this.loadingThreads().has(id);
  }

  /** One conversation's messages, oldest first, or empty when not loaded. */
  messagesOf(id: string | null): readonly ThreadMessage[] {
    return id ? (this.threads().get(id) ?? []) : [];
  }

  /** Ready-to-paint URLs for image attachments, by message id. */
  readonly attachmentPreviews: Signal<ReadonlyMap<string, string>> =
    this.previews.asReadonly();
  /** Width/height ratios for those pictures, where the sender recorded them. */
  readonly attachmentAspects: Signal<ReadonlyMap<string, number>> =
    this.aspects.asReadonly();

  /** One conversation's calls, for the timeline's system rows. */
  callsOf(id: string | null): readonly CallRecord[] {
    return id ? (this.callHistory().get(id) ?? []) : [];
  }

  /**
   * The call happening in the open thread right now, or null.
   *
   * This is what makes click-to-join possible without a server change: a call
   * becomes a history row the moment somebody joins it, and a row with no
   * `endedAt` is a call still going on. The thread renders it as a banner with
   * a Join button, which is how Messenger does it and is why this replaced the
   * auto-rejoin (dathq, 2026-09-15).
   *
   * A call we are already *in* is excluded: the dock is on screen, and
   * offering Join for it would be offering to join twice.
   */
  ongoingCallOf(id: string | null): CallRecord | null {
    const liveId = this.calls.call()?.callId ?? null;
    const ended = this.endedCalls();
    return (
      this.callsOf(id).find(
        (call) => !call.endedAt && call.id !== liveId && !ended.has(call.id),
      ) ?? null
    );
  }

  /**
   * Owner ids typing in the open thread, excluding this user.
   *
   * realtime-service fans typing out to the whole conversation, sender
   * included, so without this filter you watch yourself type (2026-09-10).
   */
  typistsOf(id: string | null): readonly string[] {
    if (!id) return [];
    return this.realtime
      .typing()
      .filter(
        (entry) =>
          entry.conversationId === id && entry.ownerId !== this.ownerId,
      )
      .map((entry) => entry.ownerId);
  }

  private ownerId = "";
  /**
   * Files behind pending attachment rows, kept outside the signals so a retry
   * can re-upload the same bytes. A `File` is not state to render.
   */
  private readonly pendingFiles = new Map<string, File>();
  /** Newest message id already marked read, per conversation. */
  private readonly lastMarkedRead = new Map<string, string>();
  /** When a typing frame was last sent, per conversation. */
  private readonly lastTypingSentAt = new Map<string, number>();
  /**
   * Which conversation a call belongs to, learned from `call.incoming`.
   *
   * Only that frame carries both ids: `call.participant` and `call.ended` name
   * the call alone, and a bystander watching the banner has to resolve the
   * thread from somewhere. Once a row exists the row itself answers it, so
   * this only covers the window before the first fetch lands.
   */
  private readonly callConversations = new Map<string, string>();
  /**
   * Calls the socket has told us are over.
   *
   * The banner must go the instant `call.ended` arrives, not when the
   * projection catches up: the row is written by messenger-service's JetStream
   * consumer, so for a second or two after a call ends the read model still
   * says `ended_at: null` and the thread offered Join for a call that no longer
   * existed — dathq pressed it (2026-09-15). The socket frame is authoritative
   * and instant; the refetch only settles the history row afterwards.
   */
  private readonly endedCalls = signal<ReadonlySet<string>>(new Set());
  /** Calls whose history refetch is already retrying, so frames do not stack. */
  private readonly callsRefreshing = new Set<string>();

  /**
   * The live call as it was last seen, so its conversation is still known the
   * moment it clears. `call.ended` carries only a call id.
   */
  private lastLiveCall: {
    callId: string | null;
    conversationId: string;
  } | null = null;

  constructor() {
    // A call's history row is written by messenger-service's JetStream
    // consumer, **not** by the socket frame that ends the call — so when the
    // dock clears, the row usually does not exist yet and the thread stayed
    // empty until a manual reload (reported 2026-09-11). Watching the live
    // call rather than the frame is what makes the conversation id available.
    effect(() => {
      const live = this.calls.call();
      if (live) {
        this.lastLiveCall = {
          callId: live.callId,
          conversationId: live.conversationId,
        };
        return;
      }
      const ended = this.lastLiveCall;
      this.lastLiveCall = null;
      if (ended) {
        untracked(() => {
          // "ended", not "present": this call's row has existed since somebody
          // joined it, so waiting for it to appear stops immediately and keeps
          // the open row.
          void this.refreshCalls(ended.conversationId, ended.callId, "ended");
        });
      }
    });

    this.realtime.frames$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((frame) => this.applyFrame(frame.t, frame.d ?? {}));

    // Coming back to the tab is the strongest "I am reading this" signal there
    // is, and `resyncUnread` was already documented as running here — nothing
    // had ever subscribed it.
    if (typeof window !== "undefined") {
      const onForeground = () => {
        if (document.hidden) return;
        void this.realtime.resyncUnread();
        this.markActiveRead();
      };
      window.addEventListener("focus", onForeground);
      document.addEventListener("visibilitychange", onForeground);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener("focus", onForeground);
        document.removeEventListener("visibilitychange", onForeground);
      });
    }

    // Object URLs are a document-lifetime leak until released.
    this.destroyRef.onDestroy(() => {
      for (const url of this.ownedPreviews) URL.revokeObjectURL(url);
      this.ownedPreviews.clear();
    });
  }

  /**
   * Overrides the resolved owner id. Only tests should need this — everything
   * else gets it from `syncOwnerId`, because a caller that forgets leaves the
   * store believing it is nobody. See [[owner-id]].
   */
  setOwnerId(ownerId: string): void {
    this.ownerId = ownerId;
  }

  /**
   * Resolves the owner id from the access token, if it is not known yet.
   *
   * Called from the store's own entry points rather than by its consumers: the
   * header widget loads conversations from login onwards and never set it, so
   * every title resolved against an empty id and both people in a direct
   * conversation saw the same name (2026-09-10).
   */
  syncOwnerId(): void {
    if (this.ownerId) return;
    this.ownerId = ownerIdFromAccessToken(this.oauth.getAccessToken());
  }

  currentOwnerId(): string {
    return this.ownerId;
  }

  async loadConversations(): Promise<void> {
    this.syncOwnerId();
    this.loadingList.set(true);
    try {
      const conversations = await firstValueFrom(this.api.listConversations());
      /*
       * The thread on screen cannot be unread — you are looking at it.
       *
       * A refetch is a full replace, so it also replaces the read state this
       * store has already settled locally. `markReadUpToNewest` writes the
       * watermark asynchronously, and both the chats page and the header
       * widget refetch on mount, so a list request issued while that write is
       * still in flight comes back saying "unread" about the very thread being
       * read — and puts the dot back (dathq, 2026-09-16: "I've read this chat
       * ... there's still a pink dot").
       */
      const open = this.activeId();
      this.conversationList.set(
        [...conversations]
          .map((conversation) =>
            conversation.id === open && conversation.unread
              ? { ...conversation, unread: false }
              : conversation,
          )
          .sort(byRecency),
      );
      this.failure.set(null);
      await this.hydratePeople(conversations);
    } catch {
      this.failure.set("LOAD_FAILED");
    } finally {
      this.loadingList.set(false);
    }
  }

  /**
   * Opens a thread: loads its page, authorizes the socket for its ephemeral
   * frames, and marks it read. The socket subscription is what makes typing
   * indicators work, and it is authorized once here rather than per keystroke.
   */
  /**
   * Loads one thread's call history.
   *
   * Kept beside the messages rather than folded into them: they are two
   * different reads of two different tables, and merging them is the
   * timeline's job, not the store's.
   */
  private async loadCalls(conversationId: string): Promise<void> {
    try {
      const calls = await firstValueFrom(
        this.api.listConversationCalls(conversationId),
      );
      this.callHistory.update((current) => {
        const next = new Map(current);
        next.set(conversationId, calls);
        return next;
      });
      this.touchConversationWithCall(conversationId, calls);
    } catch {
      // A thread without its call rows is still a usable thread.
    }
  }

  /**
   * Moves a conversation up the list for a call, without waiting for a refetch.
   *
   * The server orders on `last_activity_at` and the call projection advances
   * it, but that only reaches an open list on the next `GET /conversations`.
   * Patching here is what makes the reorder happen while you watch, and it
   * uses the same rows the thread already fetched rather than a second call.
   *
   * Forward-only, exactly like the SQL: a late fetch of an older call can
   * never pull a conversation back down.
   */
  private touchConversationWithCall(
    conversationId: string,
    calls: readonly CallRecord[],
  ): void {
    const newest = calls.reduce<CallRecord | null>(
      (best, call) =>
        !best || Date.parse(call.startedAt) > Date.parse(best.startedAt)
          ? call
          : best,
      null,
    );
    if (!newest) return;
    const at = newest.endedAt ?? newest.startedAt;

    this.conversationList.update((list) => {
      const current = list.find((c) => c.id === conversationId);
      if (!current || Date.parse(at) <= Date.parse(current.lastActivityAt)) {
        return list;
      }
      return list
        .map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, lastActivityAt: at, lastCall: newest }
            : conversation,
        )
        .sort(byRecency);
    });
  }

  /**
   * Refetches one thread's call history until the call in question settles.
   *
   * Retries because the write is asynchronous: realtime-service publishes to
   * JetStream and messenger-service's consumer projects the row, so a single
   * immediate fetch loses that race more often than not.
   *
   * `until` is load-bearing and was wrong until 2026-09-15. A call gets its row
   * when somebody **joins** it, so "the row exists" is satisfied the moment a
   * call starts — which means a refresh waiting for a call to *end* stopped on
   * the first fetch, kept the still-open row, and left the ongoing-call banner
   * on screen for a call that was over. `"present"` is for a call that has just
   * begun, `"ended"` for one that has just finished.
   */
  async refreshCalls(
    conversationId: string,
    callId: string | null = null,
    until: "present" | "ended" = "present",
  ): Promise<void> {
    for (const delay of CALL_REFRESH_DELAYS_MS) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      await this.loadCalls(conversationId);
      if (!callId) return;
      const row = (this.callHistory().get(conversationId) ?? []).find(
        (call) => call.id === callId,
      );
      if (row && (until === "present" || row.endedAt)) return;
    }
  }

  /**
   * Remembers that a call is over, so no surface offers a way into it.
   *
   * Kept rather than resolved against the row, because the row is what lags.
   * Bounded by calls seen in one session, and each entry is a uuid.
   */
  private markCallEnded(callId: string): void {
    this.endedCalls.update((current) => {
      if (current.has(callId)) return current;
      const next = new Set(current);
      next.add(callId);
      return next;
    });
  }

  /** The conversation a call is in, from the loaded rows or from its ring. */
  private conversationOfCall(callId: string): string | null {
    for (const [conversationId, calls] of this.callHistory()) {
      if (calls.some((call) => call.id === callId)) return conversationId;
    }
    return this.callConversations.get(callId) ?? null;
  }

  /**
   * Keeps the ongoing-call banner's headcount honest while the call runs.
   *
   * `call.participant` carries the **whole** joined set rather than a delta —
   * core NATS is fire-and-forget, and a client that missed a frame re-syncs
   * from the next one — so the row is replaced rather than incremented. When
   * no row exists yet this is the first person joining a call we were only
   * rung by, and the history is refetched so the banner can appear at all.
   */
  private applyCallParticipants(callId: string, joined: string[]): void {
    let found = false;
    this.callHistory.update((current) => {
      const next = new Map(current);
      for (const [conversationId, calls] of current) {
        if (!calls.some((call) => call.id === callId)) continue;
        found = true;
        next.set(
          conversationId,
          calls.map((call) =>
            call.id === callId ? { ...call, joinedOwnerIds: joined } : call,
          ),
        );
      }
      return found ? next : current;
    });
    if (found) return;

    const conversationId = this.callConversations.get(callId);
    if (!conversationId || this.callsRefreshing.has(callId)) return;
    this.callsRefreshing.add(callId);
    void this.refreshCalls(conversationId, callId).finally(() => {
      this.callsRefreshing.delete(callId);
    });
  }

  /**
   * Who is currently showing each open conversation.
   *
   * The socket subscription is **shared**, and until phase 3 slice 4 there was
   * only ever one holder, so opening one thread simply closed the last. A
   * docked mini window breaks that assumption in both directions: the page and
   * a dock can show the same thread, where the first to close would have
   * unsubscribed the other and silently stopped its typing indicators and live
   * messages; and two docks can show different threads, which the old code
   * could not represent at all. Refcounted, so `conversation.open` is sent
   * once and `conversation.close` only when the last holder lets go.
   */
  private readonly threadHolders = new Map<string, Set<string>>();

  /** The chats page's holder key — it has exactly one open thread. */
  private static readonly PAGE_HOLDER = "page";

  private acquireThread(conversationId: string, holder: string): void {
    const holders = this.threadHolders.get(conversationId);
    if (holders) {
      holders.add(holder);
      return;
    }
    this.threadHolders.set(conversationId, new Set([holder]));
    this.realtime.openConversation(conversationId);
  }

  private releaseThread(conversationId: string, holder: string): void {
    const holders = this.threadHolders.get(conversationId);
    if (!holders) return;
    holders.delete(holder);
    if (holders.size > 0) return;
    this.threadHolders.delete(conversationId);
    this.realtime.closeConversation(conversationId);
  }

  /**
   * Opens a thread for one holder: subscribes the socket, loads the page and
   * the call history, and marks it read.
   *
   * `holder` is the surface showing it — the page, or a dock keyed by
   * conversation. Two surfaces showing one conversation is normal and costs
   * one subscription.
   */
  async openThread(conversationId: string, holder: string): Promise<void> {
    this.syncOwnerId();
    this.acquireThread(conversationId, holder);
    // Fire and forget: a thread whose call history cannot be fetched still
    // shows its messages, which is the part that matters.
    void this.loadCalls(conversationId);
    const loaded = await this.ensureThreadLoaded(conversationId);
    if (!loaded) return;
    await this.markReadUpToNewest(conversationId);
  }

  /** Lets one holder go; the subscription survives while another remains. */
  closeThread(conversationId: string, holder: string): void {
    this.releaseThread(conversationId, holder);
  }

  /**
   * Fetches what a thread needs to render, once. Returns false when the fetch
   * failed and the caller should not go on to mark it read.
   *
   * Covers the *whole* open, not just the message page. Flagged only around
   * the messages fetch, a thread whose conversation was still loading fell
   * through to "No messages yet" — an empty thread, not a loading one
   * (reported 2026-09-10).
   */
  private async ensureThreadLoaded(conversationId: string): Promise<boolean> {
    const loadedAlready = this.threads().has(conversationId);
    if (!loadedAlready) this.beginLoading(conversationId);

    // The thread must not depend on the list already containing it: opening a
    // conversation by URL, or one created a moment ago while a list refresh was
    // in flight, would otherwise render an empty pane. REST is truth, so ask.
    const known = this.conversationList().find((c) => c.id === conversationId);
    if (known) {
      this.setDetail(known);
    } else {
      try {
        const conversation = await firstValueFrom(
          this.api.getConversation(conversationId),
        );
        this.setDetail(conversation);
        this.upsertConversation(conversation);
        await this.hydratePeople([conversation]);
      } catch {
        this.failure.set("LOAD_FAILED");
        this.endLoading(conversationId);
        return false;
      }
    }

    if (!loadedAlready) {
      try {
        const page = await firstValueFrom(
          this.api.listMessages(conversationId),
        );
        // The API returns newest first; the thread renders oldest first.
        this.setThread(conversationId, [...page.messages].reverse());
      } catch {
        this.failure.set("LOAD_FAILED");
      } finally {
        this.endLoading(conversationId);
      }
    }
    return true;
  }

  private beginLoading(conversationId: string): void {
    this.loadingThreads.update((current) =>
      new Set(current).add(conversationId),
    );
  }

  private endLoading(conversationId: string): void {
    this.loadingThreads.update((current) => {
      if (!current.has(conversationId)) return current;
      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
  }

  /** Remembers a conversation fetched by id, so a list refresh cannot lose it. */
  private setDetail(conversation: Conversation): void {
    this.conversationDetails.update((current) =>
      new Map(current).set(conversation.id, conversation),
    );
  }

  /** Patches a held detail in place, when one exists for that conversation. */
  private patchDetail(
    conversationId: string,
    patch: (conversation: Conversation) => Conversation,
  ): void {
    this.conversationDetails.update((current) => {
      const detail = current.get(conversationId);
      if (!detail) return current;
      return new Map(current).set(conversationId, patch(detail));
    });
  }

  /** Opens a thread on the chats page, which shows one at a time. */
  async openConversation(conversationId: string): Promise<void> {
    const previous = this.activeId();
    if (previous && previous !== conversationId) {
      this.releaseThread(previous, ChatStore.PAGE_HOLDER);
    }
    this.activeId.set(conversationId);
    await this.openThread(conversationId, ChatStore.PAGE_HOLDER);
  }

  closeActiveConversation(): void {
    const id = this.activeId();
    if (id) this.releaseThread(id, ChatStore.PAGE_HOLDER);
    this.activeId.set(null);
    this.draftPeer.set(null);
  }

  /**
   * The existing direct conversation with someone, or null.
   *
   * Picking a person you already talk to must open that thread, not an empty
   * draft — the draft looked like the history had been lost (reported
   * 2026-09-11). Only the loaded page is searched; an older thread still
   * resolves to the same conversation on the first message, because
   * `createDirectConversation` is idempotent on the participant pair.
   */
  directConversationWith(peerOwnerId: string): string | null {
    this.syncOwnerId();
    const self = this.ownerId;
    const match = this.conversationList().find(
      (conversation) =>
        conversation.type === "direct" &&
        conversation.participants.length === 2 &&
        conversation.participants.some((p) => p.ownerId === peerOwnerId) &&
        conversation.participants.some((p) => p.ownerId === self),
    );
    return match?.id ?? null;
  }

  /**
   * Addresses a new conversation to someone without creating it.
   *
   * Nothing is written until the first message, so leaving the draft costs
   * nothing and the other person is not shown an empty thread.
   */
  async openDraft(peerOwnerId: string): Promise<void> {
    this.syncOwnerId();
    const previous = this.activeId();
    if (previous) this.releaseThread(previous, ChatStore.PAGE_HOLDER);
    this.activeId.set(null);
    this.draftPeer.set(peerOwnerId);

    // The header needs a name, and a draft opened by URL has no conversation
    // to hydrate people from.
    await this.ensurePerson(peerOwnerId);
    this.realtime.subscribePresence([peerOwnerId]);
  }

  /**
   * Creates the conversation and posts the first message into it.
   *
   * `createDirectConversation` is idempotent on the sorted participant pair, so
   * a double submit resolves to the same conversation rather than two.
   */
  async sendFirstMessage(
    peerOwnerId: string,
    body: string,
  ): Promise<string | null> {
    if (!body.trim()) return null;
    const conversationId = await this.startDirectConversation(peerOwnerId);
    if (!conversationId) return null;
    this.draftPeer.set(null);
    await this.sendMessage(conversationId, body);
    return conversationId;
  }

  /** The attachment equivalent of sendFirstMessage. */
  async sendFirstAttachment(
    peerOwnerId: string,
    file: File,
  ): Promise<string | null> {
    const conversationId = await this.startDirectConversation(peerOwnerId);
    if (!conversationId) return null;
    this.draftPeer.set(null);
    await this.sendAttachment(conversationId, file);
    return conversationId;
  }

  /**
   * Sends optimistically. The message is rendered immediately with a pending
   * flag and reconciled by `clientMessageId` when the server answers — the same
   * key that makes a retry idempotent server-side, so a failed send can be
   * retried without any risk of double-posting.
   */
  async sendMessage(conversationId: string, body: string): Promise<void> {
    const text = body.trim();
    if (!text) return;

    const clientMessageId = crypto.randomUUID();
    const optimistic: ThreadMessage = {
      id: `pending:${clientMessageId}`,
      conversationId,
      senderOwnerId: this.ownerId,
      kind: "text",
      body: text,
      attachmentFileId: null,
      clientMessageId,
      createdAt: new Date().toISOString(),
      editedAt: null,
      pending: true,
      failed: false,
    };
    this.appendToThread(conversationId, optimistic, true);
    this.realtime.stopTyping(conversationId);

    try {
      const saved = await firstValueFrom(
        this.api.sendMessage(conversationId, { clientMessageId, body: text }),
      );
      this.replaceByClientId(conversationId, clientMessageId, saved);
      this.touchConversation(conversationId, saved);
    } catch {
      this.markSendFailed(conversationId, clientMessageId);
    }
  }

  /** Retries a failed send with its original id, so the server dedupes it. */
  async retryMessage(
    conversationId: string,
    clientMessageId: string,
  ): Promise<void> {
    const existing = (this.threads().get(conversationId) ?? []).find(
      (message) => message.clientMessageId === clientMessageId,
    );
    if (!existing) return;

    this.updateInThread(conversationId, clientMessageId, {
      pending: true,
      failed: false,
    });

    // An attachment retry re-runs the upload: the bytes may never have reached
    // Blob, and the file id is what the message needs.
    const file = this.pendingFiles.get(clientMessageId);
    if (file) {
      await this.uploadAndSend(conversationId, clientMessageId, file);
      return;
    }

    try {
      const saved = await firstValueFrom(
        this.api.sendMessage(conversationId, {
          clientMessageId,
          body: existing.body,
        }),
      );
      this.replaceByClientId(conversationId, clientMessageId, saved);
      this.touchConversation(conversationId, saved);
    } catch {
      this.markSendFailed(conversationId, clientMessageId);
    }
  }

  /**
   * Sends a file: uploaded first, then referenced by id in the message.
   *
   * The row appears immediately with the filename, so the thread reflects what
   * the user did rather than waiting on Azure. The message body carries the
   * filename — that is the contract that lets a recipient render the bubble
   * without a metadata round trip, since file-service would refuse them the
   * file's metadata anyway.
   */
  async sendAttachment(conversationId: string, file: File): Promise<void> {
    const clientMessageId = crypto.randomUUID();
    this.pendingFiles.set(clientMessageId, file);

    // Your own picture is on screen before the upload starts: the bytes are
    // already here, so waiting for Azure and a SAS link to show them back to
    // you would be a round trip for nothing.
    if (isImageAttachment(file.name)) {
      const local = URL.createObjectURL(file);
      this.ownedPreviews.add(local);
      this.setPreview(`pending:${clientMessageId}`, local);
      this.previewsAsked.add(`pending:${clientMessageId}`);
    }

    this.appendToThread(
      conversationId,
      {
        id: `pending:${clientMessageId}`,
        conversationId,
        senderOwnerId: this.ownerId,
        kind: "attachment",
        body: file.name,
        attachmentFileId: null,
        clientMessageId,
        createdAt: new Date().toISOString(),
        editedAt: null,
        pending: true,
        failed: false,
      },
      true,
    );

    await this.uploadAndSend(conversationId, clientMessageId, file);
  }

  private async uploadAndSend(
    conversationId: string,
    clientMessageId: string,
    file: File,
  ): Promise<void> {
    try {
      // A downscaled copy travels with the picture, because nobody downstream
      // can make one: file-service does not read blob content and this app is
      // the only place the bytes ever exist uncompressed. A failure here costs
      // the thumbnail, never the message.
      const derivative = isImageAttachment(file.name)
        ? await imageDerivative(file).catch(() => null)
        : null;

      if (derivative) {
        this.setAspect(
          `pending:${clientMessageId}`,
          derivative.width / derivative.height,
        );
      }

      const fileId = await this.uploads.upload(file);
      const thumbnailFileId = derivative?.thumbnail
        ? await this.uploads.upload(derivative.thumbnail).catch(() => null)
        : null;

      const saved = await firstValueFrom(
        this.api.sendMessage(conversationId, {
          clientMessageId,
          body: file.name,
          attachmentFileId: fileId,
          ...(thumbnailFileId ? { thumbnailFileId } : {}),
          ...(derivative
            ? { mediaWidth: derivative.width, mediaHeight: derivative.height }
            : {}),
        }),
      );
      // The local object URL follows the row to its server id, so the picture
      // never blinks out and is re-fetched over the network.
      const local = this.previews().get(`pending:${clientMessageId}`);
      if (local) {
        this.setPreview(saved.id, local);
        this.previewsAsked.add(saved.id);
      }
      const ratio = this.aspects().get(`pending:${clientMessageId}`);
      if (ratio) this.setAspect(saved.id, ratio);
      this.replaceByClientId(conversationId, clientMessageId, saved);
      this.touchConversation(conversationId, saved);
      this.pendingFiles.delete(clientMessageId);
    } catch {
      // Upload or send failed; the row stays, retryable with the same
      // client id, so a retry can never post the message twice.
      this.markSendFailed(conversationId, clientMessageId);
    }
  }

  private setPreview(messageId: string, url: string): void {
    this.previews.update((current) => new Map(current).set(messageId, url));
  }

  private setAspect(messageId: string, ratio: number): void {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    this.aspects.update((current) => new Map(current).set(messageId, ratio));
  }

  /**
   * Resolves an image attachment so the thread can show it instead of listing
   * it.
   *
   * The link is short-lived, which is why opening an attachment mints one on
   * click. A picture is different: it is fetched the moment the bubble is on
   * screen and the bytes are then in the browser's cache, so expiry only
   * matters for a thread left open for hours — and a stale URL fails the
   * `<img>`, which falls back to the file card rather than breaking.
   */
  async ensureAttachmentPreview(
    conversationId: string,
    messageId: string,
    name: string,
  ): Promise<void> {
    if (!isImageAttachment(name)) return;
    if (this.previewsAsked.has(messageId)) return;
    this.previewsAsked.add(messageId);
    try {
      const grant = await this.attachmentGrant(conversationId, messageId);
      // The thumbnail is the point: painting a 288px box from a 12 MB original
      // is what this replaced. The original is fetched only when opened.
      this.setPreview(messageId, grant.thumbnailUrl ?? grant.downloadUrl);
      if (grant.width && grant.height) {
        this.setAspect(messageId, grant.width / grant.height);
      }
    } catch {
      // No picture: the bubble stays the file card it already was.
    }
  }

  /**
   * Mints a fresh link for a picture whose URL stopped working.
   *
   * A signed link expires, and every mainstream client answers that by asking
   * for another one rather than degrading the bubble — degrading is the last
   * resort, after a retry has also failed. Local `blob:` previews are never
   * retried: they do not expire, so a failure there is the file itself.
   */
  async refreshAttachmentPreview(
    conversationId: string,
    messageId: string,
    name: string,
  ): Promise<void> {
    const current = this.previews().get(messageId);
    if (current?.startsWith("blob:")) return;
    this.previewsAsked.delete(messageId);
    this.previews.update((map) => {
      const next = new Map(map);
      next.delete(messageId);
      return next;
    });
    await this.ensureAttachmentPreview(conversationId, messageId, name);
  }

  /** A short-lived URL for an attachment, fetched when the user asks for it. */
  attachmentGrant(
    conversationId: string,
    messageId: string,
  ): Promise<AttachmentGrant> {
    return firstValueFrom(this.api.attachmentGrant(conversationId, messageId));
  }

  /**
   * Marks the open thread read because the user is demonstrably reading it.
   *
   * Opening a thread was the only trigger, and inbound messages were only
   * marked when `document.hasFocus()` happened to be true **at the instant the
   * frame arrived** — with no listener to re-check later. So a message that
   * landed while the window was in the background stayed unread while you
   * clicked in, focused the box and typed; only sending cleared it
   * (reported 2026-09-10).
   */
  markActiveRead(): void {
    this.markRead(this.activeId());
  }

  /**
   * Marks one thread read because the user is demonstrably reading it — the
   * page's open thread, or a docked window they are typing into.
   */
  markRead(conversationId: string | null): void {
    if (!conversationId) return;
    if (typeof document !== "undefined" && document.hidden) return;
    void this.markReadUpToNewest(conversationId);
  }

  /**
   * Tells the conversation this user is typing, at most once per window.
   *
   * The throttle lives here rather than in the composer's host because there
   * is more than one composer now: a docked mini window types into a different
   * thread than the page does, and a single timer on one component throttled
   * them against each other. Keyed by conversation, which is the thing being
   * rate limited.
   */
  notifyTyping(conversationId: string): void {
    const now = Date.now();
    const last = this.lastTypingSentAt.get(conversationId) ?? 0;
    if (now - last < TYPING_THROTTLE_MS) return;
    this.lastTypingSentAt.set(conversationId, now);
    this.realtime.startTyping(conversationId);
  }

  /** Takes this user's indicator off the other person's screen at once. */
  stopTyping(conversationId: string): void {
    // Not throttled, and the next keystroke must send again: this is the frame
    // that clears the indicator, so delaying it is the bug.
    this.lastTypingSentAt.delete(conversationId);
    this.realtime.stopTyping(conversationId);
  }

  /** Creates (or finds) the direct thread with someone and opens it. */
  async startDirectConversation(otherOwnerId: string): Promise<string | null> {
    try {
      const conversation = await firstValueFrom(
        this.api.createDirectConversation(otherOwnerId),
      );
      this.upsertConversation(conversation);
      await this.hydratePeople([conversation]);
      await this.openConversation(conversation.id);
      return conversation.id;
    } catch {
      this.failure.set("CREATE_FAILED");
      return null;
    }
  }

  /**
   * Creates a group and opens it.
   *
   * Unlike a direct thread there is no draft state to defer the write into: a
   * group has no natural identity until it exists, so the conversation is
   * created up front and the members see it immediately.
   */
  async startGroupConversation(
    participantOwnerIds: readonly string[],
    title: string,
  ): Promise<string | null> {
    try {
      const conversation = await firstValueFrom(
        this.api.createGroupConversation(participantOwnerIds, title),
      );
      this.upsertConversation(conversation);
      await this.hydratePeople([conversation]);
      await this.openConversation(conversation.id);
      return conversation.id;
    } catch {
      this.failure.set("CREATE_FAILED");
      return null;
    }
  }

  /** Renames a group. Admin-only server-side; a member gets 403 and false. */
  async renameConversation(
    conversationId: string,
    title: string,
  ): Promise<boolean> {
    try {
      const conversation = await firstValueFrom(
        // An empty box means "no title", which is null on the wire — not "",
        // which the server would store and the list would render as blank.
        this.api.renameConversation(conversationId, title.trim() || null),
      );
      this.upsertConversation(conversation);
      this.setDetail(conversation);
      return true;
    } catch {
      return false;
    }
  }

  /** Adds people to a group. Admin-only server-side. */
  async addParticipants(
    conversationId: string,
    ownerIds: readonly string[],
  ): Promise<boolean> {
    if (ownerIds.length === 0) return true;
    try {
      const participants = await firstValueFrom(
        this.api.addParticipants(conversationId, ownerIds),
      );
      this.applyParticipants(conversationId, participants);
      // New members are strangers to the directory until asked for, so the
      // member list would render raw owner ids without this.
      const conversation = this.conversationList().find(
        (c) => c.id === conversationId,
      );
      if (conversation) await this.hydratePeople([conversation]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Leaves a group and drops it from the list.
   *
   * The row is removed locally rather than by refetching: the server has
   * already stopped returning it, so a reload would be a second round trip to
   * learn what the 204 just said.
   */
  async leaveConversation(conversationId: string): Promise<boolean> {
    try {
      await firstValueFrom(this.api.leaveConversation(conversationId));
      this.conversationList.update((list) =>
        list.filter((c) => c.id !== conversationId),
      );
      if (this.activeId() === conversationId) this.closeActiveConversation();
      return true;
    } catch {
      return false;
    }
  }

  /** Replaces a conversation's participant list in both places it is held. */
  private applyParticipants(
    conversationId: string,
    participants: readonly ConversationParticipant[],
  ): void {
    const apply = (conversation: Conversation): Conversation => ({
      ...conversation,
      participants: [...participants],
    });
    this.conversationList.update((list) =>
      list.map((c) => (c.id === conversationId ? apply(c) : c)),
    );
    this.patchDetail(conversationId, apply);
  }

  /** This user's role in a conversation; admin gates rename and add. */
  isAdminOf(conversation: Conversation): boolean {
    return (
      conversation.participants.find((p) => p.ownerId === this.ownerId)
        ?.role === "admin"
    );
  }

  searchDirectory(query: string): Promise<DirectoryUser[]> {
    return firstValueFrom(this.api.searchDirectory(query));
  }

  /**
   * Loads one person into the directory if they are not already there.
   *
   * Needed wherever an owner id turns up without a conversation behind it: a
   * draft opened by URL, and an **incoming call** from someone you have never
   * had a thread with — which otherwise rang as `google_1020390…` instead of a
   * name (reported 2026-09-10).
   */
  async ensurePerson(ownerId: string): Promise<void> {
    if (!ownerId || this.directory().has(ownerId)) return;
    try {
      const users = await firstValueFrom(this.api.lookupUsers([ownerId]));
      // Same reference when the directory learned nothing, which it does
      // whenever the lookup cannot resolve an owner — a deleted account, or
      // someone who has never signed in. A fresh Map every time made the
      // signal emit on a no-op, and any effect that calls this while tracking
      // `directory` then re-ran, asked again, and emitted again: 2187 lookups
      // in three seconds, measured 2026-09-17.
      if (users.length === 0) return;
      this.directory.update((current) => {
        const next = new Map(current);
        for (const user of users) next.set(user.ownerId, user);
        return next;
      });
    } catch {
      // Falls back to the raw id, exactly as an unavailable directory does.
    }
  }

  /**
   * An owner's initial for an avatar tile, or "" when nothing is known.
   *
   * Never derived from `displayName`, because that falls back to the owner id
   * and every id starts `google_` — so everyone's initial came out "G".
   */
  initialOf(ownerId: string): string {
    const name = this.directory().get(ownerId)?.displayName ?? "";
    return name.trim().charAt(0).toUpperCase();
  }

  /** Display label for an owner: directory name, else the id itself. */
  displayName(ownerId: string): string {
    return this.directory().get(ownerId)?.displayName ?? ownerId;
  }

  pictureUrl(ownerId: string): string {
    return this.directory().get(ownerId)?.pictureUrl ?? "";
  }

  /** The other side of a direct thread; the first other participant of a group. */
  counterpart(conversation: Conversation): string {
    return (
      conversation.participants.find((p) => p.ownerId !== this.ownerId)
        ?.ownerId ?? this.ownerId
    );
  }

  conversationTitle(conversation: Conversation): string {
    if (conversation.title) return conversation.title;
    if (conversation.type === "direct") {
      return this.displayName(this.counterpart(conversation));
    }
    return conversation.participants
      .filter((p) => p.ownerId !== this.ownerId)
      .map((p) => this.displayName(p.ownerId))
      .join(", ");
  }

  /** Has everyone else read up to this message? Drives the read tick. */
  /**
   * Participants other than this user who have read as far as `message`.
   *
   * Per-reader rather than a boolean, because read state is rendered as the
   * readers' avatars — which is also the only shape that says anything useful
   * in a group.
   */
  readersOf(conversation: Conversation, message: Message): readonly string[] {
    const sentAt = Date.parse(message.createdAt);
    return conversation.participants
      .filter(
        (participant) =>
          participant.ownerId !== this.ownerId &&
          participant.lastReadAt !== null &&
          Date.parse(participant.lastReadAt) >= sentAt,
      )
      .map((participant) => participant.ownerId);
  }

  private applyFrame(type: string, payload: Record<string, unknown>): void {
    const conversationId = String(payload["conversation_id"] ?? "");

    switch (type) {
      case "message.new": {
        const message = payload["message"] as Message | undefined;
        if (!message || !conversationId) return;
        this.appendToThread(conversationId, message);
        this.touchConversation(conversationId, message);
        // Still gated on focus: a visible tab behind another application is
        // not being read. What was missing is the *other* half — nothing ever
        // re-checked once focus came back. The constructor's listener does
        // that now, and so do composer focus and typing.
        if (conversationId === this.activeId() && document.hasFocus()) {
          this.markActiveRead();
        }
        return;
      }

      case "receipt.read": {
        const ownerId = String(payload["owner_id"] ?? "");
        const lastReadAt = String(payload["last_read_at"] ?? "");
        if (!conversationId || !ownerId || !lastReadAt) return;
        this.applyReceipt(conversationId, ownerId, lastReadAt);
        return;
      }

      case "call.incoming": {
        /*
         * The one call frame that names its conversation. Remembered so a
         * later `call.participant` — which carries only a call id — can find
         * the thread whose banner it belongs to, and refetched so the banner
         * appears for someone who let the call ring out rather than declining
         * it (whose dock clearing would have refreshed it anyway).
         */
        const callId = String(payload["call_id"] ?? "");
        if (!conversationId || !callId) return;
        this.callConversations.set(callId, conversationId);
        return;
      }

      case "call.participant": {
        const callId = String(payload["call_id"] ?? "");
        if (!callId) return;
        this.applyCallParticipants(
          callId,
          ownerIdList(payload["participants"]),
        );
        return;
      }

      case "call.ended": {
        // Fanned out to everyone *invited*, so a bystander watching the banner
        // is told too. The banner goes **now**, on the frame — waiting for the
        // projection left a Join button pointing at a dead call.
        const callId = String(payload["call_id"] ?? "");
        if (!callId) return;
        const known = this.conversationOfCall(callId);
        this.markCallEnded(callId);
        this.callConversations.delete(callId);
        if (known) void this.refreshCalls(known, callId, "ended");
        return;
      }

      case "conversation.created":
        // Someone started a thread with this user: the list is the source of
        // truth for its shape, so refetch rather than invent a row.
        void this.loadConversations();
        return;

      default:
        return;
    }
  }

  private async markReadUpToNewest(conversationId: string): Promise<void> {
    const messages = this.threads().get(conversationId) ?? [];
    const newest = [...messages]
      .reverse()
      .find((message) => !("pending" in message) || !message.pending);
    if (!newest) return;
    /*
     * Clearing the flag comes first, and is deliberately *not* behind the
     * dedupe below.
     *
     * The guard exists to stop every keystroke re-POSTing the same watermark.
     * It used to skip this line too, which made a restored dot permanent: once
     * a refetch had put `unread` back on a thread whose newest message was
     * already marked, nothing could take it off again until somebody sent
     * another message. Local state is cheap to reconcile; the network write is
     * the only thing worth deduping.
     */
    this.conversationList.update((list) =>
      list.map((c) =>
        c.id === conversationId && c.unread ? { ...c, unread: false } : c,
      ),
    );

    // Idempotent, because this is now driven by focus and by typing as well as
    // by opening: without it every keystroke would POST the same watermark.
    if (this.lastMarkedRead.get(conversationId) === newest.id) return;
    this.lastMarkedRead.set(conversationId, newest.id);

    // Tells the other side at once; the durable write follows.
    this.realtime.markConversationRead(conversationId);
    try {
      await firstValueFrom(this.api.markRead(conversationId, newest.id));
    } catch {
      // A failed watermark write is corrected on the next open; the local set
      // is already right, so there is nothing to show the user.
    }
  }

  private applyReceipt(
    conversationId: string,
    ownerId: string,
    lastReadAt: string,
  ): void {
    const patchParticipants = (conversation: Conversation): Conversation => ({
      ...conversation,
      participants: conversation.participants.map((participant) =>
        participant.ownerId === ownerId
          ? { ...participant, lastReadAt }
          : participant,
      ),
    });

    this.patchDetail(conversationId, patchParticipants);

    this.conversationList.update((list) =>
      list.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        return {
          ...conversation,
          participants: conversation.participants.map((participant) =>
            participant.ownerId === ownerId
              ? { ...participant, lastReadAt }
              : participant,
          ),
        };
      }),
    );
  }

  /**
   * Installs a fetched page, keeping anything still in flight.
   *
   * A plain overwrite dropped anything that happened after the page was
   * requested: send a message or attach a file while the first page is still
   * loading and the row vanished when the page landed — the request had been
   * issued before that message existed, so it is legitimately absent from the
   * response. Surfaced as an attachment spec that only failed under load
   * (2026-09-10), where the sidebar showed the file as the latest message
   * while the thread did not contain it at all.
   *
   * Keeping *pending* rows is not enough: by the time the page lands the row
   * may already have been confirmed by its own POST.
   */
  private setThread(
    conversationId: string,
    messages: readonly ThreadMessage[],
  ): void {
    const fetchedIds = new Set(messages.map((message) => message.id));
    const fetchedClientIds = new Set(
      messages.map((message) => message.clientMessageId),
    );
    const local = (this.threads().get(conversationId) ?? []).filter(
      (message) =>
        !fetchedIds.has(message.id) &&
        !fetchedClientIds.has(message.clientMessageId),
    );

    this.threads.update((current) => {
      const next = new Map(current);
      next.set(
        conversationId,
        local.length === 0
          ? messages
          : [...messages, ...local].sort(
              (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
            ),
      );
      return next;
    });
  }

  /**
   * @param local `true` for something this user just did.
   *
   * An inbound frame for a thread nobody is looking at is dropped: opening it
   * will fetch the page anyway.
   *
   * Two cases must **not** be dropped, and both are the same race — the page
   * was requested before the message existed, so the response cannot contain
   * it, and discarding the row loses it until a reload:
   *
   * - the user's **own** send (`local`), which showed up as an attachment
   *   landing in the sidebar as the latest message while the thread never
   *   displayed it at all;
   * - anything for the **open** conversation, whose first page may still be in
   *   flight. That one lost inbound messages outright, and surfaced as a
   *   read-receipt spec failing 2 runs in 12 with the thread holding only its
   *   original message.
   *
   * Both found 2026-09-10. `setThread` merges whatever this leaves behind.
   */
  private appendToThread(
    conversationId: string,
    message: ThreadMessage,
    local = false,
  ): void {
    const keep = local || this.activeId() === conversationId;
    const existing = this.threads().get(conversationId) ?? (keep ? [] : null);
    if (!existing) return;

    // The sender's own socket echoes the message it just posted: match on the
    // idempotency key so the optimistic row is replaced, not duplicated.
    //
    // The key includes the sender, mirroring the server's unique index on
    // (conversation, sender, client_message_id). Matching on the client id
    // alone would let one participant's id collide with another's and replace
    // somebody else's message in the thread.
    const alreadyThere = existing.some(
      (candidate) =>
        candidate.id === message.id ||
        (message.clientMessageId !== "" &&
          candidate.clientMessageId === message.clientMessageId &&
          candidate.senderOwnerId === message.senderOwnerId),
    );
    if (alreadyThere) {
      this.replaceByClientId(
        conversationId,
        message.clientMessageId,
        message as Message,
      );
      return;
    }
    this.setThread(conversationId, [...existing, message]);
  }

  private replaceByClientId(
    conversationId: string,
    clientMessageId: string,
    saved: Message,
  ): void {
    const existing = this.threads().get(conversationId);
    if (!existing) return;
    this.setThread(
      conversationId,
      existing.map((message) =>
        message.clientMessageId === clientMessageId &&
        message.senderOwnerId === saved.senderOwnerId
          ? saved
          : message,
      ),
    );
  }

  private updateInThread(
    conversationId: string,
    clientMessageId: string,
    patch: Partial<ThreadMessage>,
  ): void {
    const existing = this.threads().get(conversationId);
    if (!existing) return;
    this.setThread(
      conversationId,
      existing.map((message) =>
        message.clientMessageId === clientMessageId
          ? ({ ...message, ...patch } as ThreadMessage)
          : message,
      ),
    );
  }

  private markSendFailed(
    conversationId: string,
    clientMessageId: string,
  ): void {
    this.updateInThread(conversationId, clientMessageId, {
      pending: true,
      failed: true,
    });
  }

  private touchConversation(conversationId: string, message: Message): void {
    this.patchDetail(conversationId, (detail) => ({
      ...detail,
      lastMessage: message,
      lastMessageAt: message.createdAt,
      lastActivityAt: message.createdAt,
    }));

    this.conversationList.update((list) =>
      [...list]
        .map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                lastMessage: message,
                lastMessageAt: message.createdAt,
                lastActivityAt: message.createdAt,
                unread:
                  conversation.id === this.activeId()
                    ? false
                    : message.senderOwnerId !== this.ownerId,
              }
            : conversation,
        )
        .sort(byRecency),
    );
  }

  private upsertConversation(conversation: Conversation): void {
    this.conversationList.update((list) => {
      const without = list.filter((c) => c.id !== conversation.id);
      return [conversation, ...without].sort(byRecency);
    });
  }

  /** Resolves owner ids to names in one batch, then subscribes to presence. */
  private async hydratePeople(
    conversations: readonly Conversation[],
  ): Promise<void> {
    const known = this.directory();
    const missing = [
      ...new Set(
        conversations
          .flatMap((conversation) =>
            conversation.participants.map((p) => p.ownerId),
          )
          // Self included: a group's member list names everyone in it, and
          // this user's own row rendered as a raw `google_…` id while every
          // other row had a name. Presence still skips self — that is filtered
          // separately in `subscribeVisiblePresence`.
          .filter((ownerId) => !known.has(ownerId)),
      ),
    ];
    if (missing.length === 0) {
      this.subscribeVisiblePresence(conversations);
      return;
    }
    try {
      const users = await firstValueFrom(this.api.lookupUsers(missing));
      this.directory.update((current) => {
        const next = new Map(current);
        for (const user of users) next.set(user.ownerId, user);
        return next;
      });
    } catch {
      // Names degrade to owner ids; the thread still works.
    }
    this.subscribeVisiblePresence(conversations);
  }

  /** Only the owners on screen — subscribing to everyone is quadratic. */
  private subscribeVisiblePresence(
    conversations: readonly Conversation[],
  ): void {
    const ownerIds = [
      ...new Set(
        conversations
          .flatMap((conversation) =>
            conversation.participants.map((p) => p.ownerId),
          )
          .filter((ownerId) => ownerId !== this.ownerId),
      ),
    ];
    if (ownerIds.length > 0) this.realtime.subscribePresence(ownerIds);
  }
}
