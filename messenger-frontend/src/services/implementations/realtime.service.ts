import { HttpClient, HttpContext, HttpHeaders } from "@angular/common/http";
import {
  computed,
  DestroyRef,
  Injectable,
  inject,
  signal,
  type Signal,
} from "@angular/core";
import { firstValueFrom, Subject, type Observable } from "rxjs";
import { environment } from "src/environments/environment";
import {
  SKIP_ERROR_DIALOG_HEADER,
  SKIP_GLOBAL_ERROR_DIALOG,
} from "src/interceptors/http-context.tokens";
import type { CallHangupReason, CallMedia } from "src/models/call.model";

/** The wire shape realtime-service speaks: {t, id?, d}. */
export interface RealtimeFrame {
  t: string;
  id?: string;
  d?: Record<string, unknown>;
}

export interface PresenceEntry {
  ownerId: string;
  state: "online" | "away" | "offline";
}

export interface TypingEntry {
  conversationId: string;
  ownerId: string;
  until: number;
}

export interface IncomingMessage {
  conversationId: string;
  message: Record<string, unknown>;
}

/** Reconnect backoff, matching the notification SSE client's 1 s → 30 s walk. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Badge display cap, as the product doc specifies. */
const BADGE_CAP = 9;

/** How often a live typing indicator is re-checked against its `until`. */
const TYPING_PRUNE_INTERVAL_MS = 1_000;

/** Where the per-tab call session id is kept. See `sessionId` below. */
const SESSION_STORAGE_KEY = "messenger.call.session";

/**
 * An id for **this browser tab**, stable across a reload.
 *
 * It is what lets a reloaded tab take its own place in a call back instead of
 * losing to its own not-yet-closed socket: realtime-service treats "same
 * session, different connection" as a reload and hands the place over, while a
 * *different* session is a second tab and must still lose, or a call in
 * progress would jump to the wrong window.
 *
 * `sessionStorage`, emphatically not `localStorage`: the latter is shared by
 * every tab of the window, so two tabs would carry one id and look like a
 * single reloading tab — precisely the case the discriminator exists to tell
 * apart. A tab that has neither (private mode can throw on access) simply goes
 * without: the server treats an absent session as plain first-wins, and a
 * reload then waits for its old socket's close, which is the common ordering
 * anyway.
 */
function readSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, minted);
    return minted;
  } catch {
    // Storage is unavailable or blocked. Degrading to no session is correct —
    // a per-call random id would be worse than none, because it would claim a
    // reload identity the next connection cannot match.
    return "";
  }
}

/**
 * The browser's single socket to `realtime-service`.
 *
 * Root-provided and started by the header widget, so it is alive from login
 * onward rather than from the first visit to /messenger — that is what makes a
 * live badge (and later, ring-from-anywhere) work at all.
 *
 * Two rules shape the state here:
 *
 * 1. **Unread is a set of conversation ids, never a counter.** Every delta is a
 *    union or a delete, so a duplicated frame costs nothing and a dropped one
 *    self-heals at the next resync. A counter would corrupt permanently on one
 *    repeated frame and give no sign it had drifted.
 * 2. **The set is resynced over REST, not carried in `ready`.** `realtime-service`
 *    holds no domain state; asking it to embed unread ids would couple socket
 *    readiness to messenger-service being up. So the socket carries deltas and
 *    the REST endpoint carries truth.
 */
@Injectable({ providedIn: "root" })
export class RealtimeService {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * The token mint and the unread resync run on a reconnect backoff, so they
   * must never raise the global error dialog: signed out, or gateway down,
   * would otherwise stack a modal every second until it recovered.
   */
  private readonly quiet = new HttpContext().set(
    SKIP_GLOBAL_ERROR_DIALOG,
    true,
  );

  /**
   * The same intent in header form, because an HttpContextToken does not
   * survive the Module Federation boundary: hosted by the shell, the
   * interceptor that owns the dialog is the shell's and reads its own token
   * object. The header is a value, so both sides agree — and the interceptor
   * strips it before the request is sent.
   */
  private readonly quietHeaders = new HttpHeaders().set(
    SKIP_ERROR_DIALOG_HEADER,
    "1",
  );

