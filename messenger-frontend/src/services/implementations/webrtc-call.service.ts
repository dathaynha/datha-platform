import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
  type Signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { firstValueFrom } from "rxjs";
import type {
  CallEndNotice,
  CallEndReason,
  CallHangupReason,
  CallMedia,
  IceCredentials,
  LiveCall,
  RemotePeer,
} from "src/models/call.model";
import {
  readDiagnostics,
  type CallDiagnostics,
} from "src/helper/call-diagnostics";
import { environment } from "src/environments/environment";
import { MessengerApiService } from "./messenger-api.service";
import { OAuthService } from "angular-oauth2-oidc";
import { ownerIdFromAccessToken } from "src/helper/owner-id";
import { RealtimeService, type RealtimeFrame } from "./realtime.service";
import { RingAudioService } from "./ring-audio.service";

/** Indirection over the browser WebRTC surface, so specs need no media stack. */
export const PEER_CONNECTION_FACTORY = new InjectionToken<
  (config: RTCConfiguration) => RTCPeerConnection
>("PEER_CONNECTION_FACTORY", {
  providedIn: "root",
  factory: () => (config) => new RTCPeerConnection(config),
});

export const DISPLAY_MEDIA = new InjectionToken<
  (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>
>("DISPLAY_MEDIA", {
  providedIn: "root",
  factory: () => (constraints) =>
    navigator.mediaDevices.getDisplayMedia(constraints),
});

export const USER_MEDIA = new InjectionToken<
  (constraints: MediaStreamConstraints) => Promise<MediaStream>
>("USER_MEDIA", {
  providedIn: "root",
  factory: () => (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
});

/**
 * What to ask the browser for, by call kind.
 *
 * `audio: true` is deliberately left bare. Phase 2.5 slice 0 is to *measure* a
 * call with `getStats()` before touching echo cancellation or noise
 * suppression — changing three constraints at once and declaring the audio
 * fixed is exactly what that slice exists to prevent.
 *
 * The video constraints are `ideal`, never `exact`: a camera that cannot do
 * 720p should negotiate down, not fail to open.
 */
function constraintsFor(media: CallMedia): MediaStreamConstraints {
  return {
    audio: true,
    video:
      media === "video"
        ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }
        : false,
  };
}

/** Refresh ICE credentials this far before expiry rather than mid-gather. */
const CREDENTIAL_SAFETY_MARGIN_MS = 30_000;

/**
 * An outgoing audio level at or below this is not a quiet room, it is a dead
 * microphone: a working one reports a small noise floor even in silence.
 */
const SILENT_LEVEL = 0.0001;

/** Consecutive silent samples before saying anything — speech has pauses. */
const SILENT_SAMPLES = 4;

/** How often the outgoing level is sampled. */
const SILENT_CHECK_MS = 3_000;

/**
 * How often each peer's *incoming* level is sampled for the speaking border.
 *
 * Much faster than the microphone watch above, because this one is on screen:
 * at three seconds the border would light up after somebody had finished
 * their sentence. `getSynchronizationSources` is a synchronous read of state
 * the receiver already holds, so this costs far less than a `getStats` sweep.
 */
const SPEAKING_CHECK_MS = 400;

/**
 * Inbound audio level that counts as speech.
 *
 * Well above a room's noise floor (~0.001) and well below normal speech
 * (~0.05+), so breathing does not light the border and talking always does.
 */
const SPEAKING_LEVEL = 0.01;

/**
 * Quiet samples before the border goes out — speech has gaps between words,
 * and a border that flickers on every syllable is worse than none.
 */
const QUIET_SAMPLES = 3;

/** How long "Declined" / "Missed" stays on screen after the call clears. */
const END_NOTICE_MS = 5_000;

/**
 * How long a join the server never answers is waited for.
 *
 * `RealtimeService.send` drops a frame on a socket that is not open and says
 * nothing, so a join can go missing with no error anywhere. Without this the
 * dock would sit on "Connecting…" for as long as the page stayed open.
 */
const JOIN_TIMEOUT_MS = 8_000;

/**
 * One leg of the mesh: this browser's connection to exactly one other person.
 *
 * A 1:1 call has one of these and a group has N-1, which is the whole point —
 * everything below works on the map rather than on a single connection, so the
 * two cases share one implementation instead of drifting apart.
 */
interface PeerLink {
  readonly ownerId: string;
  readonly pc: RTCPeerConnection;
  /**
   * This side sends the first offer for this pair.
   *
   * Matrix MSC3401's full-mesh rule: the lexicographically lower owner id
   * calls the other. Deliberately **not** "whoever was already in the room
   * offers to the newcomer" — two people joining in the same instant each see
   * the other as the newcomer, so arrival order is not knowable to both sides
   * while owner ids are. The server never enforces it; both ends compute the
   * same answer from the joined set it publishes.
   */
  readonly initiator: boolean;
  /**
   * The first offer for this pair travels as `call.renegotiate`.
   *
   * True in a group, where a pair is negotiated *after* both ends know the
   * other is in. False in a 1:1, where the offer rides the invite and the
   * answer rides `call.answer` — which is what keeps this client's 1:1
   * handshake byte-identical to the one phase 2 shipped.
   */
  readonly viaRenegotiate: boolean;
  /**
   * True between deciding to offer and having a local description.
   *
   * Half of the perfect-negotiation collision test: an offer that arrives
   * while this is set crossed ours on the wire.
   */
  makingOffer: boolean;
  /** The stream id this peer told us carries their screen, if any. */
  screenStreamId: string | null;
  /**
   * This peer's own playback element.
   *
   * One per link, not one for the service: three peers sharing a single
   * `<audio>` means hearing exactly one of them. Detached from the template
   * for the same reason as before — the dock can re-render or hide, and audio
   * must not stop when it does.
   */
  audio: HTMLAudioElement | null;
}

/**
 * The browser half of a WebRTC call — 1:1 or a group mesh.
 *
 * Signalling rides `RealtimeService`'s socket; media does not. Once the
 * descriptions are exchanged the audio flows peer to peer over UDP and no
 * server sees it — coturn only enters when a direct path cannot be found.
 *
 * A group call is a **mesh**: every participant holds a connection to every
 * other, which is why `MAX_CALL_PARTICIPANTS` exists server-side. There is no
 * SFU, and the trade was made deliberately — see
 * `.claude/docs/products/messenger-architecture.md` § Phase 3.
 *
 * Root-provided and mounted by the header widget, so a call survives
 * navigation. Nothing here lives in a routed component: leaving `/messenger`
 * would destroy the connections and drop the call, which is exactly the
 * phase-2 exit criterion.
 */
@Injectable({ providedIn: "root" })
export class WebrtcCallService {
  private readonly oauth = inject(OAuthService);
  private readonly realtime = inject(RealtimeService);
  private readonly api = inject(MessengerApiService);
  private readonly ring = inject(RingAudioService);
  private readonly createPeerConnection = inject(PEER_CONNECTION_FACTORY);
  private readonly getUserMedia = inject(USER_MEDIA);
  private readonly getDisplayMedia = inject(DISPLAY_MEDIA);
  private readonly destroyRef = inject(DestroyRef);

  private readonly callState = signal<LiveCall | null>(null);
  private readonly errorState = signal<string | null>(null);
  private readonly endNoticeState = signal<CallEndNotice | null>(null);

  /** The one live call, or null. Two at once is refused, not queued. */
  readonly call: Signal<LiveCall | null> = this.callState.asReadonly();
  readonly error: Signal<string | null> = this.errorState.asReadonly();
  /** Why the last call ended, for a few seconds after it did. */
  readonly endNotice: Signal<CallEndNotice | null> =
    this.endNoticeState.asReadonly();
  readonly inCall = computed(() => this.callState() !== null);

  /** More than two people invited, so there is no single peer to speak of. */
  readonly isGroupCall = computed(
    () => (this.callState()?.participantIds.length ?? 0) > 2,
  );

  /**
   * The other person, in a 1:1 call. Empty in a group.
   *
   * Derived rather than stored: the invited set already contains the fact, and
   * a second copy is the kind of duplication that goes stale the moment one of
   * the two is updated and the other is not.
   */
  readonly peerOwnerId = computed(() => {
    const call = this.callState();
    if (!call || call.participantIds.length !== 2) return "";
    return call.participantIds.find((id) => id !== this.selfOwnerId) ?? "";
  });

  private readonly remoteState = signal<ReadonlyMap<string, RemotePeer>>(
    new Map(),
  );

  /**
   * Everyone else in the call, in a stable order.
   *
   * Sorted by owner id rather than by arrival: tiles that reshuffle whenever
   * somebody's connection settles are worse than tiles in an arbitrary but
   * fixed order, and every client computes the same order from the same facts.
   */
  readonly peers = computed<readonly RemotePeer[]>(() =>
    [...this.remoteState().values()].sort((a, b) =>
      a.ownerId.localeCompare(b.ownerId),
    ),
  );

  /**
   * Whether there is any picture to lay out — a camera anywhere, or a shared
   * screen anywhere.
   *
   * Separate from `media`, which says how the call was **set up** and is what
   * the label, the ring and the history row read. One flag was doing both jobs
   * until 2026-09-11, which is why sharing a screen during a voice call
   * announced itself as a video call.
   */
  readonly hasVideo = computed(() => {
    const call = this.callState();
    if (!call) return false;
    return (
      // A call *set up* as video keeps its stage even with every camera off —
      // collapsing to the compact dock the moment a share ended pulled the
      // panel out from under both people (dathq, 2026-09-11).
      call.media === "video" ||
      call.sendingVideo ||
      call.sharingScreen ||
      this.peers().some((peer) => peer.stream !== null || peer.screen !== null)
    );
  });

  private endNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  /** One connection per other participant, keyed by owner id. */
  private readonly links = new Map<string, PeerLink>();

  /**
   * Links currently being built.
   *
   * Building one is asynchronous (ICE credentials, then the local media), and
   * two frames from the same person can arrive inside that window — a
   * participant announcement and their first offer, say. Without this the
   * second would build a *second* connection to the same peer and one of them
   * would negotiate into nothing.
   */
  private readonly linkBuilds = new Map<string, Promise<PeerLink>>();

  private localMedia: MediaStream | null = null;

  private readonly localStreamState = signal<MediaStream | null>(null);
  private readonly localScreenState = signal<MediaStream | null>(null);

  /** This side's camera, for the local preview. Always rendered muted. */
  readonly localStream: Signal<MediaStream | null> =
    this.localStreamState.asReadonly();

  /**
   * The screen this side is sending, kept apart from the camera.
   *
   * A screen is a **second** video track, never a replacement for the camera:
   * sharing used to swap the camera track out, so with both people sharing
   * nobody could see anybody (dathq, 2026-09-11, with a Meet screenshot
   * showing four tiles — two screens and two people).
   */
  readonly localScreen: Signal<MediaStream | null> =
    this.localScreenState.asReadonly();

  private readonly cameraPresent = signal(false);

  /**
   * Whether this device has a camera at all.
   *
   * `enumerateDevices` reports the *kind* of every device before permission is
   * granted — only the labels are hidden — so presence can be known without
   * prompting anyone.
   *
   * The UI uses it to not offer a video call that cannot succeed: on a machine
   * with no camera, `getUserMedia` rejects with `NotFoundError` and the whole
   * call attempt dies (reported 2026-09-11, on a Mac with no camera). The
   * named error stays as the safety net — a camera can be unplugged between
   * the check and the call — but an impossible button is the actual defect.
   */
  readonly hasCamera: Signal<boolean> = this.cameraPresent.asReadonly();

  private async refreshCameraPresence(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      this.cameraPresent.set(false);
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.cameraPresent.set(devices.some((d) => d.kind === "videoinput"));
    } catch {
      this.cameraPresent.set(false);
    }
  }

  /**
   * Candidates that arrived before their link could take them, by sender.
   *
   * `addIceCandidate` throws before a remote description exists, and trickle
   * ICE guarantees that window happens: a peer starts sending candidates the
   * moment it has a local description, which is before its offer has been
   * answered. Keyed by sender because in a mesh three people trickle at once
   * and one shared queue would feed the wrong connection.
   */
  private readonly pendingCandidates = new Map<string, RTCIceCandidateInit[]>();

  /** Cached ICE servers plus the epoch ms they stop being usable. */
  private credentials: { value: IceCredentials; expiresAt: number } | null =
    null;

  private resolvedSelfOwnerId = "";

  /**
   * Our own owner id: needed to derive the peer, and to order each pair.
   *
   * Resolved from the **access token** on first read rather than waiting to be
   * told. It used to come only from the socket's `ready` frame, and
   * `setSelfOwnerId`'s own doc said "the dock passes it through" — the dock
   * never did, so the single source was a frame that may not have arrived yet.
   * Empty, it fails silently in six places rather than throwing: `politeTo`
   * makes `"" < anything` true so this side is always the impolite one,
   * `peerOf` returns the first participant (which can be *you*), the rejoin
   * guard at `call.participant` returns early and never reconnects, and the
   * invited set omits the one member it is certain of. That is the shape of
   * the bug that already cost three sessions — an id whose whole job is to be
   * compared, never equal to anything.
   *
   * Same fix and same reason as `ChatStore.syncOwnerId`: the owner of a
   * derived value resolves it itself instead of trusting a caller to push it
   * in. The `ready` frame still wins when it arrives — the server is
   * authoritative — it is simply no longer the only way to know.
   */
  private get selfOwnerId(): string {
    if (!this.resolvedSelfOwnerId)
      this.resolvedSelfOwnerId = ownerIdFromAccessToken(
        this.oauth.getAccessToken(),
      );
    return this.resolvedSelfOwnerId;
  }

  constructor() {
    this.realtime.frames$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((frame) => this.onFrame(frame));

    // Product behaviour, not diagnostics: it has to run in production too.
    const micWatch = setInterval(
      () => void this.watchOutgoingAudio(),
      SILENT_CHECK_MS,
    );
    this.destroyRef.onDestroy(() => clearInterval(micWatch));

    const speakingWatch = setInterval(
      () => this.sampleIncomingAudio(),
      SPEAKING_CHECK_MS,
    );
    this.destroyRef.onDestroy(() => clearInterval(speakingWatch));

    // Asked once, then kept current: a webcam can be plugged in mid-session,
    // and `devicechange` is the only way to hear about it.
    void this.refreshCameraPresence();
    const onDeviceChange = () => void this.refreshCameraPresence();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    this.destroyRef.onDestroy(() =>
      navigator.mediaDevices?.removeEventListener?.(
        "devicechange",
        onDeviceChange,
      ),
    );
    this.destroyRef.onDestroy(() => {
      this.teardown();
      // The notice timer outlives a call, so teardown does not own it: left
      // running it would set a signal on a destroyed service.
      this.clearEndNotice();
    });
    this.ring.armUnlock();
  }

  /**
   * The socket's `ready` frame carries it, and the server is authoritative —
   * so this still overrides whatever the token resolved to. It is no longer
   * the *only* source; see `selfOwnerId`.
   */
  setSelfOwnerId(ownerId: string): void {
    if (ownerId) this.resolvedSelfOwnerId = ownerId;
  }

  /** Set while a Join is outstanding, so its answer can be recognised. */
  private joinTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Capture being opened, when it is being opened after the join.
   *
   * Joining an ongoing call claims its place first
   * and opens the microphone afterwards, so a link can be built before there
   * are tracks to put on it. `buildLink` awaits this so it never negotiates an
   * empty connection it would have to redo.
   */
  private mediaReady: Promise<void> | null = null;

  /**
   * Joins a call that is already happening in a conversation.
   *
   * This is the Join button on the thread's ongoing-call banner, and it is
   * deliberately the *only* way back into a call. Until 2026-09-15 a reloaded
   * tab tried to rejoin by itself from a `sessionStorage` note, which needed
   * three separate things to go right — an open socket, reacquired capture and
   * a won takeover — and failed silently when any one of them did not. Three
   * failure modes were found and fixed in one session and it still dropped
   * dathq, so the mechanism went rather than its fourth bug: Messenger does not
   * auto-rejoin either, it shows the call in the chat and you press Join.
   * Pressing a button has no race in it, and the server needed no change —
   * an ongoing call is already a row in the history the thread loads.
   *
   * Nothing is restored optimistically beyond what is needed to send the join:
   * the authoritative invited and joined sets arrive on the `call.participant`
   * that the join itself produces, and the mesh is built from that.
   */
  async joinOngoing(
    callId: string,
    conversationId: string,
    callerOwnerId: string,
    participantOwnerIds: readonly string[],
    media: CallMedia = "audio",
  ): Promise<void> {
    if (!callId || this.callState()) return;
    this.errorState.set(null);

    this.callState.set({
      callId,
      conversationId,
      participantIds: this.invitedSet(participantOwnerIds),
      callerOwnerId,
      joinedIds: [],
      // Never `ringing`: nobody is being asked anything, this person walked in
      // on their own. `incoming` would put an Accept button on a call already
      // accepted by the act of pressing Join.
      direction: "outgoing",
      media,
      state: "connecting",
      micMuted: false,
      cameraOff: false,
      cameraMissing: false,
      sharingScreen: false,
      micSilent: false,
      sendingVideo: false,
      activeSince: null,
      relayAvailable: false,
    });

    /*
     * The join goes first, before the microphone is touched.
     *
     * A place in the room is the scarce thing and capture is not: `send` drops
     * a frame silently on a socket that is not open, so any await before the
     * join is a window in which the join can vanish without a trace, and
     * reacquiring capture is exactly what fails on a real machine where
     * several tabs contend for one microphone. Claim the irreplaceable thing
     * first and let the replaceable one follow.
     */
    this.realtime.joinCall(callId);

    /*
     * Capture follows, and its failure is reported rather than fatal: without
     * a microphone this side is in the call and can still hear, which beats
     * being dropped from it. `buildLink` waits on this promise, so a peer
     * connection is never built with tracks that have not arrived yet.
     */
    this.mediaReady = this.openLocalMedia(media).catch((error) => {
      if (!environment.production) console.error("[call join media]", error);
      this.errorState.set(this.mediaErrorCode(error));
    });

    this.joinTimer = setTimeout(() => {
      this.joinTimer = null;
      if (this.callState()?.state !== "connecting") return;
      this.abandonJoin();
      this.errorState.set("JOIN_FAILED");
    }, JOIN_TIMEOUT_MS);
  }

  /**
   * Gives up on a join, quietly.
   *
   * Deliberately no end notice: this is a call the person was never in, so
   * "call ended" would be announcing something they did not take part in. The
   * banner stays on the thread, so trying again is one click away.
   */
  private abandonJoin(): void {
    this.clearJoinTimer();
    this.teardown();
    this.callState.set(null);
  }

  private clearJoinTimer(): void {
    if (this.joinTimer !== null) {
      clearTimeout(this.joinTimer);
      this.joinTimer = null;
    }
  }

  /**
   * Places a call in a conversation.
   *
   * `participantOwnerIds` is who the *client* believes is in the conversation,
   * and it decides one thing only: whether to send an offer with the invite.
   * The authoritative invited set comes back on `call.ringing` and replaces it
   * — the server resolves membership itself, because a client-chosen recipient
   * would be a way to ring strangers.
   */
  async startCall(
    conversationId: string,
    participantOwnerIds: readonly string[],
    media: CallMedia = "audio",
  ): Promise<void> {
    if (this.callState()) return;
    this.errorState.set(null);

    const invited = this.invitedSet(participantOwnerIds);
    const group = invited.length > 2;

    this.callState.set({
      callId: null,
      conversationId,
      participantIds: invited,
      callerOwnerId: this.selfOwnerId,
      // The server joins the caller as it creates the call, so this side is in
      // from the first instant rather than after a round trip.
      joinedIds: this.selfOwnerId ? [this.selfOwnerId] : [],
      direction: "outgoing",
      media,
      state: "ringing",
      micMuted: false,
      cameraOff: false,
      cameraMissing: false,
      sharingScreen: false,
      micSilent: false,
      sendingVideo: false,
      activeSince: null,
      relayAvailable: false,
    });

    try {
      await this.openLocalMedia(media);

      if (group) {
        /*
         * No SDP. A mesh has no single peer to offer to, so one description
         * sent with the invite would be an offer made to everybody at once —
         * realtime-service refuses it rather than dropping it silently. Each
         * pair negotiates for itself once both ends have joined.
         */
        this.realtime.inviteCall(conversationId, null, media);
        return;
      }

      // Derived from the invited set, never `invited[0]` — that is whichever
      // of the two sorts first, and half the time it is this user.
      const link = await this.ensureLink(this.peerOwnerId(), false);
      const offer = await link.pc.createOffer();
      await link.pc.setLocalDescription(offer);
      // pc.localDescription rather than the offer object: the browser may have
      // rewritten it, and the peer must negotiate against what we actually set.
      this.realtime.inviteCall(
        conversationId,
        link.pc.localDescription ?? offer,
        media,
      );
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Accepts the ringing call.
   *
   * `call.answer` replies to an offer, so it is only possible when we actually
   * received one; otherwise the way in is `call.join`, which puts us in the
   * room and lets each pair negotiate from scratch.
   *
   * That is the rule, and it is **not** "group means join". A 1:1 ring arrives
   * without an offer whenever this tab was not connected when the call was
   * placed — the invite goes out over core NATS, which drops a frame nobody is
   * listening for, and realtime-service re-rings from stored state on connect
   * with no SDP precisely because the original offer is stale by then. Keying
   * on the group size meant that ring did nothing at all when pressed
   * (dathq, 2026-09-16: "dathaynha login, i dont see anything popup").
   */
  async accept(): Promise<void> {
    const call = this.callState();
    if (!call || call.direction !== "incoming" || call.state !== "ringing") {
      return;
    }
    if (!call.callId) return;

    const offer = this.pendingOffer;
    const viaJoin = call.participantIds.length > 2 || !offer;

    this.ring.stopRinging();
    this.patch({ state: "connecting" });

    try {
      await this.openLocalMedia(call.media);

      if (viaJoin) {
        /*
         * Carries no SDP, for the same reason the group invite does not. The
         * connections are built from the `call.participant` fanout this join
         * produces — including the copy addressed to this tab, which is what
         * tells us who is already in.
         */
        this.realtime.joinCall(call.callId);
        return;
      }

      if (!offer) return;
      const link = await this.ensureLink(this.peerOwnerId(), false);
      await link.pc.setRemoteDescription(offer);
      this.pendingOffer = null;
      this.drainCandidates(link.ownerId);

      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      this.realtime.answerCall(call.callId, link.pc.localDescription ?? answer);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Declines a ringing call, or leaves a live one.
   *
   * In a 1:1 leaving and ending are the same act. In a group they are not: the
   * server removes this person, tells the others, and leaves them talking —
   * so the local teardown below is this tab's business only.
   */
  hangUp(reason?: CallHangupReason): void {
    const call = this.callState();
    if (!call) return;

    const resolved =
      reason ??
      (call.direction === "incoming" && call.state === "ringing"
        ? "declined"
        : "hangup");

    if (call.callId) {
      this.realtime.hangupCall(call.callId, resolved);
    }
    this.finish(resolved);
  }

  /** Mutes the microphone locally. The track stays, so renegotiation is not needed. */
  toggleMute(): void {
    const call = this.callState();
    if (!call || !this.localMedia) return;
    const muted = !call.micMuted;
    for (const track of this.localMedia.getAudioTracks()) {
      track.enabled = !muted;
    }
    this.patch({ micMuted: muted });
  }

  /**
   * Stops sending video, without tearing the track down.
   *
   * Same mechanism as mute, and for the same reason: `enabled = false` blanks
   * the outgoing frames while the sender stays in place, so turning the camera
   * back on needs no renegotiation. Removing the track would, and it would also
   * drop the camera light — which people read as the call having ended.
   *
   * One track feeds every link, so this is one flag rather than N.
   */
  toggleCamera(): void {
    const call = this.callState();
    // Keyed on having a camera track of our own, not on the call being a video
    // call: a voice call can carry a shared screen, and a video call joined
    // without a camera has nothing to toggle.
    if (!call || !this.localMedia || !call.sendingVideo) return;
    const off = !call.cameraOff;
    for (const track of this.localMedia.getVideoTracks()) {
      track.enabled = !off;
    }
    this.patch({ cameraOff: off });
  }

  private silentSamples = 0;

  /**
   * Watches this side's own microphone and says so when it stops working.
   *
   * On 2026-09-11 a receiver transmitted **exact-zero** audio for a whole call
   * while `packetsSent` kept climbing — two tabs contending for one microphone,
   * so the second track was muted by the OS. Everything looked healthy from
   * both ends: no loss, no jitter, a direct candidate pair. Silence is a
   * *sending* fault and the sender is the only one who can see it, so it has to
   * be surfaced rather than left for the other person to complain about. Meet
   * shows the same warning.
   *
   * A threshold, not a zero test: a live microphone in a quiet room still
   * reports a small floor, and only a dead one sits flat.
   */
  /** Consecutive quiet samples per peer, so the border does not flicker. */
  private readonly quietSamples = new Map<string, number>();

  /**
   * Marks who is talking, from each link's own inbound audio.
   *
   * A mesh has no server to name the active speaker, so every client works it
   * out for itself — which is also why it costs nothing to add: the receiver
   * already carries the level, and `getSynchronizationSources` reads it
   * without building an audio graph.
   *
   * Deliberately not gated on the call being a group: in a 1:1 the border is
   * a cheap answer to "is it me or them that has gone quiet".
   */
  private sampleIncomingAudio(): void {
    const call = this.callState();
    if (!call || call.state !== "active") return;

    for (const [ownerId, link] of this.links) {
      const receiver = link.pc
        .getReceivers()
        .find((candidate) => candidate.track?.kind === "audio");
      // Absent in older browsers and in test doubles; no level simply means no
      // border, never a broken call.
      const sources = receiver?.getSynchronizationSources?.() ?? [];
      const level = sources.reduce(
        (highest, source) => Math.max(highest, source.audioLevel ?? 0),
        0,
      );

      if (level > SPEAKING_LEVEL) {
        this.quietSamples.set(ownerId, 0);
        this.patchPeer(ownerId, { speaking: true });
        continue;
      }
      const quiet = (this.quietSamples.get(ownerId) ?? 0) + 1;
      this.quietSamples.set(ownerId, quiet);
      if (quiet >= QUIET_SAMPLES) this.patchPeer(ownerId, { speaking: false });
    }
  }

  private async watchOutgoingAudio(): Promise<void> {
    const call = this.callState();
    if (!call || call.state !== "active" || this.links.size === 0) return;
    if (call.micMuted) {
      // Muting is deliberate; warning about it would be nonsense.
      this.silentSamples = 0;
      return;
    }

    // One microphone feeds every link, so any connection answers the question.
    const stats = await this.diagnostics();
    const level = stats?.outbound.audioLevel;
    if (level === null || level === undefined) return;

    this.silentSamples = level <= SILENT_LEVEL ? this.silentSamples + 1 : 0;
    this.patch({ micSilent: this.silentSamples >= SILENT_SAMPLES });
  }

  /** The screen we are sending, so its sender can be found again to stop it. */
  private screenTrack: MediaStreamTrack | null = null;

  /**
   * Shares this screen, or stops sharing.
   *
   * The track is added to **every** link — a mesh has no server to fan it out,
   * so presenting to three people means three senders. Each one fires
   * `onnegotiationneeded` on its own connection and goes through the same
   * perfect negotiation as any other track change.
   *
   * The browser's own "stop sharing" affordance fires `ended` on the track,
   * and it must be honoured — otherwise the UI claims to still be sharing a
   * screen the browser has already taken back.
   */
  async toggleScreenShare(): Promise<void> {
    const call = this.callState();
    if (!call || call.state !== "active" || this.links.size === 0) return;
    if (call.sharingScreen) {
      await this.stopScreenShare();
      return;
    }

    this.errorState.set(null);

    let display: MediaStream;
    try {
      display = await this.getDisplayMedia({ video: true });
    } catch (error) {
      /*
       * Cancelling the picker and being refused by the OS both arrive as
       * `NotAllowedError`, with no reliable way to tell them apart. The
       * message covers both readings: someone who cancelled ignores it,
       * someone who was never asked learns why. Saying nothing made a blocked
       * permission look like a dead button (2026-09-11).
       */
      this.errorState.set("SCREEN_FAILED");
      if (!environment.production) console.error("[screen share]", error);
      return;
    }

    const screen = display.getVideoTracks()[0];
    if (!screen) return;

    /*
     * Added as its **own** track on its **own** stream, beside the camera.
     * Replacing the camera's track was the original design and it meant two
     * people sharing could not see each other at all. The stream id is what
     * lets peers tell this apart from a camera, since nothing else in the
     * signalling says which is which.
     */
    for (const link of this.links.values()) link.pc.addTrack(screen, display);
    screen.addEventListener("ended", () => void this.stopScreenShare());

    this.screenTrack = screen;
    this.localScreenState.set(display);
    // Deliberately not `media: "video"`. Presenting is not the same as being
    // in a video call: Meet, Teams, Zoom and Messenger all let you share a
    // screen during a voice call without anyone's camera turning on, and none
    // of them re-label the call. `media` says how the call was set up — the
    // stage is driven by `hasVideo` instead (dathq, 2026-09-11).
    this.patch({ sharingScreen: true });
  }

  private async stopScreenShare(): Promise<void> {
    const track = this.screenTrack;

    /*
     * `replaceTrack(null)` is not enough: it stops frames but leaves the
     * m-line, and the receiver's <video> sits on the last frame it got, so
     * stopping looked like nothing happened (2026-09-11). Removing the sender
     * ends the remote track for real, at the cost of a renegotiation that
     * perfect negotiation already handles — once per link.
     */
    for (const link of this.links.values()) {
      const sender = link.pc
        .getSenders()
        .find((s) => track !== null && s.track === track);
      if (sender) link.pc.removeTrack(sender);
    }
    track?.stop();

    this.screenTrack = null;
    this.localScreenState.set(null);
    this.patch({ sharingScreen: false });
  }

  /**
   * Switches the camera mid-call.
   *
   * `replaceTrack` swaps what a sender transmits without touching the SDP, so
   * this needs no renegotiation on any link.
   */
  async useCamera(deviceId: string): Promise<void> {
    const call = this.callState();
    if (!call || !call.sendingVideo || !this.localMedia) return;

    const replacement = await this.getUserMedia({
      audio: false,
      video: { deviceId: { exact: deviceId } },
    });
    const [next] = replacement.getVideoTracks();
    if (!next) return;

    /*
     * Matched against the camera tracks we are actually sending, not against
     * "the first video sender": while a screen is being shared there are two
     * video senders per link, and taking the first would have swapped the
     * camera into the presentation.
     */
    const cameras = new Set(this.localMedia.getVideoTracks());
    let replaced = false;
    for (const link of this.links.values()) {
      const sender = link.pc
        .getSenders()
        .find((s) => s.track !== null && cameras.has(s.track));
      if (!sender) continue;
      await sender.replaceTrack(next);
      replaced = true;
    }
    if (!replaced) {
      for (const track of replacement.getTracks()) track.stop();
      return;
    }
    next.enabled = !call.cameraOff;

    // Swap it into the local preview too, and stop the camera we just left —
    // otherwise its indicator light stays on for the rest of the call.
    for (const old of cameras) {
      this.localMedia.removeTrack(old);
      old.stop();
    }
    this.localMedia.addTrack(next);
    this.localStreamState.set(this.localMedia);
  }

  /** The offer held between `call.incoming` and the user accepting. 1:1 only. */
  private pendingOffer: RTCSessionDescriptionInit | null = null;

  /**
   * Who yields when two offers cross on one pair.
   *
   * Compared by owner id so **both** peers reach the same verdict without
   * asking each other — the same rule that decides who offers first, applied
   * to two simultaneous *offers*. The polite peer rolls back and takes the
   * incoming offer; the impolite peer ignores it and keeps its own. There is
   * deliberately no second ordering concept.
   */
  private politeTo(ownerId: string): boolean {
    return this.selfOwnerId < ownerId;
  }

  private onFrame(frame: RealtimeFrame): void {
    const payload = frame.d ?? {};
    switch (frame.t) {
      case "ready":
        this.setSelfOwnerId(String(payload["owner_id"] ?? ""));
        return;
      case "call.ringing":
        this.onRinging(payload);
        return;
      case "call.incoming":
        this.onIncoming(payload);
        return;
      case "call.answered":
        void this.onAnswered(payload);
        return;
      case "call.participant":
        void this.onParticipant(payload);
        return;
      case "call.renegotiate":
        void this.onRenegotiate(payload);
        return;
      case "call.ice":
        void this.onRemoteCandidate(payload);
        return;
      case "call.ended":
        this.onEnded(payload);
        return;
      case "error":
        this.onServerError(payload);
        return;
      default:
        return;
    }
  }

  /**
   * A protocol error from realtime-service.
   *
   * Error frames answer the frame that caused them and carry no call id, so
   * this claims one only in the window where an unanswered invite is the only
   * call frame that can be in flight: an outgoing call still ringing with no
   * server id yet. That is exactly where a conversation too large for the mesh
   * is refused — and without this the dock would ring for thirty seconds at a
   * call the server never created.
   *
   * The server's text names both numbers and is worth reading, but it is
   * English only, so the UI shows a translated message and the original goes
   * to the console in development.
   */
  private onServerError(payload: Record<string, unknown>): void {
    const call = this.callState();
    if (!call) return;

    const code = String(payload["code"] ?? "");

    /*
     * The call we pressed Join on is already over — it ended between the
     * banner being painted and the frame arriving. Dropped quietly: the row is
     * about to become a history row, which says it better than an error would.
     */
    if (code === "call_gone" && this.joinTimer !== null) {
      this.abandonJoin();
      return;
    }

    /*
     * The conversation already has a call, so this invite becomes a join.
     *
     * One call per conversation is the rule every mainstream client follows,
     * and realtime-service enforces it atomically — which also settles two
     * people pressing Call in the same instant: both invites are sent, one
     * creates the call and the other lands here and joins it. The UI hides the
     * Call button while a call is on, so this is the race, not the usual path.
     *
     * `callerOwnerId` is genuinely unknown here — the refusal names the call,
     * not who started it — and is only ever read to caption an incoming ring,
     * which a call we are joining does not have.
     */
    if (code === "call_exists") {
      if (call.direction !== "outgoing" || call.state !== "ringing") return;
      if (call.callId) return;
      const existingId = String(payload["call_id"] ?? "");
      const { conversationId, participantIds, media } = call;
      this.teardown();
      this.callState.set(null);
      if (existingId) {
        void this.joinOngoing(
          existingId,
          conversationId,
          "",
          participantIds,
          media,
        );
      }
      return;
    }

    if (call.direction !== "outgoing" || call.state !== "ringing") return;
    if (call.callId) return;

    if (
      code !== "not_supported" &&
      code !== "forbidden" &&
      code !== "bad_frame"
    ) {
      return;
    }
    if (!environment.production) {
      console.error("[call refused]", code, payload["message"]);
    }
    this.errorState.set(
      code === "not_supported" ? "CALL_TOO_MANY" : "CALL_FAILED",
    );
    // No hangup frame: there is no call to end. The server refused before
    // creating one, so sending one would name an id that never existed.
    this.teardown();
    this.callState.set(null);
  }

  /**
   * The server's id for the call we just placed, and its authoritative
   * invited set.
   *
   * The set is adopted rather than merged: membership is resolved server-side
   * from the conversation, and a client that disagreed — a stale participant
   * list, a member added since the thread was loaded — must take the server's
   * answer, because that is the set every authorization check uses.
   */
  private onRinging(payload: Record<string, unknown>): void {
    const call = this.callState();
    if (!call) return;
    const invited = this.ownerIds(payload["participants"]);
    this.patch({
      callId: String(payload["call_id"] ?? ""),
      ...(invited.length > 0 ? { participantIds: invited } : {}),
    });
  }

  private onIncoming(payload: Record<string, unknown>): void {
    const callId = String(payload["call_id"] ?? "");
    const conversationId = String(payload["conversation_id"] ?? "");
    const from = String(payload["from"] ?? "");
    const sdp = payload["sdp"] as RTCSessionDescriptionInit | undefined;
    if (!callId || !from) return;

    // Absent participants would mean a realtime-service older than slice 1; a
    // 1:1 set is derivable from the two people involved.
    const invited = this.ownerIds(payload["participants"]);
    const participantIds =
      invited.length > 0 ? invited : this.invitedSet([from]);
    /*
     * A ring with no offer is joined rather than answered — it is not a
     * malformed ring, and dropping it here is what made a call invisible to
     * somebody who signed in while it was ringing (dathq, 2026-09-16).
     *
     * Two things arrive this way. A group ring carries no offer by design,
     * because a mesh has no single peer to have made one. And realtime-service
     * re-rings a live call from stored state when a socket connects, also
     * without one, because by then the caller's offer is stale and the
     * candidates that followed it were published to a subject nobody was
     * listening on. `accept` keys on this the same way.
     */

    const existing = this.callState();
    if (existing) {
      /*
       * Glare is two people *dialling each other* at the same instant, and only
       * then is yielding right. Until 2026-09-15 this branch ran for any live
       * call, so a third person's invite could make whoever sorted lower hang
       * up the call they were in and take the new ring — one press could empty
       * a room. A call we have already joined, or one somebody else is ringing
       * us with, is refused as busy instead.
       */
      if (existing.direction !== "outgoing" || existing.state !== "ringing") {
        this.realtime.hangupCall(callId, "busy");
        return;
      }
      // Resolved deterministically by owner id rather than by whoever's frame
      // landed first, which is the perfect-negotiation rule applied at call
      // level. The polite peer (lower id) yields its own call and takes the
      // incoming one; the impolite peer keeps its call and refuses as busy.
      if (!this.politeTo(from)) {
        this.realtime.hangupCall(callId, "busy");
        return;
      }
      this.realtime.hangupCall(existing.callId ?? "", "hangup");
      this.finish("hangup");
    }

    this.pendingOffer = sdp ?? null;
    this.callState.set({
      callId,
      conversationId,
      participantIds,
      callerOwnerId: from,
      joinedIds: [],
      direction: "incoming",
      // Absent would mean a realtime-service older than phase 2.5.
      media: payload["media"] === "video" ? "video" : "audio",
      state: "ringing",
      micMuted: false,
      cameraOff: false,
      cameraMissing: false,
      sharingScreen: false,
      micSilent: false,
      sendingVideo: false,
      activeSince: null,
      relayAvailable: false,
    });
    this.ring.startRinging();
  }

  /** The 1:1 answer. A group never sends one — it joins and negotiates pairwise. */
  private async onAnswered(payload: Record<string, unknown>): Promise<void> {
    const call = this.callState();
    const sdp = payload["sdp"] as RTCSessionDescriptionInit | undefined;
    if (!call || !sdp) return;
    if (call.callId && call.callId !== String(payload["call_id"] ?? "")) return;

    const from = String(payload["from"] ?? "") || this.peerOwnerId();
    const link = this.links.get(from);
    if (!link) return;

    this.patch({
      state: "connecting",
      joinedIds: this.withOwner(call.joinedIds, from),
    });
    try {
      await link.pc.setRemoteDescription(sdp);
      this.drainCandidates(from);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Somebody joined or left the call.
   *
   * The frame carries the **whole** joined set rather than a delta, so this
   * reconciles against it instead of applying the announced transition: core
   * NATS is fire-and-forget, and a client that missed one frame re-syncs from
   * the next rather than holding a connection to somebody who left.
   */
  private async onParticipant(payload: Record<string, unknown>): Promise<void> {
    const call = this.callState();
    if (!call) return;
    if (call.callId && String(payload["call_id"] ?? "") !== call.callId) return;

    const joined = this.ownerIds(payload["participants"]);
    this.patch({ joinedIds: joined });

    /*
     * This announcement goes to everyone *invited*, not to everyone in the
     * call — which is deliberate, so a tab that is still ringing can watch the
     * room fill up. But it must not start building connections from a call it
     * has not joined: until this person is in the joined set there is nothing
     * to connect to them about.
     */
    if (!this.selfOwnerId || !joined.includes(this.selfOwnerId)) return;

    // Our place is confirmed, so a Join in flight has succeeded.
    this.clearJoinTimer();

    const others = joined.filter((ownerId) => ownerId !== this.selfOwnerId);

    // The first person to arrive is what turns a ring into a connection — for
    // the caller, who never answers anything and so has no other transition.
    if (others.length > 0 && call.state === "ringing") {
      this.patch({ state: "connecting" });
    }

    for (const ownerId of [...this.links.keys()]) {
      if (!others.includes(ownerId)) this.dropLink(ownerId);
    }
    for (const ownerId of others) {
      /*
       * Whether the pair already existed decides whether it needs repairing.
       *
       * A new link opens itself: adding local tracks raises
       * `onnegotiationneeded`, and that event *is* the pair's first offer.
       * A link we already hold does not, and there is one case where it is
       * holding an offer that reached nobody — a 1:1 invite whose callee had
       * no socket yet. They join later instead of answering, and this frame is
       * the first moment we learn they are in, so the offer has to be made
       * again or the pair stays dark forever.
       */
      const existed = this.links.has(ownerId);
      const link = await this.ensureLink(ownerId, true).catch((error) => {
        this.failLink(ownerId, error);
        return null;
      });
      if (
        link &&
        existed &&
        link.initiator &&
        !link.pc.remoteDescription &&
        !link.makingOffer
      ) {
        void this.negotiate(link);
      }
    }
  }

  private async onRemoteCandidate(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const candidate = payload["candidate"] as RTCIceCandidateInit | undefined;
    if (!candidate) return;

    // `from` is stamped by the server. The fallback covers a 1:1 relay from a
    // realtime-service old enough not to stamp it.
    const from = String(payload["from"] ?? "") || this.peerOwnerId();
    if (!from) return;

    const link = this.links.get(from);
    if (!link || !link.pc.remoteDescription) {
      const queue = this.pendingCandidates.get(from) ?? [];
      queue.push(candidate);
      this.pendingCandidates.set(from, queue);
      return;
    }
    try {
      await link.pc.addIceCandidate(candidate);
    } catch {
      // A candidate the browser rejects is normal during a gather race; ICE
      // succeeds on whichever pair does work.
    }
  }

  private onEnded(payload: Record<string, unknown>): void {
    const call = this.callState();
    if (!call) return;

    const callId = String(payload["call_id"] ?? "");
    if (call.callId && callId && call.callId !== callId) return;

    const reason = String(payload["reason"] ?? "hangup") as CallEndReason;

    /*
     * A Join that lost the race for this person's place: another tab of the
     * same person already holds it, so the server answers this tab's
     * `call.join` with `answered_elsewhere`. The guard below cannot catch it —
     * a joining tab is `connecting` and never `ringing` — and without this it
     * would sit silent until the join timeout wiped it with nothing on screen,
     * which is indistinguishable from Join being broken.
     */
    if (reason === "answered_elsewhere" && this.joinTimer !== null) {
      this.abandonJoin();
      this.showEndNotice({ reason, peerOwnerId: "", group: true });
      return;
    }

    // `answered_elsewhere` goes to the whole owner subject so the callee's
    // *other* tabs stop ringing — which means the tab that won the race gets
    // it too. Holding the call means we are that tab, so ignore it.
    if (reason === "answered_elsewhere" && call.state !== "ringing") {
      return;
    }

    this.finish(reason);
  }

  /**
   * Offers on one link.
   *
   * Two gates, and both matter. A link whose **first** offer belongs to the
   * other side must stay quiet until that offer arrives: adding local tracks
   * fires `onnegotiationneeded` on *both* ends of a fresh pair, and a group
   * call is already active by then, so the usual "not until active" guard
   * would let both sides offer into a collision on every single pair. And a
   * 1:1 link must stay quiet until the call is active, because its first
   * exchange rides the invite and the answer instead.
   */
  private async negotiate(link: PeerLink): Promise<void> {
    const call = this.callState();
    if (!call?.callId) return;
    if (!link.viaRenegotiate && call.state !== "active") return;
    if (!link.initiator && !link.pc.remoteDescription) return;
    /*
     * An offer is already in flight for this pair. A browser coalesces the
     * track changes that caused it into one event, but nothing guarantees
     * that — and a second offer built before the first is answered is a
     * collision with ourselves.
     */
    if (link.makingOffer) return;

    try {
      link.makingOffer = true;
      const offer = await link.pc.createOffer();
      await link.pc.setLocalDescription(offer);
      this.realtime.renegotiateCall(
        call.callId,
        link.pc.localDescription ?? offer,
        this.localScreenState()?.id ?? null,
        link.ownerId,
      );
    } catch (error) {
      this.failLink(link.ownerId, error);
    } finally {
      link.makingOffer = false;
    }
  }

  /**
   * Handles one peer's mid-call offer or answer.
   *
   * The collision rule is the standard one, applied per pair: an **offer**
   * that arrives while we are building our own for that pair, or while that
   * connection is not `stable`, crossed ours. The impolite peer ignores it and
   * keeps its own; the polite peer takes it, and `setRemoteDescription` rolls
   * our half back implicitly.
   *
   * An **answer** is never a collision — it can only be a reply to an offer we
   * sent.
   */
  private async onRenegotiate(payload: Record<string, unknown>): Promise<void> {
    const call = this.callState();
    const sdp = payload["sdp"] as RTCSessionDescriptionInit | undefined;
    if (!call?.callId || !sdp) return;
    if (String(payload["call_id"] ?? "") !== call.callId) return;

    const from = String(payload["from"] ?? "") || this.peerOwnerId();
    /*
     * Never negotiate with somebody the call did not invite. The server
     * already refuses to relay from an outsider, but the invited set is known
     * here too and checking it costs nothing — a relay bug must not become a
     * connection to a stranger.
     */
    if (!from || !call.participantIds.includes(from)) return;

    /*
     * The offer can arrive before the announcement that this person joined —
     * different subjects, no ordering between them — so the link is built on
     * demand rather than assumed to exist.
     */
    let link: PeerLink;
    try {
      link = await this.ensureLink(from, call.participantIds.length > 2);
    } catch (error) {
      this.failLink(from, error);
      return;
    }

    // Which stream is their screen can arrive before or after its track.
    const screenId = payload["screen_stream_id"];
    link.screenStreamId =
      typeof screenId === "string" && screenId ? screenId : null;
    if (link.screenStreamId) {
      const known = this.remoteState().get(from);
      if (known?.stream?.id === link.screenStreamId) {
        this.fileRemoteTrack(link, known.stream);
      }
    }

    const collision =
      sdp.type === "offer" &&
      (link.makingOffer || link.pc.signalingState !== "stable");
    if (collision && !this.politeTo(from)) return;

    try {
      await link.pc.setRemoteDescription(sdp);
      this.drainCandidates(from);
      if (sdp.type !== "offer") {
        this.syncRemoteVideo(link);
        return;
      }

      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      this.realtime.renegotiateCall(
        call.callId,
        link.pc.localDescription ?? answer,
        this.localScreenState()?.id ?? null,
        from,
      );
      this.syncRemoteVideo(link);
    } catch (error) {
      this.failLink(from, error);
    }
  }

  /**
   * Turns a live audio call into a video one.
   *
   * Adding the track is all this does: the track change fires
   * `onnegotiationneeded` on every link, which is what actually re-offers.
   * Driving the renegotiation by hand here would bypass the collision guards.
   */
  async promoteToVideo(): Promise<void> {
    const call = this.callState();
    // `sendingVideo`, not `media`: someone who answered a video call without a
    // camera, or who joined by voice, is in the same position — no track of
    // their own to send — and both must be able to add one.
    if (!call || call.sendingVideo || call.state !== "active") return;
    if (this.links.size === 0 || !this.localMedia) return;

    const camera = await this.getUserMedia(constraintsFor("video"));
    const [video] = camera.getVideoTracks();
    if (!video) return;

    // The audio track this call already has must be left alone — the camera
    // stream's own microphone track is dropped rather than added twice.
    for (const spare of camera.getAudioTracks()) spare.stop();

    for (const link of this.links.values()) {
      link.pc.addTrack(video, this.localMedia);
    }
    this.localMedia.addTrack(video);
    this.localStreamState.set(this.localMedia);
    this.patch({ media: "video", cameraOff: false, sendingVideo: true });
  }

  /**
   * Opens the microphone, and the camera when one is wanted.
   *
   * Once per call, not once per link: one capture feeds every connection, and
   * opening the camera N times would fail on the second.
   *
   * **A missing camera must never fail the call.** Meet, Zoom, Teams and
   * Messenger all let you join a video call without one: your tile shows an
   * avatar and you still see everyone else. Refusing outright — or greying out
   * the button — takes away a call that would have worked (reported
   * 2026-09-11 on a machine with no camera, where it failed instantly with
   * `NotFoundError`).
   *
   * The retry needs no error classification: whatever went wrong, if audio
   * alone succeeds the call is worth having, and if audio fails too the
   * original cause is rethrown and surfaced by name.
   */
  private async openLocalMedia(media: CallMedia): Promise<void> {
    if (this.localMedia) return;

    let stream: MediaStream;
    let cameraMissing = false;
    if (media !== "video") {
      stream = await this.getUserMedia(constraintsFor("audio"));
    } else {
      try {
        stream = await this.getUserMedia(constraintsFor("video"));
      } catch (cameraError) {
        try {
          stream = await this.getUserMedia(constraintsFor("audio"));
          cameraMissing = true;
        } catch {
          // Audio failed as well, so this is not a camera problem at all —
          // report what actually went wrong first.
          throw cameraError;
        }
      }
    }

    /*
     * The call may be gone already: capture is opened *after* the join is sent,
     * so a `call_gone` or a lost takeover can clear the call while
     * `getUserMedia` is still resolving. `teardown` stops the tracks it can see
     * and cannot see this one, so without this the microphone stays open with
     * no call attached to it — a live recording indicator and a stream nothing
     * will ever stop.
     */
    if (!this.callState()) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    this.localMedia = stream;
    this.localStreamState.set(stream);
    this.patch({
      cameraMissing,
      sendingVideo: media === "video" && !cameraMissing,
    });
  }

  /**
   * Returns this call's connection to one person, building it if needed.
   *
   * Idempotent under concurrency: two frames from the same peer inside the
   * build window must share one connection, or each would negotiate against a
   * description the other never sees.
   */
  private async ensureLink(
    ownerId: string,
    viaRenegotiate: boolean,
  ): Promise<PeerLink> {
    const existing = this.links.get(ownerId);
    if (existing) return existing;

    const building = this.linkBuilds.get(ownerId);
    if (building) return building;

    const build = this.buildLink(ownerId, viaRenegotiate);
    this.linkBuilds.set(ownerId, build);
    try {
      return await build;
    } finally {
      this.linkBuilds.delete(ownerId);
    }
  }

  /** Builds one peer connection, wires it, and attaches the shared local media. */
  private async buildLink(
    ownerId: string,
    viaRenegotiate: boolean,
  ): Promise<PeerLink> {
    const credentials = await this.iceCredentials();
    this.patch({ relayAvailable: credentials.relay });

    const pc = this.createPeerConnection({
      iceServers: credentials.iceServers,
    });
    const link: PeerLink = {
      ownerId,
      pc,
      initiator: this.selfOwnerId < ownerId,
      viaRenegotiate,
      makingOffer: false,
      screenStreamId: null,
      audio: null,
    };

    /*
     * Registered before the first `await` below would have a chance to yield,
     * so a second frame from this peer finds the link rather than starting a
     * second build. `ensureLink`'s in-flight map covers the same window; this
     * is the cheaper half of the same guarantee.
     */
    this.links.set(ownerId, link);
    this.setPeer(ownerId, {
      ownerId,
      stream: null,
      screen: null,
      state: "connecting",
      speaking: false,
    });

    pc.onicecandidate = (event) => {
      const callId = this.callState()?.callId;
      // A null candidate is the end-of-gather marker, not something to relay.
      if (!event.candidate || !callId) return;
      this.realtime.sendIceCandidate(callId, event.candidate.toJSON(), ownerId);
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? null;

      /*
       * Audio goes to this link's own element. Sound does **not** come from a
       * dock `<video>`: the element here survives the dock re-rendering, and
       * the autoplay unlock stays in one place. A dock video must therefore be
       * muted, or a peer is heard twice.
       */
      if (event.track.kind === "audio") {
        this.attachAudio(link, stream);
        return;
      }

      /*
       * Only *video* is filed as a tile. The audio track arrives on a stream
       * too, and treating that as "this peer has video" hid their avatar
       * behind an empty <video> the moment the call connected (2026-09-11).
       */
      if (event.track.kind !== "video") return;

      // A call becomes a video call the moment a *camera* track arrives,
      // rather than on a flag the sides have to agree about separately. A
      // shared screen does not: the two are told apart by the
      // `screen_stream_id` the peer sends with its renegotiation, which is the
      // only thing in the signalling that says which is which. Without the
      // distinction, presenting during a voice call renamed it a video call.
      const isScreen = Boolean(
        link.screenStreamId && stream?.id === link.screenStreamId,
      );
      if (!isScreen && this.callState()?.media !== "video") {
        this.patch({ media: "video" });
      }
      this.fileRemoteTrack(link, stream);

      /*
       * And when it goes away, stop showing a tile for it.
       *
       * `ended` only, never `mute`: a peer turning their camera off disables
       * the track, which mutes it without ending it, and collapsing their tile
       * for that would be wrong. A removed track is the real end.
       */
      event.track.addEventListener("ended", () =>
        this.onRemoteVideoEnded(link),
      );
    };

    /*
     * Perfect negotiation, per pair.
     *
     * Fires whenever this link's tracks change — adding a camera, starting or
     * stopping a screen share, `replaceTrack` with an incompatible codec. The
     * gates live in `negotiate`, which is what stops a fresh pair offering
     * from both ends at once.
     */
    pc.onnegotiationneeded = () => {
      void this.negotiate(link);
    };

    pc.oniceconnectionstatechange = () => {
      switch (pc.iceConnectionState) {
        case "connected":
        case "completed":
          this.patchPeer(ownerId, { state: "connected" });
          if (this.callState()?.state !== "active") {
            this.patch({ state: "active", activeSince: Date.now() });
          }
          return;
        case "failed":
          /*
           * No candidate pair worked — the case coturn exists for. In a 1:1
           * that is the call; in a group it is one tile, and ending everyone
           * else's call because one pair could not find a path would be a far
           * worse answer than showing that one person as unreachable.
           */
          this.patchPeer(ownerId, { state: "failed" });
          if (!this.isGroupCall()) {
            this.errorState.set("ICE_FAILED");
            this.hangUp("ice_failed");
          }
          return;
        default:
          return;
      }
    };

    /*
     * Tracks last, after every handler is attached.
     *
     * Adding them is what fires `onnegotiationneeded`, and in a group that
     * event *is* the first offer — so a handler attached afterwards misses the
     * only thing that would open the pair. A browser queues the event as a
     * task and would forgive the order; nothing else would tell us, which is
     * exactly why it is worth not relying on.
     */
    // A rejoin sends its join before opening capture, so this may still be in
    // flight; without waiting, the first pair of a restored call negotiates
    // with no tracks on it.
    if (this.mediaReady) await this.mediaReady;

    const local = this.localMedia;
    if (local) {
      for (const track of local.getTracks()) pc.addTrack(track, local);
    }

    const call = this.callState();
    if (call?.media === "video" && call.cameraMissing) {
      /*
       * Receiving video needs no camera of our own. Without this transceiver
       * the SDP would offer no video at all and the peer could not send any,
       * so a missing webcam would silently downgrade *both* sides.
       */
      pc.addTransceiver("video", { direction: "recvonly" });
    }

    // Already presenting when this person arrived: they get the screen too,
    // or they would be the only one in the call who cannot see it.
    const screen = this.localScreenState();
    if (this.screenTrack && screen) pc.addTrack(this.screenTrack, screen);

    // Anything that arrived while this was being built.
    if (pc.remoteDescription) this.drainCandidates(ownerId);

    return link;
  }

  /** Cached until shortly before expiry — a mid-call refetch is wasted work. */
  private async iceCredentials(): Promise<IceCredentials> {
    const cached = this.credentials;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const value = await firstValueFrom(this.api.turnCredentials());
      this.credentials = {
        value,
        expiresAt: Date.now() + value.ttl * 1_000 - CREDENTIAL_SAFETY_MARGIN_MS,
      };
      return value;
    } catch {
      // Without credentials a call can still connect on a local network, so
      // this degrades rather than fails. It is the symmetric-NAT case that
      // breaks, which is the one nobody notices locally.
      return { iceServers: [], ttl: 0, relay: false };
    }
  }

  /** Gives one peer their own playback element, once. */
  private attachAudio(link: PeerLink, stream: MediaStream | null): void {
    if (!stream) return;
    if (!link.audio) {
      link.audio = new Audio();
      link.audio.autoplay = true;

      /*
       * Autoplay can be refused at the moment the stream is attached and then
       * succeed a beat later, once the element has data. The warning must
       * clear when it does — left latched it sat there in red for the whole
       * call while audio was plainly working (seen 2026-09-11).
       */
      link.audio.addEventListener("playing", () => {
        if (this.errorState() === "AUDIO_BLOCKED") this.errorState.set(null);
      });
    }
    link.audio.srcObject = stream;
    void link.audio.play().catch(() => {
      // Autoplay policy. The user has necessarily interacted to answer, so
      // this is rare; the dock surfaces it rather than failing silently.
      this.errorState.set("AUDIO_BLOCKED");
    });
  }

  /**
   * One peer's video has gone for good.
   *
   * Their stream is dropped so nothing renders a frozen last frame, but the
   * call **stays a video call**. Collapsing back to the compact audio dock the
   * moment a screen share ended yanked the panel out from under both people
   * (reported 2026-09-11); Meet keeps you in the same layout and shows avatars
   * instead. Once a call has carried video it keeps the stage until someone
   * minimises it or hangs up.
   */
  private onRemoteVideoEnded(link: PeerLink): void {
    this.patchPeer(link.ownerId, { stream: null, screen: null });
  }

  /**
   * Files an incoming video stream as this peer's camera or their screen.
   *
   * Nothing in a track says which it is, so the sender tells us the stream id
   * that carries their screen. The two can arrive in either order — the frame
   * may land before or after `ontrack` — so both paths call this and it simply
   * re-decides with whatever is currently known.
   */
  private fileRemoteTrack(link: PeerLink, stream: MediaStream | null): void {
    if (!stream) return;
    const current = this.remoteState().get(link.ownerId);
    if (link.screenStreamId && stream.id === link.screenStreamId) {
      this.patchPeer(link.ownerId, {
        screen: stream,
        // The same stream cannot be both; a late `screen_stream_id` re-files a
        // track that had been taken for a camera.
        ...(current?.stream?.id === stream.id ? { stream: null } : {}),
      });
      return;
    }
    this.patchPeer(link.ownerId, { stream });
  }

  /**
   * Decides whether a peer is still sending video, after a renegotiation.
   *
   * `removeTrack` does **not** end the receiver's track — it fires `mute`, and
   * a peer simply switching their camera off fires `mute` too. The events are
   * indistinguishable, which is why stopping a share left the other side
   * frozen on its last frame (2026-09-11).
   *
   * The transceivers are what separate them: a removed track renegotiates its
   * m-line out of receiving, while a disabled camera leaves it receiving a
   * muted track. Checked per track rather than "is any video arriving", so
   * someone who stops presenting while keeping their camera on loses the
   * screen tile and keeps the other. That value is only trustworthy once an
   * exchange has been applied, so this runs at the end of one.
   */
  private syncRemoteVideo(link: PeerLink): void {
    const transceivers = link.pc.getTransceivers?.();
    if (!transceivers) return;

    const live = new Set<MediaStreamTrack>();
    for (const transceiver of transceivers) {
      const track = transceiver.receiver?.track;
      if (!track || track.kind !== "video") continue;
      if (
        transceiver.currentDirection === "sendrecv" ||
        transceiver.currentDirection === "recvonly"
      ) {
        live.add(track);
      }
    }

    const peer = this.remoteState().get(link.ownerId);
    if (!peer) return;
    const stillLive = (stream: MediaStream | null): boolean =>
      stream !== null && stream.getVideoTracks().some((t) => live.has(t));

    this.patchPeer(link.ownerId, {
      stream: stillLive(peer.stream) ? peer.stream : null,
      screen: stillLive(peer.screen) ? peer.screen : null,
    });
  }

  private drainCandidates(ownerId: string): void {
    const queued = this.pendingCandidates.get(ownerId);
    if (!queued) return;
    this.pendingCandidates.delete(ownerId);
    const link = this.links.get(ownerId);
    for (const candidate of queued) {
      void link?.pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private setPeer(ownerId: string, peer: RemotePeer): void {
    this.remoteState.update((current) => {
      const next = new Map(current);
      next.set(ownerId, peer);
      return next;
    });
  }

  private patchPeer(ownerId: string, changes: Partial<RemotePeer>): void {
    this.remoteState.update((current) => {
      const existing = current.get(ownerId);
      if (!existing) return current;
      const next = new Map(current);
      next.set(ownerId, { ...existing, ...changes });
      return next;
    });
  }

  private patch(changes: Partial<LiveCall>): void {
    this.callState.update((current) =>
      current ? { ...current, ...changes } : current,
    );
  }

  /** The invited set as this client believes it: everyone, self included, sorted. */
  private invitedSet(ownerIds: readonly string[]): readonly string[] {
    const set = new Set(ownerIds.filter((id) => id));
    if (this.selfOwnerId) set.add(this.selfOwnerId);
    return [...set].sort();
  }

  private withOwner(
    ownerIds: readonly string[],
    ownerId: string,
  ): readonly string[] {
    return ownerIds.includes(ownerId) ? ownerIds : [...ownerIds, ownerId];
  }

  /** A wire array of owner ids, or an empty one — never a half-parsed list. */
  private ownerIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  /**
   * One pair could not be established.
   *
   * In a 1:1 that is the call failing, and it is reported by name. In a group
   * it is one tile: the others are still talking, and taking their call away
   * because a fourth person's path did not come up would be the wrong trade.
   */
  private failLink(ownerId: string, error: unknown): void {
    if (!this.isGroupCall()) {
      this.fail(error);
      return;
    }
    if (!environment.production) console.error("[call link]", ownerId, error);
    this.patchPeer(ownerId, { state: "failed" });
  }

  /**
   * Named causes only — "the call could not connect" sends people to the wrong
   * place. Every one of these is a different thing to do about it, and they are
   * all reachable the moment a call asks for a camera as well as a microphone
   * (reported 2026-09-11: a video call failed instantly with the generic
   * message, because only the permission cases were classified).
   */
  private mediaErrorCode(error: unknown): string {
    const name = (error as { name?: string }).name ?? "";
    return (
      {
        // Permission refused, or a page that is not a secure context.
        NotAllowedError: "MEDIA_DENIED",
        SecurityError: "MEDIA_DENIED",
        // No device of that kind exists at all.
        NotFoundError: "MEDIA_MISSING",
        // It exists but something else holds it — another app, or another tab.
        NotReadableError: "MEDIA_BUSY",
        AbortError: "MEDIA_BUSY",
        // The device cannot do what was asked of it.
        OverconstrainedError: "MEDIA_UNSUPPORTED",
      }[name] ?? "CALL_FAILED"
    );
  }

  private fail(error: unknown): void {
    const name = (error as { name?: string }).name ?? "";
    this.errorState.set(this.mediaErrorCode(error));

    if (!environment.production) {
      // The classification above is a guess until it has met a real device.
      console.error("[call failed]", name, error);
    }
    const call = this.callState();
    if (call?.callId) {
      this.realtime.hangupCall(call.callId, "ice_failed");
    }
    this.finish("ice_failed");
  }

  /** Ends the call locally: state, media and every connection released. */
  private finish(reason: CallEndReason): void {
    const call = this.callState();
    const group = (call?.participantIds.length ?? 0) > 2;
    const peerOwnerId = group ? "" : this.peerOwnerId();
    this.teardown();
    this.callState.set(null);

    // `answered_elsewhere` is not news to the person: they answered on another
    // tab. Every other reason is.
    if (reason !== "answered_elsewhere") {
      this.showEndNotice({ reason, peerOwnerId, group });
    }
  }

  private showEndNotice(notice: CallEndNotice): void {
    this.endNoticeState.set(notice);
    if (this.endNoticeTimer !== null) clearTimeout(this.endNoticeTimer);
    this.endNoticeTimer = setTimeout(() => {
      this.endNoticeTimer = null;
      this.endNoticeState.set(null);
    }, END_NOTICE_MS);
  }

  /**
   * Samples one connection's transport and capture settings.
   *
   * Phase 2.5 slice 0: unclear audio has several possible causes that cannot
   * be told apart by reasoning, so this reads the numbers that separate them.
   * `ownerId` picks a leg of the mesh; without one it reports the first, which
   * is the only leg a 1:1 call has. Returns null when there is nothing to
   * measure.
   */
  async diagnostics(ownerId?: string): Promise<CallDiagnostics | null> {
    const link = ownerId
      ? this.links.get(ownerId)
      : this.links.values().next().value;
    if (!link) return null;
    const report = await link.pc.getStats();
    return readDiagnostics(
      report as unknown as Iterable<Record<string, unknown>>,
    );
  }

  /** Dismisses the notice early — the dock offers a close button. */
  clearEndNotice(): void {
    if (this.endNoticeTimer !== null) {
      clearTimeout(this.endNoticeTimer);
      this.endNoticeTimer = null;
    }
    this.endNoticeState.set(null);
  }

  /**
   * Releases one leg of the mesh, leaving the rest of the call alone.
   *
   * This is what makes a group call survivable: somebody hanging up is a tile
   * closing, not a call ending. The server decides when a call is actually
   * spent and says so with `call.ended`.
   */
  private dropLink(ownerId: string): void {
    const link = this.links.get(ownerId);
    if (!link) return;
    this.links.delete(ownerId);
    this.pendingCandidates.delete(ownerId);

    if (link.audio) {
      link.audio.srcObject = null;
      link.audio = null;
    }

    // Handlers cleared before close: a late event on a closed connection would
    // otherwise reopen state we have just released.
    link.pc.onicecandidate = null;
    link.pc.ontrack = null;
    link.pc.onnegotiationneeded = null;
    link.pc.oniceconnectionstatechange = null;
    link.pc.close();

    this.remoteState.update((current) => {
      if (!current.has(ownerId)) return current;
      const next = new Map(current);
      next.delete(ownerId);
      return next;
    });
  }

  private teardown(): void {
    this.ring.stopRinging();
    this.clearJoinTimer();
    this.pendingOffer = null;
    this.pendingCandidates.clear();
    this.linkBuilds.clear();
    this.mediaReady = null;

    for (const ownerId of [...this.links.keys()]) this.dropLink(ownerId);

    for (const track of this.localMedia?.getTracks() ?? []) {
      track.stop();
    }
    /*
     * The shared screen is its own track on its own stream, so it is not in
     * localMedia — ending a call left it running, and the browser kept saying
     * the tab was being shared (reported 2026-09-11).
     */
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.localScreenState.set(null);
    this.localMedia = null;
    this.silentSamples = 0;
    this.localStreamState.set(null);
    this.remoteState.set(new Map());
  }
}
