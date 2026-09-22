import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { Subject } from "rxjs";
import { environment } from "src/environments/environment";
import { OAuthService } from "angular-oauth2-oidc";
import { RealtimeService, type RealtimeFrame } from "./realtime.service";
import { RingAudioService } from "./ring-audio.service";
import {
  DISPLAY_MEDIA,
  PEER_CONNECTION_FACTORY,
  USER_MEDIA,
  WebrtcCallService,
} from "./webrtc-call.service";

const TURN_URL = environment.realtime.tokenUrl.replace(
  /\/token$/,
  "/turn-credentials",
);

/** An access token shaped like the gateway's: `sub` is the platform owner id. */
const tokenFor = (ownerId: string) =>
  `x.${btoa(JSON.stringify({ sub: ownerId }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")}.y`;

/** Reassigned per test so the OAuth stub can answer differently. */
let accessToken: string | null = null;

const SELF = "google_aaa";
const PEER = "google_zzz";
/** Sorts *below* SELF, so this side is not the one that offers first. */
const LOWER = "google_000";
const THIRD = "google_mmm";
const CALL_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

const OFFER: RTCSessionDescriptionInit = { type: "offer", sdp: "v=0\r\n" };
const ANSWER: RTCSessionDescriptionInit = { type: "answer", sdp: "v=0\r\na=x" };
const CANDIDATE: RTCIceCandidateInit = {
  candidate: "candidate:1 1 UDP 1 h 1 typ host",
};

/**
 * A stand-in for RTCPeerConnection. The browser stack is the seam this service
 * manages, so the tests drive its callbacks rather than assert on internals.
 */
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  readonly addedTracks: MediaStreamTrack[] = [];
  closed = false;

  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  constructor(readonly config: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve(OFFER);
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve(ANSWER);
  }

  readonly transceivers: { kind: string; direction: string }[] = [];

  addTransceiver(kind: string, init?: { direction?: string }): void {
    this.transceivers.push({ kind, direction: init?.direction ?? "sendrecv" });
  }

  /** Counted so a test can assert that nothing renegotiated. */
  localDescriptionCount = 0;

  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    this.localDescriptionCount += 1;
    return Promise.resolve();
  }

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    return Promise.resolve();
  }

  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescription) {
      return Promise.reject(new Error("no remote description"));
    }
    this.addedCandidates.push(candidate);
    return Promise.resolve();
  }

  removeTrack(sender: { track: MediaStreamTrack | null }): void {
    this.senders = this.senders.filter((s) => s !== sender);
    this.onnegotiationneeded?.();
  }

  senders: { track: MediaStreamTrack | null }[] = [];

  getSenders(): { track: MediaStreamTrack | null }[] {
    return this.senders;
  }

  /**
   * The inbound audio level this link reports, as a receiver would.
   *
   * `getSynchronizationSources` is how a mesh client works out who is talking
   * without a server to tell it — there is nobody else to ask.
   */
  incomingAudioLevel: number | null = null;

  getReceivers(): {
    track: { kind: string } | null;
    getSynchronizationSources?: () => { audioLevel?: number }[];
  }[] {
    return [
      {
        track: { kind: "audio" },
        getSynchronizationSources: () =>
          this.incomingAudioLevel === null
            ? []
            : [{ audioLevel: this.incomingAudioLevel }],
      },
    ];
  }

  addTrack(track: MediaStreamTrack): void {
    this.addedTracks.push(track);
    this.senders.push({ track });
    // A real connection fires this whenever the track set changes — including
    // for the very first tracks, which is why the service guards on `active`.
    this.onnegotiationneeded?.();
  }

  close(): void {
    this.closed = true;
  }

  /** Fires a locally gathered candidate, as the browser would. */
  gather(candidate: RTCIceCandidateInit | null): void {
    this.onicecandidate?.({
      candidate: candidate
        ? ({ toJSON: () => candidate } as RTCIceCandidate)
        : null,
    } as RTCPeerConnectionIceEvent);
  }

  /** Delivers a remote track, as the browser would when one arrives. */
  emitTrack(stream: MediaStream, track: MediaStreamTrack): void {
    this.ontrack?.({
      streams: [stream],
      track,
    } as unknown as RTCTrackEvent);
  }

  setIceState(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

function fakeTrack(kind: "audio" | "video" = "audio"): MediaStreamTrack {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    kind,
    enabled: true,
    stopped: false,
    addEventListener(type: string, handler: () => void) {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener() {},
    /** Fires an event on this track, as the browser would. */
    emit(type: string) {
      for (const handler of listeners[type] ?? []) handler();
    },
    stop() {
      (this as unknown as { stopped: boolean }).stopped = true;
    },
  } as unknown as MediaStreamTrack;
}

function fakeStream(
  track: MediaStreamTrack,
  video?: MediaStreamTrack,
): MediaStream {
  const tracks = video ? [track, video] : [track];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    addTrack: (t: MediaStreamTrack) => {
      if (!tracks.includes(t)) tracks.push(t);
    },
    removeTrack: (t: MediaStreamTrack) => {
      const at = tracks.indexOf(t);
      if (at >= 0) tracks.splice(at, 1);
    },
  } as unknown as MediaStream;
}

/** Records what the socket was asked to send, and lets tests push frames in. */
class FakeRealtime {
  readonly frames = new Subject<RealtimeFrame>();
  readonly frames$ = this.frames.asObservable();
  readonly sessionId = "session-under-test";
  readonly invites: {
    conversationId: string;
    sdp: RTCSessionDescriptionInit | null;
    media: string;
  }[] = [];
  readonly answers: { callId: string; sdp: RTCSessionDescriptionInit }[] = [];
  readonly joins: string[] = [];
  readonly candidates: {
    callId: string;
    candidate: RTCIceCandidateInit;
    to: string | null;
  }[] = [];
  readonly hangups: { callId: string; reason?: string }[] = [];
  readonly renegotiations: {
    callId: string;
    sdp: RTCSessionDescriptionInit;
    screenStreamId: string | null;
    to: string | null;
  }[] = [];

  inviteCall(
    conversationId: string,
    sdp: RTCSessionDescriptionInit | null,
    media: string,
  ): void {
    this.invites.push({ conversationId, sdp, media });
  }
  answerCall(callId: string, sdp: RTCSessionDescriptionInit): void {
    this.answers.push({ callId, sdp });
  }
  joinCall(callId: string): void {
    this.joins.push(callId);
  }
  renegotiateCall(
    callId: string,
    sdp: RTCSessionDescriptionInit,
    screenStreamId: string | null = null,
    to: string | null = null,
  ): void {
    this.renegotiations.push({ callId, sdp, screenStreamId, to });
  }
  sendIceCandidate(
    callId: string,
    candidate: RTCIceCandidateInit,
    to: string | null = null,
  ): void {
    this.candidates.push({ callId, candidate, to });
  }
  hangupCall(callId: string, reason?: string): void {
    this.hangups.push({ callId, reason });
  }
}

class FakeRing {
  ringing = false;
  armed = false;
  armUnlock(): void {
    this.armed = true;
  }
  startRinging(): void {
    this.ringing = true;
  }
  stopRinging(): void {
    this.ringing = false;
  }
}