  private readonly unreadIds = signal<ReadonlySet<string>>(new Set());
  private readonly presenceMap = signal<ReadonlyMap<string, PresenceEntry>>(
    new Map(),
  );
  private readonly typingMap = signal<readonly TypingEntry[]>([]);
  private readonly connectedState = signal(false);
  private readonly lastMessageState = signal<IncomingMessage | null>(null);

  /** Conversation ids currently unread for this user. */
  readonly unreadConversationIds: Signal<ReadonlySet<string>> =
    this.unreadIds.asReadonly();

  /** Unread conversation count — the badge value, uncapped. */
  readonly unreadCount = computed(() => this.unreadIds().size);

  /** Badge label, capped at "9+" so the chrome never stretches. */
  readonly unreadBadge = computed(() => {
    const count = this.unreadIds().size;
    if (count === 0) return "";
    return count > BADGE_CAP ? `${BADGE_CAP}+` : String(count);
  });

  readonly presence: Signal<ReadonlyMap<string, PresenceEntry>> =
    this.presenceMap.asReadonly();
  readonly typing: Signal<readonly TypingEntry[]> = this.typingMap.asReadonly();
  readonly connected: Signal<boolean> = this.connectedState.asReadonly();
  /** The most recent `message.new`, for features that render it. */
  readonly lastMessage: Signal<IncomingMessage | null> =
    this.lastMessageState.asReadonly();

  private readonly frameSubject = new Subject<RealtimeFrame>();

  /**
   * Every inbound frame, including the ones this service does not itself track
   * (`message.new`, `receipt.read`, `conversation.created`). Chat state lives
   * in ChatStore; the socket stays a transport rather than growing a second
   * copy of the domain.
   */
  readonly frames$: Observable<RealtimeFrame> =
    this.frameSubject.asObservable();

  private socket: WebSocket | null = null;
  /** Runs only while somebody is typing; see pruneTyping. */
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  /** Subscriptions this client wants, replayed on every (re)connect. */
  private readonly openConversations = new Set<string>();
  private readonly presenceOwners = new Set<string>();
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;

  constructor() {
    this.destroyRef.onDestroy(() => this.stop());
  }

  /** Idempotent: the widget calls it on every construction, tabs included. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    void this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.openConversations.clear();
    this.presenceOwners.clear();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.typingTimer !== null) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    // Nobody is typing to a closed socket, and a stale entry would otherwise
    // survive a reconnect.
    this.typingMap.set([]);
    this.socket?.close();
    this.socket = null;
    this.connectedState.set(false);
  }

  /**
   * Authorizes this connection for a conversation's ephemeral frames.
   *
   * The id is remembered, not just sent: a socket carries its subscriptions,
   * so after a reconnect the server knows nothing about the thread on screen
   * and typing would silently stop working. Every remembered conversation is
   * re-opened on connect, and a call made while the socket is still connecting
   * is honoured then too rather than dropped.
   */
  openConversation(conversationId: string): void {
    this.openConversations.add(conversationId);
    this.send("conversation.open", { conversation_id: conversationId });
  }

  closeConversation(conversationId: string): void {
    this.openConversations.delete(conversationId);
    this.send("conversation.close", { conversation_id: conversationId });
  }

  startTyping(conversationId: string): void {
    this.send("typing.start", { conversation_id: conversationId });
  }

  stopTyping(conversationId: string): void {
    this.send("typing.stop", { conversation_id: conversationId });
  }

  /** Only the owners currently on screen — subscribing to everyone makes
   * presence fanout quadratic. Remembered for the same reason as conversations. */
  subscribePresence(ownerIds: readonly string[]): void {
    for (const ownerId of ownerIds) this.presenceOwners.add(ownerId);
    this.send("presence.subscribe", { owner_ids: [...ownerIds] });
  }

  reportAway(): void {
    this.send("presence.away", {});
  }

