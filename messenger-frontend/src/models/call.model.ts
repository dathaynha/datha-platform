/** Call shapes: the socket protocol's `call.*` frames and the REST history. */

/** Reasons a client may assert. `missed` and `answered_elsewhere` are the
 *  server's to decide, and realtime-service refuses them in a frame. */
export type CallHangupReason = "hangup" | "declined" | "busy" | "ice_failed";

/**
 * Every reason that can arrive in `call.ended`.
 *
 * `empty` is the group case and is the server's alone: a mesh that drops below
 * two people is a person looking at themselves, so it ends itself rather than
 * waiting for someone to press a button.
 */
export type CallEndReason =
  CallHangupReason | "missed" | "answered_elsewhere" | "empty";

/**
 * What a **history row** may say, which is not what a frame may say.
 *
 * `expired` is messenger-service's own conclusion that a call outlived any
 * possible call — written when nothing ever published `call.ended`, because the
 * process that would have published it died. It can therefore only ever reach
 * this client through `GET /calls`, never through the socket, which is why it
 * is not in `CallEndReason` proper: a `CallEndNotice` carrying it would be
 * describing an ending nobody was present for.
 *
 * Added 2026-09-15, when `messenger-service` gained the reason and this type
 * quietly could not represent it.
 */
export type CallHistoryEndReason = CallEndReason | "expired";

/**
 * How a call was set up.
 *
 * A property of the call rather than of the moment: history renders a video
 * call differently, and the callee's ring needs to know before answering so it
 * can warm the camera permission.
 */
export type CallMedia = "audio" | "video";

/** Status of a call as the history endpoint reports it. */
export type CallHistoryStatus =
  "ringing" | "active" | "completed" | "missed" | "declined";

/** A row from `GET /calls` or `GET /conversations/:id/calls`. */
export interface CallRecord {
  id: string;
  conversationId: string;
  callerOwnerId: string;
  /**
   * Null for a group call, which has no single callee.
   *
   * `messenger-service` has returned null here since phase 3 slice 2 (!182,
   * which dropped the column's NOT NULL); this type claimed otherwise until
   * slice 3, and only no group call having happened yet kept it from lying in
   * practice.
   */
  calleeOwnerId: string | null;
  /**
   * Everyone invited to the call, the caller included.
   *
   * Empty for rows projected before slice 2, which have no `call_participants`
   * rows at all — so a renderer falls back to caller/callee rather than
   * claiming a call had nobody on it.
   */
  participantOwnerIds: string[];
  /**
   * Everyone who actually joined at any point — a subset of the invited set.
   *
   * Not the same question as who was invited: a four-way call somebody drops
   * out of early still had them on it, and a call nobody picked up has an
   * empty set rather than a missing one.
   */
  joinedOwnerIds: string[];
  media: CallMedia;
  status: CallHistoryStatus;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: CallHistoryEndReason | null;
  durationSeconds: number;
}

/** `GET /api/realtime/turn-credentials` — feeds RTCPeerConnection directly. */
export interface IceCredentials {
  iceServers: RTCIceServer[];
  /** Seconds until the credential expires; refresh before then. */
  ttl: number;
  /** False when no TURN relay is on offer (STUN only). */
  relay: boolean;
}

/**
 * Where a live call is in its lifecycle.
 *
 * `connecting` is the gap between signalling completing and ICE actually
 * connecting — the phase where a missing TURN relay shows up, so the UI must
 * not claim the call is up until `active`.
 *
 * There is no `ended` member: a finished call is `null`, and why it ended is
 * carried by `CallEndNotice` instead. A state nothing can observe is state that
 * drifts.
 */
export type LiveCallState = "ringing" | "connecting" | "active";