describe("WebrtcCallService", () => {
  let service: WebrtcCallService;
  let realtime: FakeRealtime;
  let ring: FakeRing;
  let http: HttpTestingController;
  let track: MediaStreamTrack;
  let videoTrack: MediaStreamTrack;
  let screenTrack: MediaStreamTrack;
  let mediaError: Error | null;
  /** Holds `getUserMedia` open, so ordering around it can be asserted. */
  let mediaGate: Promise<void> | null;
  /** Fails only the camera, leaving the microphone working. */
  let cameraError: Error | null;
  let requested: MediaStreamConstraints[];

  const pc = () =>
    FakePeerConnection.instances[FakePeerConnection.instances.length - 1];

  /**
   * The one other person, in a 1:1 call.
   *
   * A pair is a mesh of one, so these read the same array a group does rather
   * than a pair-shaped accessor that only the 1:1 path would exercise.
   */
  const peerStream = () => service.peers()[0]?.stream ?? null;
  const peerScreen = () => service.peers()[0]?.screen ?? null;

  /** Answers the ICE-credential request the service makes before every call. */
  const flushCredentials = (relay = true) => {
    http.expectOne(TURN_URL).flush({
      data: {
        ice_servers: relay
          ? [{ urls: ["turn:127.0.0.1:3478"], username: "u", credential: "c" }]
          : [{ urls: ["stun:stun.example:3478"] }],
        ttl: 300,
        relay,
      },
    });
  };

  /** Lets the service's awaited microtasks settle. */
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  beforeEach(() => {
    FakePeerConnection.instances = [];
    realtime = new FakeRealtime();
    ring = new FakeRing();
    track = fakeTrack();
    videoTrack = fakeTrack("video");
    screenTrack = fakeTrack("video");
    requested = [];
    cameraError = null;
    mediaError = null;
    mediaGate = null;

    accessToken = tokenFor(SELF);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RealtimeService, useValue: realtime },
        { provide: RingAudioService, useValue: ring },
        {
          provide: PEER_CONNECTION_FACTORY,
          useValue: (config: RTCConfiguration) =>
            new FakePeerConnection(config) as unknown as RTCPeerConnection,
        },
        {
          provide: OAuthService,
          useValue: { getAccessToken: () => accessToken },
        },
        {
          provide: DISPLAY_MEDIA,
          useValue: () => Promise.resolve(fakeStream(screenTrack)),
        },
        {
          provide: USER_MEDIA,
          useValue: async (constraints: MediaStreamConstraints) => {
            requested.push(constraints);
            if (mediaGate) await mediaGate;
            if (mediaError) return Promise.reject(mediaError);
            if (constraints.video && cameraError) {
              return Promise.reject(cameraError);
            }
            return Promise.resolve(
              constraints.video
                ? fakeStream(track, videoTrack)
                : fakeStream(track),
            );
          },
        },
      ],
    });
    service = TestBed.inject(WebrtcCallService);
    http = TestBed.inject(HttpTestingController);
    realtime.frames.next({ t: "ready", d: { owner_id: SELF } });
  });

  afterEach(() => {
    http.verify();
  });

  /** Places an outgoing call and returns once the invite has been sent. */
  const placeCall = async (media?: "audio" | "video") => {
    const started = service.startCall(CONVERSATION_ID, [PEER], media);
    await settle();
    flushCredentials();
    await started;
    realtime.frames.next({ t: "call.ringing", d: { call_id: CALL_ID } });
  };

  /**
   * The `ready` frame is not the only way to know who you are.
   *
   * It used to be: `setSelfOwnerId`'s doc said "the dock passes it through"
   * and the dock never did, so a socket that had not handshaked yet left the
   * id empty — and empty fails silently in six places rather than throwing.
   * `politeTo` makes `"" < anything` true, so this side is always the impolite
   * one; `peerOf` returns the first participant, which can be you; the rejoin
   * guard returns early and never reconnects. The shell's own call-ring spec
   * was failing on `main` against correct product code for exactly this,
   * because a mocked socket sends nothing it was not told to.
   *
   * Wiping the resolved value is the scenario, not a shortcut: it is the state
   * the service is in before any frame arrives.
   */
  it("resolves its own owner id from the access token with no ready frame", async () => {
    (
      service as unknown as { resolvedSelfOwnerId: string }
    ).resolvedSelfOwnerId = "";

    await placeCall();

    expect(service.call()?.callerOwnerId).toBe(SELF);
    // The empty case did not merely mislabel the caller — it left the caller
    // out of the joined set entirely, because `[""]` is filtered to nothing.
    expect(service.call()?.joinedIds).toEqual([SELF]);
  });

  it("arms the audio unlock at construction, not when a call arrives", () => {
    // A call rings with no interaction of its own, so an AudioContext created
    // at that moment starts suspended and is silent.
    expect(ring.armed).toBeTrue();
  });

  it("sends the local description as the invite, with no recipient", async () => {
    await placeCall();

    expect(realtime.invites.length).toBe(1);
    expect(realtime.invites[0].conversationId).toBe(CONVERSATION_ID);
    expect(realtime.invites[0].sdp?.type).toBe("offer");
    // There is no `to` field to assert: the callee is resolved from
    // conversation membership server-side.
    expect(service.call()?.direction).toBe("outgoing");
    expect(service.call()?.state).toBe("ringing");
  });

  it("sends the media kind with the invite and holds it on the call", async () => {
    await placeCall("video");

    expect(realtime.invites[0].media).toBe("video");
    expect(service.call()?.media).toBe("video");
  });

  it("places an audio call when no media kind is asked for", async () => {
    await placeCall();

    expect(realtime.invites[0].media).toBe("audio");
    expect(service.call()?.media).toBe("audio");
  });

  it("takes the media kind of an incoming call from the frame", async () => {
    // The ring has to know before the callee answers: it decides whether the
    // UI says "video call" and whether the camera permission is warmed.
    realtime.frames.next({
      t: "call.incoming",
      d: {
        call_id: CALL_ID,
        conversation_id: CONVERSATION_ID,
        from: PEER,
        sdp: OFFER,
        media: "video",
      },
    });

    expect(service.call()?.media).toBe("video");
  });

  it("treats an incoming call with no media kind as audio", async () => {
    // A realtime-service older than phase 2.5 sends no media field.
    realtime.frames.next({
      t: "call.incoming",
      d: {
        call_id: CALL_ID,
        conversation_id: CONVERSATION_ID,
        from: PEER,
        sdp: OFFER,
      },
    });

    expect(service.call()?.media).toBe("audio");
  });

  it("asks for the camera only on a video call", async () => {
    await placeCall("video");

    expect(requested.length).toBe(1);
    expect(requested[0].video).toBeTruthy();
    // Left bare on purpose: slice 0 measures the audio with getStats() before
    // anything touches echo cancellation or noise suppression.
    expect(requested[0].audio).toBeTrue();
  });

  it("never opens the camera for an audio call", async () => {
    await placeCall("audio");

    expect(requested[0].video).toBeFalse();
  });

  it("exposes the local stream so the dock can preview it", async () => {
    await placeCall("video");

    expect(service.localStream()).not.toBeNull();
  });

  it("turns the camera off by disabling the track, not by renegotiating", async () => {
    // Same mechanism as mute. Removing the track would force renegotiation and
    // drop the camera light, which people read as the call having ended.
    await placeCall("video");
    const negotiationsBefore = pc().localDescriptionCount;

    service.toggleCamera();

    expect(videoTrack.enabled).toBeFalse();
    expect(service.call()?.cameraOff).toBeTrue();
    expect(pc().localDescriptionCount).toBe(negotiationsBefore);

    service.toggleCamera();
    expect(videoTrack.enabled).toBeTrue();
    expect(service.call()?.cameraOff).toBeFalse();
  });

  it("ignores the camera toggle on an audio call", async () => {
    await placeCall("audio");

    service.toggleCamera();

    expect(service.call()?.cameraOff).toBeFalse();
  });

  it("does not renegotiate a call that is still ringing", async () => {
    // onnegotiationneeded fires for the very first tracks too. Acting on it
    // then would race the original exchange, and realtime-service refuses a
    // renegotiation before the call is answered for the same reason.
    //
    // Fired explicitly *after* call.ringing, so the call id is already known:
    // otherwise this passes on the missing id alone and never exercises the
    // state guard at all.
    await placeCall("audio");
    expect(service.call()?.callId).toBe(CALL_ID);
    expect(service.call()?.state).toBe("ringing");

    pc().onnegotiationneeded?.();
    await settle();

    expect(realtime.renegotiations.length).toBe(0);
  });

  it("adds a camera to a live audio call by renegotiating", async () => {
    await placeCall("audio");
    pc().setIceState("connected");
    const before = realtime.renegotiations.length;

    await service.promoteToVideo();
    await settle();

    expect(service.call()?.media).toBe("video");
    expect(pc().addedTracks).toContain(videoTrack);
    // Driven by onnegotiationneeded, not by promoteToVideo calling out
    // directly — that is what keeps the collision guards in the path.
    expect(realtime.renegotiations.length).toBe(before + 1);
    expect(realtime.renegotiations.at(-1)?.sdp.type).toBe("offer");
  });

  it("refuses to promote a call that is not connected yet", async () => {
    await placeCall("audio");

    await service.promoteToVideo();

    expect(service.call()?.media).toBe("audio");
    expect(realtime.renegotiations.length).toBe(0);
  });

  it("becomes a video call when a video track arrives from the peer", async () => {
    // The other side turning its camera on must open our stage, without a
    // second flag the two of us have to agree about.
    await placeCall("audio");
    pc().setIceState("connected");

    // A real MediaStream: the service assigns it to a real <audio> element's
    // srcObject, which rejects a plain object.
    pc().emitTrack(new MediaStream(), videoTrack);

    expect(service.call()?.media).toBe("video");
  });

  it("drops the peer's stream when their track ends, but stays a video call", async () => {
    // Two bugs, one behaviour. `replaceTrack(null)` left the receiver frozen
    // on the last frame, so the stream has to go. But collapsing back to the
    // audio dock yanked the panel out from under both people — Meet keeps the
    // layout and shows avatars. Both reported 2026-09-11.
    await placeCall("audio");
    pc().setIceState("connected");
    pc().emitTrack(new MediaStream(), videoTrack);
    expect(service.call()?.media).toBe("video");

    (videoTrack as unknown as { emit: (t: string) => void }).emit("ended");

    expect(peerStream()).withContext("no frozen frame").toBeNull();
    expect(service.call()?.media)
      .withContext("the call stays in its video layout")
      .toBe("video");
  });

  it("keeps the stage when the peer stops but we are still sending", async () => {
    // Our own camera is still worth showing.
    await placeCall("video");
    pc().setIceState("connected");
    pc().emitTrack(new MediaStream(), videoTrack);

    (videoTrack as unknown as { emit: (t: string) => void }).emit("ended");

    expect(service.call()?.media).toBe("video");
  });

  it("does not treat the peer's audio stream as their camera", async () => {
    // The audio track arrives on a stream too. Filing that as "they have
    // video" hid their avatar behind an empty <video> the instant the call
    // connected (reported 2026-09-11).
    await placeCall("audio");
    pc().setIceState("connected");

    pc().emitTrack(new MediaStream(), track); // an AUDIO track

    expect(peerStream())
      .withContext("audio must not count as a camera")
      .toBeNull();
  });

  it("does not turn a voice call into a video call when the peer presents", async () => {
    // The other half of the same rule: an arriving video track only makes this
    // a video call when it is a *camera*. The peer's screen is told apart by
    // the `screen_stream_id` it sends with its renegotiation — the only thing
    // in the signalling that says which is which.
    await placeCall("audio");
    pc().setIceState("connected");

    const screen = new MediaStream();
    realtime.frames.next({
      t: "call.renegotiate",
      d: {
        call_id: CALL_ID,
        from: PEER,
        sdp: { type: "offer", sdp: "v=0" },
        screen_stream_id: screen.id,
      },
    });
    await settle();
    pc().emitTrack(screen, fakeTrack("video"));

    expect(peerScreen()).toBe(screen);
    expect(service.call()?.media)
      .withContext("their screen is not our call becoming a video call")
      .toBe("audio");
    expect(service.hasVideo())
      .withContext("there is still a picture to lay out")
      .toBeTrue();
  });

  it("shares a screen on a voice call without making it a video call", async () => {
    // dathq, 2026-09-11: presenting renamed the call. `media` says how the
    // call was set up — it is what the ring, the label and the history row
    // read — while the stage is driven by whether there is a picture at all.
    // Meet, Teams, Zoom and Messenger all present in a voice call without
    // turning a camera on and without re-labelling it.
    await placeCall("audio");
    pc().setIceState("connected");

    await service.toggleScreenShare();
    await settle();

    expect(service.localScreen()).not.toBeNull();
    expect(service.call()?.sharingScreen).toBeTrue();
    expect(service.call()?.media)
      .withContext("a voice call with a screen is still a voice call")
      .toBe("audio");
    // No camera of our own was opened by presenting.
    expect(service.call()?.sendingVideo).toBeFalse();
    // But there is something to lay out, so the stage is on.
    expect(service.hasVideo()).toBeTrue();
  });

  it("stops the shared screen when the call ends", async () => {
    // The screen is its own track on its own stream, so it is not in
    // localMedia and teardown used to walk straight past it — the browser kept
    // reporting the tab as shared after hanging up (reported 2026-09-11).
    await placeCall("audio");
    pc().setIceState("connected");
    await service.toggleScreenShare();
    await settle();
    expect(service.localScreen()).not.toBeNull();

    service.hangUp();

    expect(service.localScreen()).toBeNull();
    expect((screenTrack as unknown as { stopped: boolean }).stopped)
      .withContext("the screen track itself must be stopped")
      .toBeTrue();
  });

  it("as the polite peer, accepts an offer that crossed its own", async () => {
    // SELF sorts below PEER, so this side yields: it takes the incoming offer
    // and answers it, rather than keeping its own.
    await placeCall("audio");
    pc().setIceState("connected");
    pc().signalingState = "have-local-offer";

    realtime.frames.next({
      t: "call.renegotiate",
      d: { call_id: CALL_ID, sdp: OFFER, from: PEER },
    });
    await settle();

    expect(pc().remoteDescription).toBe(OFFER);
    expect(realtime.renegotiations.at(-1)?.sdp.type).toBe("answer");
  });

  it("as the impolite peer, ignores an offer that crossed its own", async () => {
    // An incoming call from an owner id BELOW ours makes this side impolite,
    // so it keeps its own offer and drops theirs. Both peers reach that verdict
    // independently, which is the whole point of comparing ids.
    const lower = "google_000";
    realtime.frames.next({
      t: "call.incoming",
      d: {
        call_id: CALL_ID,
        conversation_id: CONVERSATION_ID,
        from: lower,
        sdp: OFFER,
      },
    });
    const accepted = service.accept();
    await settle();
    flushCredentials();
    await accepted;
    pc().setIceState("connected");

    const remoteBefore = pc().remoteDescription;
    const sentBefore = realtime.renegotiations.length;
    pc().signalingState = "have-local-offer";

    realtime.frames.next({
      t: "call.renegotiate",
      d: { call_id: CALL_ID, sdp: OFFER, from: lower },
    });
    await settle();

    expect(pc().remoteDescription).toBe(remoteBefore);
    expect(realtime.renegotiations.length).toBe(sentBefore);
  });

  it("never treats an answer as a collision", async () => {
    // An answer can only be a reply to an offer we sent, so the collision rule
    // must not apply to it — dropping it would strand the renegotiation.
    await placeCall("audio");
    pc().setIceState("connected");
    pc().signalingState = "have-local-offer";

    realtime.frames.next({
      t: "call.renegotiate",
      d: { call_id: CALL_ID, sdp: ANSWER, from: PEER },
    });
    await settle();

    expect(pc().remoteDescription).toBe(ANSWER);
  });

  it("takes the call id from call.ringing rather than inventing one", async () => {
    await placeCall();
    expect(service.call()?.callId).toBe(CALL_ID);
  });

  it("relays gathered candidates and ignores the end-of-gather marker", async () => {
    await placeCall();

    pc().gather(CANDIDATE);
    pc().gather(null);

    expect(realtime.candidates.length).toBe(1);
    expect(realtime.candidates[0].callId).toBe(CALL_ID);
  });

  it("becomes active only when ICE connects, not when signalling completes", async () => {
    await placeCall();
    realtime.frames.next({
      t: "call.answered",
      d: { call_id: CALL_ID, sdp: ANSWER },
    });
    await settle();

    // Signalling done, media not yet flowing — the window where a missing
    // relay shows up.
    expect(service.call()?.state).toBe("connecting");
    expect(service.call()?.activeSince).toBeNull();

    pc().setIceState("connected");
    expect(service.call()?.state).toBe("active");
    expect(service.call()?.activeSince).not.toBeNull();
  });

  it("queues candidates that arrive before a remote description exists", async () => {
    await placeCall();

    // Trickle ICE guarantees this window: the peer sends candidates as soon as
    // it has a local description, which is before our answer comes back.
    realtime.frames.next({
      t: "call.ice",
      d: { call_id: CALL_ID, candidate: CANDIDATE },
    });
    await settle();
    expect(pc().addedCandidates.length).toBe(0);

    realtime.frames.next({
      t: "call.answered",
      d: { call_id: CALL_ID, sdp: ANSWER },
    });
    await settle();
    expect(pc().addedCandidates.length).toBe(1);
  });

  it("rings on an incoming call and answers with the local description", async () => {
    realtime.frames.next({
      t: "call.incoming",
      d: {
        call_id: CALL_ID,
        conversation_id: CONVERSATION_ID,
        from: PEER,
        sdp: OFFER,
      },
    });

    expect(ring.ringing).toBeTrue();
    expect(service.call()?.direction).toBe("incoming");

    const accepted = service.accept();
    await settle();
    flushCredentials();
    await accepted;

    expect(ring.ringing).toBeFalse();
    expect(pc().remoteDescription?.type).toBe("offer");
    expect(realtime.answers.length).toBe(1);
    expect(realtime.answers[0].callId).toBe(CALL_ID);
    expect(realtime.answers[0].sdp.type).toBe("answer");
  });

  it("ignores answered_elsewhere for a call it holds active", async () => {
    realtime.frames.next({
      t: "call.incoming",
      d: {
        call_id: CALL_ID,
        conversation_id: CONVERSATION_ID,
        from: PEER,
        sdp: OFFER,
      },
    });
    const accepted = service.accept();
    await settle();
    flushCredentials();
    await accepted;
    pc().setIceState("connected");

    // That frame goes to the whole owner subject so the *other* tabs stop
    // ringing — the winning tab receives it too and must not hang up on it.
    realtime.frames.next({
      t: "call.ended",
      d: { call_id: CALL_ID, reason: "answered_elsewhere" },
    });

    expect(service.call()?.state).toBe("active");
  });

  it("ends a still-ringing call on answered_elsewhere, silently", async () => {
    realtime.frames.next({
      t: "call.incoming",
      d: {
        call_id: CALL_ID,
        conversation_id: CONVERSATION_ID,
        from: PEER,
        sdp: OFFER,
      },
    });

    realtime.frames.next({
      t: "call.ended",
      d: { call_id: CALL_ID, reason: "answered_elsewhere" },
    });

    expect(service.call()).toBeNull();
    // Answering on another tab is not news worth a notice.
    expect(service.endNotice()).toBeNull();
  });

  it("never yields a call it is already in to somebody else's invite", async () => {
    /*
     * dathq's question, and the answer was bad (2026-09-15): a third person
     * pressing Call rang everybody again, and this branch — written for two
     * people dialling each other in a 1:1, where yielding is correct — made
     * whoever sorted lower hang up the call they were in and take the new
     * ring. With three people that could empty the room in one press.
     *
     * The rival invite comes from PEER, which sorts *above* SELF — so SELF is
     * the polite side and the old rule yielded. A caller sorting below would
     * have been refused as busy either way and proves nothing.
     */
    ringGroup([LOWER, SELF, PEER], LOWER);
    await acceptGroup();
    await announce([LOWER, SELF, PEER]);
    const callBefore = service.call()?.callId;

    realtime.frames.next({
      t: "call.incoming",
      d: {
        call_id: "99999999-9999-4999-8999-999999999999",
        conversation_id: CONVERSATION_ID,
        from: PEER,
        media: "audio",
        participants: [LOWER, SELF, PEER],
      },
    });
    await settle();

    expect(service.call()?.callId)
      .withContext("still in the call it was in")
      .toBe(callBefore);
    expect(realtime.hangups.at(-1)?.reason)
      .withContext("the rival invite is refused, not accepted")
      .toBe("busy");
  });

  it("resolves glare by owner id, not by whichever frame landed first", async () => {
    await placeCall();

    // PEER > SELF, so this client is polite: it yields its own call and takes
    // the incoming one.
    realtime.frames.next({
      t: "call.incoming",
      d: {
        call_id: "other-call",
        conversation_id: CONVERSATION_ID,
        from: PEER,
        sdp: OFFER,
      },
    });

    expect(service.call()?.direction).toBe("incoming");
    expect(realtime.hangups.some((h) => h.callId === CALL_ID)).toBeTrue();
  });

  it("refuses an incoming call as busy when it is the impolite peer", async () => {
    realtime.frames.next({ t: "ready", d: { owner_id: PEER } });
    await placeCall();

    // Now this client has the higher id, so it keeps its own call.
    realtime.frames.next({
      t: "call.incoming",
      d: {
        call_id: "other-call",
        conversation_id: CONVERSATION_ID,
        from: SELF,
        sdp: OFFER,
      },
    });

    expect(service.call()?.direction).toBe("outgoing");
    expect(realtime.hangups).toContain({
      callId: "other-call",
      reason: "busy",
    });
  });

  it("reports a refused ringing call as declined, not as a hang-up", async () => {
    realtime.frames.next({
      t: "call.incoming",
      d: {
        call_id: CALL_ID,
        conversation_id: CONVERSATION_ID,
        from: PEER,
        sdp: OFFER,
      },
    });

    service.hangUp();

    // The distinction is what the other person's history row says.
    expect(realtime.hangups).toContain({ callId: CALL_ID, reason: "declined" });
    expect(service.call()).toBeNull();
  });

  it("reports a live call ended by this side as a hang-up", async () => {
    await placeCall();
    realtime.frames.next({
      t: "call.answered",
      d: { call_id: CALL_ID, sdp: ANSWER },
    });
    await settle();
    pc().setIceState("connected");

    service.hangUp();
    expect(realtime.hangups).toContain({ callId: CALL_ID, reason: "hangup" });
  });

  it("reports ICE failure as ice_failed and surfaces it", async () => {
    await placeCall();
    realtime.frames.next({
      t: "call.answered",
      d: { call_id: CALL_ID, sdp: ANSWER },
    });
    await settle();

    // No candidate pair worked — the case coturn exists for. The server counts
    // it, so it must be reported rather than retried silently.
    pc().setIceState("failed");

    expect(service.error()).toBe("ICE_FAILED");
    expect(realtime.hangups).toContain({
      callId: CALL_ID,
      reason: "ice_failed",
    });
  });

  it("joins a video call without a camera rather than failing", async () => {
    // Meet, Zoom, Teams and Messenger all allow this: your tile shows an
    // avatar and you still see the other person. Refusing the call takes away
    // one that would have worked (reported 2026-09-11).
    const missing = new Error("Requested device not found");
    missing.name = "NotFoundError";
    cameraError = missing;

    await placeCall("video");

    expect(service.error()).withContext("must not fail").toBeNull();
    expect(service.call()?.cameraMissing).toBeTrue();
    expect(service.call()?.media).toBe("video");
    // Asked for the camera, then fell back to audio alone.
    expect(requested.length).toBe(2);
    expect(requested[0].video).toBeTruthy();
    expect(requested[1].video).toBeFalse();
  });

  it("still receives the peer's video when it has no camera to send", async () => {
    // Without a recvonly transceiver the offer carries no video at all, so a
    // missing webcam would silently blind BOTH sides.
    const missing = new Error("Requested device not found");
    missing.name = "NotFoundError";
    cameraError = missing;

    await placeCall("video");

    expect(pc().transceivers).toContain({
      kind: "video",
      direction: "recvonly",
    });
  });

  it("adds no recvonly transceiver when the camera works", async () => {
    await placeCall("video");

    expect(pc().transceivers.length).toBe(0);
    expect(service.call()?.cameraMissing).toBeFalse();
  });

  it("still fails when the microphone is the problem, not the camera", async () => {
    // The audio-only retry fails too, so this is not a camera fault and the
    // original cause must be surfaced rather than swallowed.
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    mediaError = denied;

    const started = service.startCall(CONVERSATION_ID, [PEER], "video");
    await settle();
    for (const pending of http.match(TURN_URL)) {
      pending.flush({ data: { ice_servers: [], ttl: 300, relay: false } });
    }
    await started;

    expect(service.error()).toBe("MEDIA_DENIED");
  });

  it("names each media failure by its own cause", async () => {
    // "The call could not connect" for a busy camera sends people to the wrong
    // place — every one of these has a different thing to do about it
    // (reported 2026-09-11, a video call failing instantly with the generic
    // message).
    const cases: [string, string][] = [
      ["NotAllowedError", "MEDIA_DENIED"],
      ["SecurityError", "MEDIA_DENIED"],
      ["NotFoundError", "MEDIA_MISSING"],
      ["NotReadableError", "MEDIA_BUSY"],
      ["AbortError", "MEDIA_BUSY"],
      ["OverconstrainedError", "MEDIA_UNSUPPORTED"],
    ];

    for (const [name, expected] of cases) {
      const failure = new Error(name);
      failure.name = name;
      mediaError = failure;

      const started = service.startCall(CONVERSATION_ID, [PEER], "video");
      await settle();
      // Cached after the first fetch, so there is nothing to answer later on.
      for (const pending of http.match(TURN_URL)) {
        pending.flush({
          data: { ice_servers: [], ttl: 300, relay: false },
        });
      }
      await started;

      expect(service.error())
        .withContext(`${name} should surface as ${expected}`)
        .toBe(expected);
      service.clearEndNotice();
    }
  });

  it("still falls back to a generic cause for an unknown failure", async () => {
    const failure = new Error("boom");
    failure.name = "TypeError";
    mediaError = failure;

    const started = service.startCall(CONVERSATION_ID, [PEER], "video");
    await settle();
    for (const pending of http.match(TURN_URL)) {
      pending.flush({ data: { ice_servers: [], ttl: 300, relay: false } });
    }
    await started;

    expect(service.error()).toBe("CALL_FAILED");
  });

  it("surfaces a denied microphone as its own cause", async () => {
    mediaError = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });

    await service.startCall(CONVERSATION_ID, [PEER]);

    // "Call failed" would send the user looking in the wrong place.
    expect(service.error()).toBe("MEDIA_DENIED");
    expect(service.call()).toBeNull();
    // And no credentials were fetched: the capture is opened once for the whole
    // mesh, before any connection is built, so a call that cannot have a
    // microphone never asks the server for a relay it will not use.
    http.expectNone(TURN_URL);
  });

  it("flags a call that has no relay on offer", async () => {
    const started = service.startCall(CONVERSATION_ID, [PEER]);
    await settle();
    flushCredentials(false);
    await started;

    // STUN only: works between two tabs here, fails behind symmetric NAT.
    expect(service.call()?.relayAvailable).toBeFalse();
  });

  it("still places a call when credentials cannot be fetched", async () => {
    const started = service.startCall(CONVERSATION_ID, [PEER]);
    await settle();
    http.expectOne(TURN_URL).error(new ProgressEvent("error"), { status: 503 });
    await started;

    // A direct path may well exist; degrading beats refusing to dial.
    expect(realtime.invites.length).toBe(1);
    expect(service.call()?.relayAvailable).toBeFalse();
  });

  it("passes the fetched ICE servers to the peer connection", async () => {
    await placeCall();
    expect(pc().config.iceServers?.[0].urls).toEqual(["turn:127.0.0.1:3478"]);
  });

  it("mutes by disabling the track rather than renegotiating", async () => {
    await placeCall();

    service.toggleMute();
    expect(service.call()?.micMuted).toBeTrue();
    expect(track.enabled).toBeFalse();

    service.toggleMute();
    expect(service.call()?.micMuted).toBeFalse();
    expect(track.enabled).toBeTrue();
  });

  it("stops the microphone and closes the connection when a call ends", async () => {
    await placeCall();
    const connection = pc();

    service.hangUp();

    // A live microphone after a call is over is the bug users notice — the
    // browser keeps showing the recording indicator.
    expect((track as unknown as { stopped: boolean }).stopped).toBeTrue();
    expect(connection.closed).toBeTrue();
    expect(connection.onicecandidate).toBeNull();
  });

  it("refuses a second call while one is live", async () => {
    await placeCall();
    await service.startCall(CONVERSATION_ID, ["google_third"]);

    expect(realtime.invites.length).toBe(1);
  });

  it("keeps why the call ended after clearing it", async () => {
    realtime.frames.next({
      t: "call.incoming",
      d: {
        call_id: CALL_ID,
        conversation_id: CONVERSATION_ID,
        from: PEER,
        sdp: OFFER,
      },
    });
    realtime.frames.next({
      t: "call.ended",
      d: { call_id: CALL_ID, reason: "missed" },
    });

    expect(service.call()).toBeNull();
    expect(service.endNotice()).toEqual({
      reason: "missed",
      peerOwnerId: PEER,
      group: false,
    });

    service.clearEndNotice();
    expect(service.endNotice()).toBeNull();
  });

  it("ignores a call.ended for a different call", async () => {
    await placeCall();

    realtime.frames.next({
      t: "call.ended",
      d: { call_id: "someone-elses-call", reason: "hangup" },
    });

    expect(service.call()?.callId).toBe(CALL_ID);
  });

  /*
   * ---------------------------------------------------------------------
   * The mesh (phase 3 slice 3).
   *
   * A group call is N-1 connections rather than one, and every rule below is
   * a rule about *pairs*. The 1:1 tests above are the same engine with one
   * pair, which is deliberate — a pair is not a special case with its own
   * code path.
   * ---------------------------------------------------------------------
   */

  /** Rings this tab for a group call. A group ring carries no offer. */
  const ringGroup = (participants: string[], from = PEER) => {
    realtime.frames.next({
      t: "call.incoming",
      d: {
        call_id: CALL_ID,
        conversation_id: CONVERSATION_ID,
        from,
        media: "audio",
        participants,
      },
    });
  };

  /** Announces the whole joined set, as realtime-service does on every change. */
  const announce = async (
    joined: string[],
    owner = joined[joined.length - 1],
  ) => {
    realtime.frames.next({
      t: "call.participant",
      d: {
        call_id: CALL_ID,
        owner_id: owner,
        state: "joined",
        participants: joined,
      },
    });
    // Each link is built in turn; only the first fetches credentials, because
    // the service caches them for the rest of the call.
    for (let i = 0; i < 4; i++) {
      await settle();
      const pending = http.match(TURN_URL);
      for (const request of pending) {
        request.flush({
          data: {
            ice_servers: [
              { urls: ["turn:127.0.0.1:3478"], username: "u", credential: "c" },
            ],
            ttl: 300,
            relay: true,
          },
        });
      }
    }
    await settle();
  };

  /** Accepts a ringing group call and waits for the join to be sent. */
  const acceptGroup = async () => {
    await service.accept();
    await settle();
  };

  it("invites a group with no offer, because a mesh has no single peer", async () => {
    // One description sent with the invite would be an offer made to
    // everybody at once. realtime-service refuses it rather than dropping it
    // silently, so sending one would fail the call outright.
    await service.startCall(CONVERSATION_ID, [PEER, THIRD]);

    expect(realtime.invites.length).toBe(1);
    expect(realtime.invites[0].sdp)
      .withContext("no offer on a group invite")
      .toBeNull();
    expect(FakePeerConnection.instances.length)
      .withContext("and no connection before anyone has joined")
      .toBe(0);
  });

  it("accepts a group call with call.join, never call.answer", async () => {
    // `call.answer` carries the answering description for one peer, and in a
    // mesh there is no one peer it could be for — realtime-service refuses it.
    ringGroup([SELF, THIRD, PEER]);
    expect(service.call()?.state).toBe("ringing");

    await acceptGroup();

    expect(realtime.joins).toEqual([CALL_ID]);
    expect(realtime.answers.length)
      .withContext("a group is joined, not answered")
      .toBe(0);
  });

  it("builds one connection per person in the call, and only the lower id offers", async () => {
    /*
     * Matrix MSC3401's full-mesh rule: for any two participants the
     * lexicographically lower owner id calls the other. SELF sorts above
     * LOWER and below PEER, so exactly one of these two pairs is ours to
     * open. Both ends offering would collide on every single pair.
     */
    ringGroup([LOWER, SELF, PEER], LOWER);
    await acceptGroup();

    await announce([LOWER, SELF, PEER]);

    expect(FakePeerConnection.instances.length).toBe(2);
    expect(service.peers().map((p) => p.ownerId)).toEqual([LOWER, PEER]);

    const offers = realtime.renegotiations.filter(
      (r) => r.sdp.type === "offer",
    );
    expect(offers.map((o) => o.to))
      .withContext("we offer only to the peer we sort below")
      .toEqual([PEER]);
  });

  it("names the target on every candidate it trickles", async () => {
    // A candidate broadcast to the room hands one pair's network paths to a
    // third party, and one aimed at yourself is echoed straight back.
    ringGroup([LOWER, SELF, PEER], LOWER);
    await acceptGroup();
    await announce([LOWER, SELF, PEER]);

    const [toLower, toPeer] = FakePeerConnection.instances;
    toLower.gather(CANDIDATE);
    toPeer.gather(CANDIDATE);

    expect(realtime.candidates.map((c) => c.to)).toEqual([LOWER, PEER]);
  });

  it("marks who is talking from each link's own inbound audio", async () => {
    /*
     * A mesh has no server to name the active speaker, so every client works
     * it out for itself from the level its receiver already reports. This is
     * the threshold and the hysteresis: speech has gaps between words, and a
     * ring that blinks on every syllable is worse than no ring at all.
     */
    ringGroup([LOWER, SELF, PEER], LOWER);
    await acceptGroup();
    await announce([LOWER, SELF, PEER]);
    // Sampling is gated on the call being up: before ICE connects there is no
    // audio to have a level.
    for (const connection of FakePeerConnection.instances) {
      connection.setIceState("connected");
    }

    const sample = () =>
      (
        service as unknown as { sampleIncomingAudio: () => void }
      ).sampleIncomingAudio();
    const speaking = (ownerId: string) =>
      service.peers().find((peer) => peer.ownerId === ownerId)?.speaking;

    for (const connection of FakePeerConnection.instances) {
      connection.incomingAudioLevel = 0;
    }
    sample();
    expect(speaking(LOWER)).withContext("silence is not speech").toBeFalse();

    // Talking lights the ring on the first sample: a delay here reads as lag.
    for (const connection of FakePeerConnection.instances) {
      connection.incomingAudioLevel = 0.2;
    }
    sample();
    expect(speaking(LOWER)).toBeTrue();
    expect(speaking(PEER)).toBeTrue();

    // A pause between words must not put it out.
    for (const connection of FakePeerConnection.instances) {
      connection.incomingAudioLevel = 0;
    }
    sample();
    expect(speaking(LOWER))
      .withContext("one quiet sample is a gap between words")
      .toBeTrue();

    sample();
    sample();
    expect(speaking(LOWER))
      .withContext("sustained silence, so the ring goes out")
      .toBeFalse();
  });

  it("treats a room's noise floor as silence, not as speech", async () => {
    // A live microphone in a quiet room still reports a small level; the
    // threshold sits well above it and well below normal speech.
    ringGroup([LOWER, SELF, PEER], LOWER);
    await acceptGroup();
    await announce([LOWER, SELF, PEER]);
    for (const connection of FakePeerConnection.instances) {
      connection.setIceState("connected");
      connection.incomingAudioLevel = 0.001;
    }
    (
      service as unknown as { sampleIncomingAudio: () => void }
    ).sampleIncomingAudio();

    expect(service.peers().every((peer) => !peer.speaking)).toBeTrue();
  });

  it("drops one leg when somebody leaves, and keeps the call", async () => {
    // Leaving and hanging up are the same act in a 1:1 and different acts in
    // a group: the others are still talking.
    ringGroup([LOWER, SELF, PEER], LOWER);
    await acceptGroup();
    await announce([LOWER, SELF, PEER]);
    const [, peerConnection] = FakePeerConnection.instances;

    await announce([LOWER, SELF], PEER);

    expect(peerConnection.closed)
      .withContext("their connection is released")
      .toBeTrue();
    expect(service.peers().map((p) => p.ownerId)).toEqual([LOWER]);
    expect(service.call()).withContext("the call goes on").not.toBeNull();
  });

  it("re-syncs from the announced set rather than applying a delta", async () => {
    // Core NATS is fire-and-forget, so a frame can simply not arrive. The set
    // is the whole membership for exactly this reason: a client that missed
    // one re-syncs from the next instead of holding a connection to somebody
    // who left, or missing one to somebody who arrived.
    ringGroup([LOWER, SELF, PEER], LOWER);
    await acceptGroup();
    await announce([LOWER, SELF]);
    expect(service.peers().map((p) => p.ownerId)).toEqual([LOWER]);

    // PEER's own "joined" announcement never arrived; this one is THIRD's.
    await announce([LOWER, SELF, THIRD, PEER], THIRD);

    expect(service.peers().map((p) => p.ownerId)).toEqual([LOWER, THIRD, PEER]);
  });

  it("builds nothing from a call this tab has not joined", async () => {
    /*
     * `call.participant` goes to everyone *invited*, not to everyone in the
     * call — deliberately, so a tab that is still ringing can watch the room
     * fill up. Connecting from there would put this tab into a call it has
     * not accepted.
     */
    ringGroup([SELF, THIRD, PEER]);

    await announce([THIRD, PEER]);

    expect(FakePeerConnection.instances.length).toBe(0);
    expect(service.call()?.joinedIds)
      .withContext("but the ring still shows who is already in")
      .toEqual([THIRD, PEER]);
    expect(service.call()?.state).toBe("ringing");
  });

  it("queues a candidate that arrives before its connection exists", async () => {
    // The relay and the participant fanout are different subjects with no
    // ordering between them, so a peer's candidates can land first.
    ringGroup([LOWER, SELF, THIRD], LOWER);
    await acceptGroup();
    realtime.frames.next({
      t: "call.ice",
      d: { call_id: CALL_ID, from: LOWER, candidate: CANDIDATE },
    });
    await settle();

    await announce([LOWER, SELF, THIRD]);
    const link = FakePeerConnection.instances[0];
    expect(link.addedCandidates.length)
      .withContext("nothing applied yet")
      .toBe(0);

    // LOWER sorts below SELF, so LOWER offers and this side answers.
    realtime.frames.next({
      t: "call.renegotiate",
      d: { call_id: CALL_ID, from: LOWER, sdp: OFFER },
    });
    await settle();

    expect(link.addedCandidates).toEqual([CANDIDATE]);
  });

  it("refuses to negotiate with somebody the call never invited", async () => {
    // The server already refuses to relay from an outsider. Checking the
    // invited set here too costs nothing, and a relay bug must not be able to
    // become a connection to a stranger.
    ringGroup([LOWER, SELF, THIRD], LOWER);
    await acceptGroup();
    await announce([LOWER, SELF, THIRD]);
    const built = FakePeerConnection.instances.length;
    expect(built).withContext("both legs of the mesh are up").toBe(2);

    realtime.frames.next({
      t: "call.renegotiate",
      d: { call_id: CALL_ID, from: "google_outsider", sdp: OFFER },
    });
    await settle();

    expect(FakePeerConnection.instances.length).toBe(built);
  });

  it("stops dialling when the server refuses the invite", async () => {
    // A conversation larger than the mesh holds is refused at invite time.
    // Without this the dock rings for thirty seconds at a call that was never
    // created.
    await service.startCall(CONVERSATION_ID, [PEER, THIRD]);
    expect(service.call()?.state).toBe("ringing");

    realtime.frames.next({
      t: "error",
      d: {
        code: "not_supported",
        message:
          "a call in this conversation would have 9 people; the limit is 4",
      },
    });

    expect(service.call()).toBeNull();
    expect(service.error()).toBe("CALL_TOO_MANY");
    expect(realtime.hangups)
      .withContext("there is no call to hang up — the server made none")
      .toEqual([]);
  });

  it("ignores an error frame once the call has been created", async () => {
    // Error frames answer the frame that caused them and carry no call id, so
    // a later one — a rejected candidate, say — must not end a live call.
    await placeCall();

    realtime.frames.next({
      t: "error",
      d: { code: "bad_frame", message: "candidate is required" },
    });

    expect(service.call()?.callId).toBe(CALL_ID);
  });

  it("ends a group call without naming anyone as having declined it", async () => {
    // "X declined" is a 1:1 sentence. In a group nobody in particular is the
    // reason the call ended, and `empty` is the server's own conclusion that
    // a mesh of one is a person looking at themselves.
    ringGroup([LOWER, SELF, PEER], LOWER);
    await acceptGroup();
    await announce([LOWER, SELF, PEER]);

    realtime.frames.next({
      t: "call.ended",
      d: { call_id: CALL_ID, reason: "empty" },
    });

    expect(service.endNotice()).toEqual({
      reason: "empty",
      peerOwnerId: "",
      group: true,
    });
  });

  /*
   * Coming back to a call: click-to-join.
   *
   * Slice 1 built the server half — `HJoin` treats "same session, new
   * connection" as a reload and hands the place back — and slice 3 first spent
   * a day on an automatic rejoin driven by a `sessionStorage` note. It needed
   * an open socket, reacquired capture and a won takeover, and failed silently
   * when any one of them did not; three separate failure modes were fixed and
   * it still dropped dathq. It was deleted rather than patched a fourth time:
   * Messenger shows the ongoing call in the chat and you press Join, which has
   * no race in it. The thread's banner calls `joinOngoing`.
   */
  describe("a ring that arrives without an offer", () => {
    /*
     * dathq, 2026-09-16: call somebody who has not signed in yet, watch them
     * sign in, and nothing happens. realtime-service now re-rings from stored
     * state when a socket connects, deliberately **without** an SDP — the
     * caller's original offer is stale by then and the candidates that
     * followed it went to the same dropped subject.
     *
     * The client used to decide how to accept by counting participants, so a
     * 1:1 ring with no offer fell through `if (!group && !offer) return;` and
     * pressing Accept did nothing at all.
     */
    const ringWithoutOffer = (participants: string[] = [SELF, PEER]) => {
      realtime.frames.next({
        t: "call.incoming",
        d: {
          call_id: CALL_ID,
          conversation_id: CONVERSATION_ID,
          from: PEER,
          media: "audio",
          participants,
        },
      });
    };

    it("rings for a 1:1 call that carries no offer", async () => {
      ringWithoutOffer();
      await settle();

      expect(service.call()?.callId).toBe(CALL_ID);
      expect(service.call()?.state).toBe("ringing");
    });

    it("accepts it by joining, because there is no offer to answer", async () => {
      ringWithoutOffer();
      await settle();

      await service.accept();
      await settle();

      expect(realtime.joins)
        .withContext("a ring with no offer is joined, never answered")
        .toEqual([CALL_ID]);
      expect(realtime.answers).toEqual([]);
      expect(service.call()?.state).toBe("connecting");
    });

    it("still answers a 1:1 ring that does carry one", async () => {
      // The fast path is unchanged: an offer in hand is replied to directly.
      realtime.frames.next({
        t: "call.incoming",
        d: {
          call_id: CALL_ID,
          conversation_id: CONVERSATION_ID,
          from: PEER,
          sdp: OFFER,
          media: "audio",
        },
      });
      await settle();

      // The answer path builds a peer connection, so it fetches ICE servers;
      // the join path does not, which is why only this case flushes them.
      const accepted = service.accept();
      await settle();
      flushCredentials();
      await accepted;

      expect(realtime.answers.map((a) => a.callId)).toEqual([CALL_ID]);
      expect(realtime.joins).toEqual([]);
    });
  });

  describe("joining a call already in progress", () => {
    const join = async () => {
      const done = service.joinOngoing(
        CALL_ID,
        CONVERSATION_ID,
        LOWER,
        [LOWER, SELF, PEER],
        "audio",
      );
      await settle();
      return done;
    };

    it("nothing rejoins on its own when the socket comes up", async () => {
      /*
       * The regression proof that auto-rejoin is gone, not merely unused: a
       * fresh `ready` must produce no join and no call. Left in place it was a
       * second, racy way into a call, and two mechanisms for one job is how
       * this went wrong the first time.
       */
      realtime.frames.next({ t: "ready", d: { owner_id: SELF } });
      await settle();

      expect(realtime.joins).toEqual([]);
      expect(service.call()).toBeNull();
    });

    it("joins the call, connecting rather than ringing", async () => {
      await join();

      expect(realtime.joins).toEqual([CALL_ID]);
      expect(service.call()?.callId).toBe(CALL_ID);
      expect(service.call()?.conversationId).toBe(CONVERSATION_ID);
      expect(service.call()?.callerOwnerId).toBe(LOWER);
      expect(service.call()?.state)
        .withContext("pressing Join *is* the acceptance; nothing to accept")
        .toBe("connecting");
    });

    it("claims its place before it touches the microphone", async () => {
      /*
       * The ordering that cost a session. The join used to wait on
       * `getUserMedia` and passed every time against fake devices, which open
       * instantly and are never busy; on a real machine with several tabs
       * contending for one microphone the await either failed outright or let
       * the frame hit a socket that had moved on — and `RealtimeService.send`
       * drops those silently. A place in the room is the scarce thing, so it
       * is claimed first and the replaceable thing follows.
       */
      let openCapture = () => {};
      mediaGate = new Promise<void>((resolve) => {
        openCapture = resolve;
      });

      void join();

      expect(realtime.joins)
        .withContext("asked for its place while capture was still blocked")
        .toEqual([CALL_ID]);

      openCapture();
      await settle();
    });

    it("stays in the call when the microphone cannot be opened", async () => {
      // Losing the microphone race must not cost the place in the room:
      // without capture this side can still hear, which beats being dropped
      // with nothing on screen to say why.
      mediaError = Object.assign(new Error("busy"), {
        name: "NotReadableError",
      });

      await join();

      expect(realtime.joins).toEqual([CALL_ID]);
      expect(service.call()).withContext("still in the call").not.toBeNull();
      expect(service.error())
        .withContext("and says why, rather than vanishing")
        .toBe("MEDIA_BUSY");
    });

    it("builds the mesh from the fanout its own join produces", async () => {
      await join();

      await announce([LOWER, SELF, PEER]);

      expect(service.peers().map((p) => p.ownerId)).toEqual([LOWER, PEER]);
    });

    it("says so when another tab already holds the place", async () => {
      /*
       * Only one connection holds a person's place, so a *second* tab is a
       * rival and the server answers its join with `answered_elsewhere`. The
       * guard for a call held active cannot catch it — a joining tab is
       * `connecting`, never `ringing` — so without this branch the tab sits
       * silent until the join timeout, which looks exactly like Join being
       * broken.
       */
      await join();

      realtime.frames.next({
        t: "call.ended",
        d: { call_id: CALL_ID, reason: "answered_elsewhere" },
      });

      expect(service.call()).toBeNull();
      expect(service.endNotice()?.reason)
        .withContext("told, rather than left to a silent timeout")
        .toBe("answered_elsewhere");
    });

    it("drops a join for a call that is already over, quietly", async () => {
      // The call ended between the banner being painted and the frame
      // arriving. No error: the banner is about to become a history row, which
      // says it better than a message would.
      await join();

      realtime.frames.next({
        t: "error",
        d: { code: "call_gone", message: "call is no longer live" },
      });
      await settle();

      expect(service.call()).toBeNull();
      expect(service.error()).toBeNull();
    });

    it("turns a refused invite into a join of the call that exists", async () => {
      /*
       * One call per conversation. The server refuses the second invite with
       * `call_exists` and the id of the one already running, so the two people
       * who pressed Call in the same instant both end up in the same call
       * rather than in two.
       */
      // A group invite fetches no ICE credentials: links are built, and
      // credentials fetched, only once somebody joins.
      await service.startCall(CONVERSATION_ID, [LOWER, SELF, PEER], "audio");
      await settle();
      expect(service.call()?.state).toBe("ringing");

      realtime.frames.next({
        t: "error",
        d: {
          code: "call_exists",
          message: "a call is already happening in that conversation",
          call_id: CALL_ID,
        },
      });
      await settle();

      expect(realtime.joins)
        .withContext("joined the existing call instead of starting a rival")
        .toEqual([CALL_ID]);
      expect(service.call()?.callId).toBe(CALL_ID);
      expect(service.call()?.state).toBe("connecting");
    });

    it("refuses to join while it is already in a call", async () => {
      ringGroup([LOWER, SELF, PEER], LOWER);
      await acceptGroup();
      const joinsBefore = realtime.joins.length;

      await join();

      expect(realtime.joins.length)
        .withContext("a second join for a place we already hold")
        .toBe(joinsBefore);
    });
  });
});