  /**
   * WebRTC signalling. Four thin senders rather than one generic `send`,
   * matching the rest of this class: the socket stays a transport and every
   * frame it can emit is visible in its own API.
   *
   * Inbound `call.*` frames are deliberately *not* handled here — they arrive
   * through `frames$`, and WebrtcCallService owns call state. A second copy of
   * it in this class is exactly the drift the unread-set rule exists to avoid.
   *
   * There is no `to` field on an invite: the callee is resolved from
   * conversation membership server-side, because a client-chosen recipient
   * would let anyone ring anyone.
   */
  /**
   * This tab's session id, stamped onto every frame that claims a place in a
   * call. Read once: it must not change while the tab lives, or a reload would
   * stop being recognisable as one.
   */
  readonly sessionId = readSessionId();

  /**
   * Starts a call. A group invite carries **no SDP** — a mesh has no single
   * peer to offer to, and realtime-service refuses one rather than dropping it
   * silently. The pairwise offers happen after joining instead.
   */
  inviteCall(
    conversationId: string,
    sdp: RTCSessionDescriptionInit | null,
    media: CallMedia,
  ): void {
    this.send("call.invite", {
      conversation_id: conversationId,
      ...(sdp ? { sdp } : {}),
      media,
      ...this.session(),
    });
  }

  answerCall(callId: string, sdp: RTCSessionDescriptionInit): void {
    this.send("call.answer", { call_id: callId, sdp, ...this.session() });
  }

  /**
   * Accepts a **group** call. The group's `call.answer`, and deliberately
   * without an SDP for the same reason the invite has none.
   */
  joinCall(callId: string): void {
    this.send("call.join", { call_id: callId, ...this.session() });
  }

  /**
   * A mid-call offer or answer. One frame for both: the SDP says which.
   *
   * `to` names the participant it is for. Required in a group, where there is
   * no single peer to derive; omitted in a 1:1, which is what keeps the wire
   * identical to what this client sent before the mesh existed.
   */
  renegotiateCall(
    callId: string,
    sdp: RTCSessionDescriptionInit,
    screenStreamId: string | null = null,
    to: string | null = null,
  ): void {
    this.send("call.renegotiate", {
      call_id: callId,
      sdp,
      ...(screenStreamId ? { screen_stream_id: screenStreamId } : {}),
      ...(to ? { to } : {}),
    });
  }

  sendIceCandidate(
    callId: string,
    candidate: RTCIceCandidateInit,
    to: string | null = null,
  ): void {
    this.send("call.ice", {
      call_id: callId,
      candidate,
      ...(to ? { to } : {}),
    });
  }

  /** Omitted entirely when there is none, so the field never arrives empty. */
  private session(): { session_id?: string } {
    return this.sessionId ? { session_id: this.sessionId } : {};
  }

  /** `reason` is limited to what a client may assert; the server refuses the rest. */
  hangupCall(callId: string, reason?: CallHangupReason): void {
    this.send(
      "call.hangup",
      reason ? { call_id: callId, reason } : { call_id: callId },
    );
  }

  /**
   * Clears a conversation locally. The durable write is messenger-service's
   * `POST /conversations/:id/read`; this keeps the badge honest immediately
   * rather than waiting for the round trip.
   */
  markConversationRead(conversationId: string): void {
    this.unreadIds.update((current) => {
      if (!current.has(conversationId)) return current;
      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
  }

  /** True while a socket is open — features degrade rather than fail without one. */
  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Re-reads the unread set from messenger-service — on connect and on tab focus. */
  async resyncUnread(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.http.get<{ data: { conversation_ids: string[] } }>(
          `${environment.gateway.baseUrl}/conversations/unread`,
          { context: this.quiet, headers: this.quietHeaders },
        ),
      );
      this.unreadIds.set(new Set(response?.data?.conversation_ids ?? []));
    } catch {
      // A failed resync leaves the previous set in place: stale-but-plausible
      // beats blanking a badge the user is looking at.
    }
  }