export interface LiveCall {
  /** Server-issued. Null only between `call.invite` and `call.ringing`. */
  callId: string | null;
  conversationId: string;
  /**
   * Everyone the call rang, this user included, sorted.
   *
   * The **invited** set: resolved by the server from conversation membership
   * at creation and never widened, which is the whole authorization surface
   * for signalling. There is no `peerOwnerId` field because a 1:1 peer is
   * derivable from this and a group has no single peer — storing both would be
   * two sources of truth for one fact.
   */
  participantIds: readonly string[];
  /**
   * Who placed the call.
   *
   * Carried rather than derived: in a group there is no other way to say whose
   * ring this is, and "the first participant" is not the answer — the invited
   * set is sorted by owner id, which has nothing to do with who dialled.
   */
  callerOwnerId: string;
  /**
   * Who is actually in the call right now, this user included once joined.
   *
   * Replaced wholesale from each `call.participant` frame rather than patched
   * by a delta: the frame carries the full set precisely so a client that
   * missed one re-syncs instead of drifting.
   */
  joinedIds: readonly string[];
  direction: "outgoing" | "incoming";
  media: CallMedia;
  state: LiveCallState;
  micMuted: boolean;
  /** Camera suppressed locally. Only meaningful while `media` is `video`. */
  cameraOff: boolean;
  /**
   * A video call joined without a camera of our own.
   *
   * Not an error: the peer's video still arrives, and our tile shows an avatar
   * — which is what every mainstream client does rather than refusing the call.
   */
  cameraMissing: boolean;
  /** This side is sending a screen instead of (or as well as) a camera. */
  sharingScreen: boolean;
  /**
   * Our own microphone has gone silent while unmuted.
   *
   * Only the sender can see this — the other end just hears nothing — so it is
   * surfaced here rather than left for them to report.
   */
  micSilent: boolean;
  /**
   * This side has a video track of its own to preview.
   *
   * False on a call that became video because the *peer* turned a camera or a
   * screen on — we have nothing to show, and an empty `<video>` renders as a
   * black rectangle rather than as an explanation.
   */
  sendingVideo: boolean;
  /** Epoch ms the call became `active`; null until then, so the timer is honest. */
  activeSince: number | null;
  /** True when the credential handed out carried no TURN relay. */
  relayAvailable: boolean;
}

/**
 * Why the last call ended, shown briefly after the dock's call clears.
 *
 * The server distinguishes `declined` from `missed` from `hangup` precisely so
 * a person can tell the difference; dropping the panel with no explanation
 * would throw that away.
 */
export interface CallEndNotice {
  reason: CallEndReason;
  /** Empty for a group call, where "declined by X" names nobody in particular. */
  peerOwnerId: string;
  /** True when the call that ended was a group one, so the wording can differ. */
  group: boolean;
}

/**
 * How one leg of the mesh is doing.
 *
 * `connecting` covers everything before ICE nominates a pair; `failed` means
 * no candidate pair worked for **this pair only**. In a group that is one dead
 * tile rather than a dead call, which is why it is a property of the peer
 * rather than of the call.
 */
export type PeerLinkState = "connecting" | "connected" | "failed";

/**
 * One other person in the call, as the dock renders them.
 *
 * A mesh has N-1 of these and a 1:1 call has exactly one, so the dock lays out
 * an array in both cases rather than carrying a second layout for the pair —
 * two mechanisms for one job is how the stage came to render at the compact
 * width (2026-09-11).
 */
export interface RemotePeer {
  ownerId: string;
  /** Their camera, or null while they have none to send. */
  stream: MediaStream | null;
  /** Their shared screen, which is a second track and never replaces a camera. */
  screen: MediaStream | null;
  state: PeerLinkState;
  /**
   * They are talking right now.
   *
   * Sampled from the inbound audio level rather than signalled: a mesh has no
   * server to tell anyone who is speaking, and the receiver already knows. It
   * is per-viewer and approximate by nature — nothing depends on it being
   * exactly right, which is why it drives a border and nothing else.
   */
  speaking: boolean;
}