  private async openSocket(): Promise<void> {
    if (this.stopped) return;

    let streamToken: string;
    try {
      const minted = await firstValueFrom(
        this.http.get<{ stream_token: string }>(environment.realtime.tokenUrl, {
          context: this.quiet,
          headers: this.quietHeaders,
        }),
      );
      streamToken = minted?.stream_token ?? "";
      if (!streamToken) throw new Error("no stream token");
    } catch {
      // Not signed in yet, or the gateway is down. Back off and retry: a fresh
      // token is minted on every attempt, because these expire in ~90 s.
      this.scheduleReconnect();
      return;
    }

    const url = `${environment.realtime.socketUrl}?stream_token=${encodeURIComponent(streamToken)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.connectedState.set(true);
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.replaySubscriptions();
      void this.resyncUnread();
    };

    socket.onmessage = (event: MessageEvent<string>) =>
      this.handleFrame(event.data);

    socket.onclose = () => {
      this.connectedState.set(false);
      this.socket = null;
      this.scheduleReconnect();
    };

    socket.onerror = () => socket.close();
  }

  /** Re-states what this client is watching; the server holds none of it. */
  private replaySubscriptions(): void {
    if (this.presenceOwners.size > 0) {
      this.send("presence.subscribe", {
        owner_ids: [...this.presenceOwners],
      });
    }
    for (const conversationId of this.openConversations) {
      this.send("conversation.open", { conversation_id: conversationId });
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  private handleFrame(raw: string): void {
    let frame: RealtimeFrame;
    try {
      frame = JSON.parse(raw) as RealtimeFrame;
    } catch {
      return;
    }
    const payload = frame.d ?? {};
    this.frameSubject.next(frame);

    switch (frame.t) {
      case "ping":
        this.send("pong", {});
        return;

      case "unread.added":
        this.addUnread(String(payload["conversation_id"] ?? ""));
        return;

      case "unread.cleared":
        this.markConversationRead(String(payload["conversation_id"] ?? ""));
        return;

      case "message.new": {
        const conversationId = String(payload["conversation_id"] ?? "");
        this.lastMessageState.set({
          conversationId,
          message: (payload["message"] as Record<string, unknown>) ?? {},
        });
        return;
      }

      case "presence": {
        const ownerId = String(payload["owner_id"] ?? "");
        if (!ownerId) return;
        const state = String(payload["state"] ?? "offline") as
          "online" | "away" | "offline";
        this.presenceMap.update((current) => {
          const next = new Map(current);
          next.set(ownerId, { ownerId, state });
          return next;
        });
        return;
      }

      case "typing": {
        this.applyTyping(payload);
        return;
      }

      default:
        // ready, receipt.read, conversation.created and anything added later
        // are not state this service owns yet — ignoring an unknown frame is
        // the whole point of a versionless protocol.
        return;
    }
  }

  private addUnread(conversationId: string): void {
    if (!conversationId) return;
    this.unreadIds.update((current) => {
      if (current.has(conversationId)) return current;
      const next = new Set(current);
      next.add(conversationId);
      return next;
    });
  }

  /**
   * Drops entries whose `until` has passed.
   *
   * Without this a typing entry only ever cleared when *another* typing frame
   * arrived for that conversation, so a missed `typing.stop` — a dropped
   * socket, a closed tab, a peer that simply stopped — left "X is typing…" on
   * screen forever (reported 2026-09-10).
   */
  private pruneTyping(): void {
    const now = Date.now();
    this.typingMap.update((current) =>
      current.some((entry) => entry.until <= now)
        ? current.filter((entry) => entry.until > now)
        : current,
    );
    if (this.typingMap().length === 0) {
      if (this.typingTimer !== null) {
        clearInterval(this.typingTimer);
        this.typingTimer = null;
      }
      return;
    }
    this.typingTimer ??= setInterval(
      () => this.pruneTyping(),
      TYPING_PRUNE_INTERVAL_MS,
    );
  }

  private applyTyping(payload: Record<string, unknown>): void {
    const conversationId = String(payload["conversation_id"] ?? "");
    const ownerId = String(payload["owner_id"] ?? "");
    if (!conversationId || !ownerId) return;

    const stopped = payload["stopped"] === true;
    const until = Date.parse(String(payload["until"] ?? "")) || Date.now();

    this.typingMap.update((current) => {
      const kept = current.filter(
        (entry) =>
          entry.until > Date.now() &&
          !(
            entry.conversationId === conversationId && entry.ownerId === ownerId
          ),
      );
      return stopped ? kept : [...kept, { conversationId, ownerId, until }];
    });
    this.pruneTyping();
  }

  private send(type: string, payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ t: type, d: payload }));
  }
}
