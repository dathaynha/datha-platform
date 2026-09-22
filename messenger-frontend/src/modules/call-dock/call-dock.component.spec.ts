import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { computed, signal } from "@angular/core";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import type { LiveCall, RemotePeer } from "src/models/call.model";
import { ChatStore } from "src/services/implementations/chat-store.service";
import { WebrtcCallService } from "src/services/implementations/webrtc-call.service";
import { CallDockComponent } from "./call-dock.component";

/** Stands in for the engine: state is pushed, control calls are recorded. */
class FakeCalls {
  readonly call = signal<LiveCall | null>(null);
  readonly error = signal<string | null>(null);
  readonly endNotice = signal<null>(null);
  readonly hasCamera = signal(true);
  readonly localStream = signal<MediaStream | null>(null);
  readonly localScreen = signal<MediaStream | null>(null);

  /** What each peer is currently sending, by owner id. */
  private readonly media = signal<
    ReadonlyMap<
      string,
      { stream: MediaStream | null; screen: MediaStream | null }
    >
  >(new Map());

  /**
   * Everyone else in the call, derived from the call's own joined set.
   *
   * Derived rather than pushed so that setting a live call is enough to get
   * the tiles that call implies — a fake whose peer list had to be maintained
   * by hand would let a test assert a layout no real call could produce.
   */
  readonly peers = computed<readonly RemotePeer[]>(() =>
    (this.call()?.joinedIds ?? [])
      .filter((ownerId) => ownerId !== "google_me")
      .map((ownerId) => ({
        ownerId,
        stream: this.media().get(ownerId)?.stream ?? null,
        screen: this.media().get(ownerId)?.screen ?? null,
        state: "connected" as const,
        speaking: this.speakers().has(ownerId),
      })),
  );

  /** Who the service currently reports as talking. */
  readonly speakers = signal<ReadonlySet<string>>(new Set<string>());

  setSpeaking(ownerId: string, speaking: boolean): void {
    this.speakers.update((current) => {
      const next = new Set(current);
      if (speaking) next.add(ownerId);
      else next.delete(ownerId);
      return next;
    });
  }

  readonly isGroupCall = computed(
    () => (this.call()?.participantIds.length ?? 0) > 2,
  );

  readonly peerOwnerId = computed(() => {
    const call = this.call();
    if (!call || call.participantIds.length !== 2) return "";
    return call.participantIds.find((id) => id !== "google_me") ?? "";
  });

  /** Gives one peer a camera, or a screen. Defaults to the 1:1 counterpart. */
  setPeerStream(stream: MediaStream | null, ownerId = "google_them"): void {
    this.media.update((current) => {
      const next = new Map(current);
      next.set(ownerId, { screen: null, ...current.get(ownerId), stream });
      return next;
    });
  }

  setPeerScreen(screen: MediaStream | null, ownerId = "google_them"): void {
    this.media.update((current) => {
      const next = new Map(current);
      next.set(ownerId, { stream: null, ...current.get(ownerId), screen });
      return next;
    });
  }

  /**
   * Derived exactly as the real service derives it: a picture to lay out, from
   * anywhere in the call, by camera or by screen — deliberately *not* `media`,
   * which only says how the call was set up.
   */
  readonly hasVideo = computed(() => {
    const call = this.call();
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
  readonly muteToggles: number[] = [];
  readonly cameraToggles: number[] = [];
  promotions = 0;
  shareToggles = 0;

  accept(): Promise<void> {
    return Promise.resolve();
  }
  hangUp(): void {}
  toggleMute(): void {
    this.muteToggles.push(Date.now());
  }
  toggleCamera(): void {
    this.cameraToggles.push(Date.now());
  }
  useCamera(): Promise<void> {
    return Promise.resolve();
  }
  promoteToVideo(): Promise<void> {
    this.promotions += 1;
    return Promise.resolve();
  }
  toggleScreenShare(): Promise<void> {
    this.shareToggles += 1;
    return Promise.resolve();
  }
  clearEndNotice(): void {}
}

const liveCall = (overrides: Partial<LiveCall> = {}): LiveCall => ({
  callId: "call-1",
  conversationId: "c1",
  participantIds: ["google_me", "google_them"],
  callerOwnerId: "google_me",
  joinedIds: ["google_me", "google_them"],
  direction: "outgoing",
  media: "audio",
  state: "active",
  micMuted: false,
  cameraOff: false,
  cameraMissing: false,
  sharingScreen: false,
  micSilent: false,
  // A camera track of our own. False by default, because the default call
  // below is an audio one and an audio call has no camera to send.
  sendingVideo: false,
  activeSince: Date.now(),
  relayAvailable: true,
  ...overrides,
});

describe("CallDockComponent", () => {
  let fixture: ComponentFixture<CallDockComponent>;
  let calls: FakeCalls;

  const root = (): HTMLElement =>
    (fixture.nativeElement.parentElement as HTMLElement | null) ??
    document.body;

  const query = (selector: string) =>
    fixture.nativeElement.parentElement?.querySelector(selector) ??
    document.body.querySelector(selector);

  beforeEach(() => {
    calls = new FakeCalls();
    TestBed.configureTestingModule({
      imports: [CallDockComponent, TranslateModule.forRoot()],
      providers: [
        { provide: WebrtcCallService, useValue: calls },
        {
          provide: ChatStore,
          useValue: {
            // Mirrors the real store: an unknown owner falls back to the
            // raw id, which is exactly what made every initial "G".
            displayName: (id: string) => (id === "google_them" ? "Dat Ha" : id),
            currentOwnerId: () => "google_me",
            initialOf: (id: string) =>
              id === "google_them" ? "D" : id === "google_me" ? "M" : "",
            pictureUrl: (id: string) =>
              id === "google_them" ? "https://pic.example/them.jpg" : "",
            ensurePerson: () => Promise.resolve(),
            conversationById: (id: string) =>
              id === "c1"
                ? { id, type: "group", title: "Project Falcon" }
                : null,
            conversationTitle: (c: { title: string }) => c.title,
          },
        },
      ],
    });
    fixture = TestBed.createComponent(CallDockComponent);
    fixture.detectChanges();
  });

  it("renders nothing without a call", () => {
    expect(query("[data-testid='call-dock']")).toBeNull();
  });

  it("offers no mute while the call is still ringing out", () => {
    // There is no microphone stream until the call connects, so the control
    // did nothing but take up space.
    calls.call.set(liveCall({ state: "ringing" }));
    fixture.detectChanges();

    expect(query("[data-testid='call-dock']")).not.toBeNull();
    expect(query("[data-testid='call-mute']")).toBeNull();
    expect(query("[data-testid='call-hangup']")).not.toBeNull();
  });

  it("gives the two docked controls the same size", () => {
    // A labelled pill beside a small outlined circle is what made the dock
    // look thrown together.
    calls.call.set(liveCall());
    fixture.detectChanges();

    const mute = query("[data-testid='call-mute']") as HTMLElement;
    const hangUp = query("[data-testid='call-hangup']") as HTMLElement;
    expect(mute.classList).toContain("call-button");
    expect(hangUp.classList).toContain("call-button");
  });

  it("marks the muted state on the button, not by swapping to a missing icon", () => {
    calls.call.set(liveCall({ micMuted: true }));
    fixture.detectChanges();

    const mute = query("[data-testid='call-mute']") as HTMLElement;
    expect(mute.classList).toContain("is-muted");
    expect(mute.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the video stage only on a video call", () => {
    calls.call.set(liveCall({ media: "audio" }));
    fixture.detectChanges();
    expect(query("[data-testid='call-stage']")).toBeNull();

    calls.call.set(liveCall({ media: "video" }));
    fixture.detectChanges();
    expect(query("[data-testid='call-stage']")).not.toBeNull();
    expect(query("[data-testid='call-remote-video']")).not.toBeNull();
    expect(query("[data-testid='call-local-video']")).not.toBeNull();
  });

  it("mutes both video elements", () => {
    // The remote one because sound comes from the service's own <audio>, so an
    // unmuted element here plays the peer twice. The local one because an
    // unmuted self-preview is an instant feedback loop.
    calls.call.set(liveCall({ media: "video" }));
    fixture.detectChanges();

    const remote = query(
      "[data-testid='call-remote-video']",
    ) as HTMLVideoElement;
    const local = query("[data-testid='call-local-video']") as HTMLVideoElement;
    expect(remote.muted).withContext("remote video").toBeTrue();
    expect(local.muted).withContext("local preview").toBeTrue();
  });

  it("offers the camera control on an audio call too, to add one", () => {
    // Adding a camera to a live audio call is a renegotiation, not a track
    // flag — but it is the same button, as it is in every messenger.
    calls.call.set(liveCall({ media: "audio" }));
    fixture.detectChanges();

    const camera = query("[data-testid='call-camera']") as HTMLElement;
    expect(camera).not.toBeNull();
    expect(camera.getAttribute("aria-label")).toBe("MESSENGER.CALL.CAMERA_ADD");
    // Nothing to toggle yet, so it must not claim a pressed state.
    expect(camera.getAttribute("aria-pressed")).toBeNull();
  });

  it("keeps the camera control visible but inert without a camera", () => {
    // Disabled, never hidden: a missing camera does not stop the call, and a
    // control that vanishes reads as a broken app (2026-09-11).
    calls.hasCamera.set(false);
    calls.call.set(liveCall({ media: "audio" }));
    fixture.detectChanges();

    const camera = query("[data-testid='call-camera']") as HTMLButtonElement;
    expect(camera).not.toBeNull();
    expect(camera.disabled).toBeTrue();
  });

  it("never derives an initial from a raw owner id", () => {
    // `displayName` falls back to the owner id, and every id starts `google_`
    // — so both tiles showed "G", on both machines (reported 2026-09-11).
    calls.call.set(liveCall({ media: "video", sendingVideo: false }));
    fixture.detectChanges();

    // Our own tile has no picture in this fixture, so it falls back to an
    // initial — and it must be ours, not the first letter of "google_me".
    const self = query("[data-testid='call-no-camera']") as HTMLElement;
    expect(self.textContent?.trim()).toBe("M");
    expect(self.textContent?.trim()).not.toBe("G");
  });

  it("shows a real picture when the directory has one", () => {
    // The photo was only ever wired into the message bubbles.
    calls.call.set(liveCall({ media: "video", sendingVideo: false }));
    fixture.detectChanges();

    const photo = (
      query("[data-testid='call-main-avatar']") as HTMLElement
    ).querySelector("img");
    expect(photo?.getAttribute("src")).toBe("https://pic.example/them.jpg");
  });

  it("keeps a tile avatar a disc rather than stretching it over the tile", () => {
    // The shared avatar component fills its wrapper, and the tile wrapper is
    // `inset: 0` — so without an explicit size the picture would cover the
    // whole video area instead of sitting in the middle of it.
    calls.call.set(liveCall({ media: "video", sendingVideo: false }));
    fixture.detectChanges();

    const wrapper = query("[data-testid='call-main-avatar']") as HTMLElement;
    const avatar = wrapper.querySelector("messenger-avatar") as HTMLElement;
    const style = getComputedStyle(avatar);
    expect(style.borderRadius).toBe("999px");
    expect(avatar.clientWidth).toBe(avatar.clientHeight);
    expect(avatar.clientWidth).toBeLessThan(wrapper.clientWidth);
  });

  it("keeps the stage and shows avatars when nobody is sending video", () => {
    // Collapsing to the compact audio dock the moment a share ended pulled the
    // panel out from under both people (reported 2026-09-11).
    calls.call.set(liveCall({ media: "video", sendingVideo: false }));
    fixture.detectChanges();

    expect(query("[data-testid='call-stage']")).not.toBeNull();
    expect(query("[data-testid='call-main-avatar']")).not.toBeNull();
    expect(query("[data-testid='call-no-camera']")).not.toBeNull();
  });

  it("binds the peer's stream to the main tile as soon as the stage appears", () => {
    // The tiles are created when the call turns video, and at that moment no
    // value the binding depended on had changed — so the viewer's main tile
    // kept a null srcObject and showed black while the other side shared
    // (reported 2026-09-11). Only the element's own property proves this;
    // every class and testid assertion passed throughout.
    const stream = new MediaStream();
    calls.setPeerStream(stream);
    calls.call.set(liveCall({ media: "video", sendingVideo: false }));
    fixture.detectChanges();

    const main = query("[data-testid='call-remote-video']") as HTMLVideoElement;
    expect(main.srcObject).toBe(stream);
  });

  it("shows both screens and both people when two people share", () => {
    /*
     * The rule from 2026-09-11 still holds: a screen must never replace its
     * sharer's camera tile, or once both are sharing neither can see the
     * other. What changed on 2026-09-16 is *where* the second screen goes.
     * Both used to split the stage equally, which is mostly black — two 16:10
     * sources in half-width cells. One holds the stage and the other sits with
     * the people, one click from swapping.
     */
    calls.setPeerStream(new MediaStream());
    calls.localStream.set(new MediaStream());
    calls.setPeerScreen(new MediaStream());
    calls.localScreen.set(new MediaStream());
    calls.call.set(
      liveCall({ media: "video", sharingScreen: true, sendingVideo: true }),
    );
    fixture.detectChanges();

    // One screen on the stage, the other beside the people — both present.
    expect(query("[data-testid='call-tile-peer-screen']")).not.toBeNull();
    expect(query("[data-testid='call-tile-aside-screen']")).not.toBeNull();
    // And crucially the people are still there.
    expect(query("[data-testid='call-tile-peer']")).not.toBeNull();
    expect(query("[data-testid='call-tile-self']")).not.toBeNull();
  });

  it("keeps both people visible while only one shares", () => {
    calls.setPeerStream(new MediaStream());
    calls.localScreen.set(new MediaStream());
    calls.call.set(
      liveCall({ media: "video", sharingScreen: true, sendingVideo: false }),
    );
    fixture.detectChanges();

    expect(query("[data-testid='call-tile-self-screen']")).not.toBeNull();
    expect(query("[data-testid='call-tile-peer-screen']")).toBeNull();
    expect(query("[data-testid='call-tile-peer']")).not.toBeNull();
    expect(query("[data-testid='call-tile-self']")).not.toBeNull();
  });

  it("binds each screen tile to its own side's stream", () => {
    const theirs = new MediaStream();
    const ours = new MediaStream();
    calls.setPeerScreen(theirs);
    calls.localScreen.set(ours);
    calls.call.set(liveCall({ media: "video", sharingScreen: true }));
    fixture.detectChanges();

    /*
     * Selected by owner rather than by testid, because which screen holds the
     * stage and which sits in the strip is a view decision (and now a pinnable
     * one) — while whose stream lands in whose element is the invariant. Same
     * reason the people tiles are keyed by owner and never by position.
     */
    expect(
      (
        query(
          "[data-call-screen][data-owner='google_them']",
        ) as HTMLVideoElement
      ).srcObject,
    ).toBe(theirs);
    expect(
      (query("[data-call-screen][data-owner='google_me']") as HTMLVideoElement)
        .srcObject,
    ).toBe(ours);
  });

  it("gives both participants a tile of their own", () => {
    // Equal tiles, not one big tile plus a thumbnail: with both people sharing
    // a screen, that arrangement could only show one of them properly and put
    // the other where an avatar belongs (reported 2026-09-11).
    calls.setPeerStream(new MediaStream());
    calls.localStream.set(new MediaStream());
    calls.call.set(
      liveCall({ media: "video", sharingScreen: true, sendingVideo: true }),
    );
    fixture.detectChanges();

    expect(query("[data-testid='call-tile-peer']")).not.toBeNull();
    expect(query("[data-testid='call-tile-self']")).not.toBeNull();
    // Both carry a picture, so neither falls back to an avatar.
    expect(query("[data-testid='call-main-avatar']")).toBeNull();
    expect(query("[data-testid='call-no-camera']")).toBeNull();
  });

  it("binds each tile to its own side's stream", () => {
    const remote = new MediaStream();
    const local = new MediaStream();
    calls.setPeerStream(remote);
    calls.localStream.set(local);
    calls.call.set(
      liveCall({ media: "video", sharingScreen: true, sendingVideo: true }),
    );
    fixture.detectChanges();

    // No swapping by who is presenting — that is what put a shared screen in
    // the avatar's slot.
    expect(
      (query("[data-testid='call-remote-video']") as HTMLVideoElement)
        .srcObject,
    ).toBe(remote);
    expect(
      (query("[data-testid='call-local-video']") as HTMLVideoElement).srcObject,
    ).toBe(local);
  });

  it("mirrors the self camera but never a shared screen", () => {
    // A mirrored self-view reads correctly; mirrored text does not — and now
    // that a screen has its own tile, the two never share an element.
    calls.localStream.set(new MediaStream());
    calls.localScreen.set(new MediaStream());
    calls.call.set(
      liveCall({ media: "video", sharingScreen: true, sendingVideo: true }),
    );
    fixture.detectChanges();

    expect(
      (query("[data-testid='call-local-video']") as HTMLElement).classList,
    ).toContain("is-mirrored");
    expect(
      (query("[data-testid='call-local-screen']") as HTMLElement).classList,
    ).not.toContain("is-mirrored");
  });

  it("explains the empty local tile on a video call with no camera", () => {
    // An avatar tile, as every mainstream client shows — not a black rectangle
    // and not a refused call.
    calls.call.set(
      liveCall({ media: "video", cameraMissing: true, sendingVideo: false }),
    );
    fixture.detectChanges();

    expect(query("[data-testid='call-no-camera']")).not.toBeNull();
    // The peer's video still arrives, so the stage stays.
    expect(query("[data-testid='call-remote-video']")).not.toBeNull();
  });

  it("hides the camera control until the call is connected", () => {
    // There is no connection to renegotiate while it is still ringing.
    calls.call.set(liveCall({ state: "ringing", media: "audio" }));
    fixture.detectChanges();

    expect(query("[data-testid='call-camera']")).toBeNull();
  });

  it("promotes an audio call instead of toggling a track", () => {
    calls.call.set(liveCall({ media: "audio" }));
    fixture.detectChanges();

    (query("[data-testid='call-camera']") as HTMLElement).click();

    expect(calls.promotions).toBe(1);
    expect(calls.cameraToggles.length).toBe(0);
  });

  it("toggles the track on a call that already has video", () => {
    calls.call.set(liveCall({ media: "video", sendingVideo: true }));
    fixture.detectChanges();

    (query("[data-testid='call-camera']") as HTMLElement).click();

    expect(calls.cameraToggles.length).toBe(1);
    expect(calls.promotions).toBe(0);
  });

  it("marks the camera-off state without swapping to a missing icon", () => {
    calls.call.set(
      liveCall({ media: "video", sendingVideo: true, cameraOff: true }),
    );
    fixture.detectChanges();

    const camera = query("[data-testid='call-camera']") as HTMLElement;
    expect(camera.classList).toContain("is-off");
    expect(camera.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a shared screen on a voice call without renaming the call", () => {
    // dathq, 2026-09-11: sharing a screen during an audio call turned it into
    // a "video call". Meet, Teams, Zoom and Messenger all present in a voice
    // call without anyone's camera turning on and without re-labelling it.
    calls.call.set(liveCall({ media: "audio", sharingScreen: true }));
    calls.localScreen.set(new MediaStream());
    fixture.detectChanges();

    // There is a picture, so there is a stage.
    expect(query("[data-testid='call-stage']")).not.toBeNull();
    // And the camera is still something to *add*, not something to turn off.
    const camera = query("[data-testid='call-camera']") as HTMLElement;
    expect(camera.getAttribute("aria-pressed")).toBeNull();
    camera.click();
    expect(calls.promotions).toBe(1);
    expect(calls.cameraToggles.length).toBe(0);
  });

  it("keeps a voice call compact until something is actually shown", () => {
    calls.call.set(liveCall({ media: "audio" }));
    fixture.detectChanges();

    expect(query("[data-testid='call-stage']")).toBeNull();
  });

  it("centres the controls under the picture in the compact dock", () => {
    // Stacked, the control row is full width, so without this they hug the
    // left edge (reported 2026-09-11). A computed value, because "looks
    // centred" is not something a class assertion can check.
    calls.call.set(liveCall({ media: "video" }));
    fixture.detectChanges();
    (query("[data-testid='call-expand']") as HTMLElement).click();
    fixture.detectChanges();

    const controls = (
      query("[data-testid='call-dock']") as HTMLElement
    ).querySelector(".call-controls") as HTMLElement;
    expect(getComputedStyle(controls).justifyContent).toBe("center");
  });

  it("gives the light control buttons a visible edge", () => {
    // White on a white dock vanishes without one.
    calls.call.set(liveCall({ media: "audio" }));
    fixture.detectChanges();

    const style = getComputedStyle(
      query("[data-testid='call-mute']") as HTMLElement,
    );
    expect(parseFloat(style.borderTopWidth)).toBeGreaterThan(0);
    expect(style.borderTopStyle).toBe("solid");
  });

  it("expands a video call and stays compact for an audio one", () => {
    // A voice call has nothing to look at, so taking over the screen would
    // only be in the way. Video is the opposite.
    calls.call.set(liveCall({ media: "audio" }));
    fixture.detectChanges();
    expect(
      (query("[data-testid='call-dock']") as HTMLElement).classList,
    ).not.toContain("is-stage");

    calls.call.set(liveCall({ media: "video" }));
    fixture.detectChanges();
    expect(
      (query("[data-testid='call-dock']") as HTMLElement).classList,
    ).toContain("is-stage");
  });

  it("minimises back to the dock without ending the call", () => {
    // Messenger uses a separate window for this; we cannot, because a new
    // document destroys the RTCPeerConnection and a call must survive
    // navigation. Minimising is the same affordance without that cost.
    calls.call.set(liveCall({ media: "video" }));
    fixture.detectChanges();

    (query("[data-testid='call-expand']") as HTMLElement).click();
    fixture.detectChanges();

    const dock = query("[data-testid='call-dock']") as HTMLElement;
    expect(dock.classList).not.toContain("is-stage");
    expect(calls.call()).withContext("call still live").not.toBeNull();
  });

  it("shows no video stage on an incoming ring", () => {
    // Nothing flows until it is accepted, so a stage here is a black
    // rectangle. Messenger and FaceTime both show the avatar alone.
    calls.call.set(
      liveCall({ media: "video", direction: "incoming", state: "ringing" }),
    );
    fixture.detectChanges();

    expect(query("[data-testid='call-stage']")).toBeNull();
    expect(query("[data-testid='call-accept']")).not.toBeNull();
  });

  it("never expands an incoming ring", () => {
    // The ring is a question, and it already has its own centred treatment.
    calls.call.set(
      liveCall({ media: "video", direction: "incoming", state: "ringing" }),
    );
    fixture.detectChanges();

    expect(
      (query("[data-testid='call-dock']") as HTMLElement).classList,
    ).not.toContain("is-stage");
  });

  it("offers screen sharing on a live call and marks it while active", () => {
    calls.call.set(liveCall({ media: "video" }));
    fixture.detectChanges();

    (query("[data-testid='call-share']") as HTMLElement).click();
    expect(calls.shareToggles).toBe(1);

    calls.call.set(liveCall({ media: "video", sharingScreen: true }));
    fixture.detectChanges();
    const share = query("[data-testid='call-share']") as HTMLElement;
    expect(share.classList).toContain("is-on");
    expect(share.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders a real glyph for every icon in the dock", () => {
    // The muted state used `pi-microphone-slash`, which PrimeIcons 7 does not
    // ship, so it drew an empty circle (reported 2026-09-10). An icon class
    // that does not exist has no `::before` content — which is checkable.
    calls.call.set(
      liveCall({
        micMuted: true,
        media: "video",
        cameraOff: true,
        sharingScreen: true,
      }),
    );
    fixture.detectChanges();

    const dock = query("[data-testid='call-dock']") as HTMLElement;

    // Icon-font glyphs: a class PrimeIcons does not ship has no ::before
    // content and paints nothing, silently (2026-09-10).
    for (const icon of Array.from(dock.querySelectorAll("i[class*='pi-']"))) {
      const content = getComputedStyle(icon, "::before").content;
      expect(content)
        .withContext(`${icon.className} renders no glyph`)
        .not.toMatch(/^(none|"")$/);
    }

    // SVG glyphs: an empty <svg> is the same failure in a different costume,
    // so every one must actually carry geometry.
    const svgs = Array.from(dock.querySelectorAll("svg.call-glyph"));
    expect(svgs.length)
      .withContext("the dock draws its controls as inline SVG")
      .toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg.querySelectorAll("path, rect, line, circle").length)
        .withContext(`${svg.getAttribute("class")} has no geometry`)
        .toBeGreaterThan(0);
    }
  });

  it("shows the shared screen before its track reports a size", async () => {
    /*
     * dathq, 2026-09-16: sharing, and the stage is blank. The tile shapes
     * itself from the track's `videoWidth/videoHeight`, and until
     * `loadedmetadata` fires there is no ratio — with `width: auto` and
     * `height: auto` and a video sized at 100% of it, the box has nothing to
     * get its size from and collapses to nothing.
     *
     * Measured rather than eyeballed: the tile renders either way, so every
     * structural assertion passes while the stage is empty.
     */
    if (window.innerWidth < 960) {
      fail(`needs a viewport of at least 960px; got ${window.innerWidth}px`);
      return;
    }
    calls.setPeerScreen(new MediaStream());
    calls.call.set(liveCall({ media: "video", sharingScreen: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    const dock = root().querySelector(
      "[data-testid='call-dock']",
    ) as HTMLElement;
    if (!dock.classList.contains("is-stage")) {
      (
        root().querySelector("[data-testid='call-expand']") as HTMLElement
      ).click();
      fixture.detectChanges();
      await fixture.whenStable();
    }

    const tile = root().querySelector(
      "[data-testid='call-tile-peer-screen']",
    ) as HTMLElement;
    expect(tile).withContext("the screen tile is rendered").not.toBeNull();

    const box = tile.getBoundingClientRect();
    expect(box.width)
      .withContext(`tile measured ${box.width}x${box.height}`)
      .toBeGreaterThan(50);
    expect(box.height)
      .withContext(`tile measured ${box.width}x${box.height}`)
      .toBeGreaterThan(50);
  });

  it("puts this user's own share on the stage, with its stream", async () => {
    /*
     * Every other stage spec shares from a *peer*, because `screens()` lists
     * shared peers before this user's own. The person reporting a blank stage
     * was the one sharing, which is the other order entirely — so this drives
     * the self-share path on its own.
     */
    if (window.innerWidth < 960) {
      fail(`needs a viewport of at least 960px; got ${window.innerWidth}px`);
      return;
    }
    const mine = new MediaStream();
    calls.localScreen.set(mine);
    calls.localStream.set(new MediaStream());
    calls.call.set(
      liveCall({
        media: "video",
        sharingScreen: true,
        sendingVideo: true,
        participantIds: ["google_me", "google_them", "google_third"],
        joinedIds: ["google_me", "google_them", "google_third"],
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();

    const dock = root().querySelector(
      "[data-testid='call-dock']",
    ) as HTMLElement;
    if (!dock.classList.contains("is-stage")) {
      (
        root().querySelector("[data-testid='call-expand']") as HTMLElement
      ).click();
      fixture.detectChanges();
      await fixture.whenStable();
    }

    const tile = root().querySelector(
      "[data-testid='call-tile-self-screen']",
    ) as HTMLElement;
    expect(tile).withContext("my own share holds the stage").not.toBeNull();

    const box = tile.getBoundingClientRect();
    expect(box.width)
      .withContext(`tile measured ${box.width}x${box.height}`)
      .toBeGreaterThan(50);
    expect(box.height)
      .withContext(`tile measured ${box.width}x${box.height}`)
      .toBeGreaterThan(50);

    const video = tile.querySelector("video") as HTMLVideoElement;
    expect(video.srcObject)
      .withContext("and it is showing the stream, not an empty element")
      .toBe(mine);
    const videoBox = video.getBoundingClientRect();
    expect(videoBox.width)
      .withContext(`video measured ${videoBox.width}x${videoBox.height}`)
      .toBeGreaterThan(50);
  });

  it("takes the shared screen's own shape, not the cell's", () => {
    /*
     * The other half of "way too many dark space" (dathq, 2026-09-16). The
     * screen tile was a generic one shaped by its grid cell, and `object-fit:
     * contain` painted the difference black. Real screens are 16:10 laptops,
     * arbitrary windows, sometimes 21:9 — almost never the cell's shape.
     *
     * `contain` stays, deliberately: cropping a shared screen hides the edges
     * of somebody's code, which is worse than a band. The fix is to shape the
     * tile like its source, which is what this measures.
     */
    calls.setPeerScreen(new MediaStream());
    calls.call.set(liveCall({ media: "video", sharingScreen: true }));
    fixture.detectChanges();

    const video = query(
      "[data-call-screen][data-owner='google_them']",
    ) as HTMLVideoElement;
    // A real 16:10 laptop screen. `new MediaStream()` carries no track in a
    // unit test, so the dimensions the element would report are defined here.
    Object.defineProperty(video, "videoWidth", { value: 1680 });
    Object.defineProperty(video, "videoHeight", { value: 1050 });
    video.dispatchEvent(new Event("loadedmetadata"));
    fixture.detectChanges();

    const tile = query("[data-testid='call-tile-peer-screen']") as HTMLElement;
    // Chrome normalises the property to "<w> / <h>", so it is parsed rather
    // than compared as a number — `Number("1.6 / 1")` is NaN, which fails
    // looking exactly like a missing binding.
    const [width, height] = tile.style.aspectRatio
      .split("/")
      .map((part) => Number(part.trim()));
    expect(width / (height || 1))
      .withContext(
        `the tile is shaped like the screen it shows (got "${tile.style.aspectRatio}")`,
      )
      .toBeCloseTo(1680 / 1050, 3);
  });

  it("rings the tile of whoever is talking", () => {
    /*
     * A mesh has no server to name the active speaker, so each client works it
     * out from its own inbound levels. The indicator is drawn as an `outline`
     * rather than a border on purpose: a border changes the tile's box and
     * would nudge every neighbour three times a sentence.
     */
    calls.setPeerStream(new MediaStream(), "google_them");
    calls.call.set(
      liveCall({
        media: "video",
        participantIds: ["google_me", "google_them", "google_third"],
        joinedIds: ["google_me", "google_them", "google_third"],
      }),
    );
    fixture.detectChanges();

    const tileOf = (ownerId: string) =>
      root().querySelector(
        `[data-testid='call-tile-peer'][data-owner='${ownerId}']`,
      ) as HTMLElement;
    expect(tileOf("google_them").classList).not.toContain("is-speaking");

    calls.setSpeaking("google_them", true);
    fixture.detectChanges();

    expect(tileOf("google_them").classList).toContain("is-speaking");
    expect(tileOf("google_third").classList)
      .withContext("only the person talking")
      .not.toContain("is-speaking");

    // And the ring is drawn outside the box, so nothing reflows.
    expect(getComputedStyle(tileOf("google_them")).outlineStyle).toBe("solid");
  });

  it("keeps a group's docked chip readable instead of crushing it", () => {
    /*
     * dathq, 2026-09-16, with a screenshot: the title clipped to "R..." and
     * "0:19 · 2 in the call" wrapped one word per line.
     *
     * The docked row fits a 1:1 — a name, a duration, the buttons. A group
     * adds the headcount to that same line and the text column collapsed to
     * about forty pixels. An audio group call is the case that reaches it: a
     * video one already stacks, because it needs room for a picture.
     */
    calls.call.set(
      liveCall({
        media: "audio",
        participantIds: ["google_me", "google_them", "google_third"],
        joinedIds: ["google_me", "google_them"],
      }),
    );
    fixture.detectChanges();

    const dock = root().querySelector(
      "[data-testid='call-dock']",
    ) as HTMLElement;
    expect(dock.querySelector(".call-stage"))
      .withContext("an audio call renders no stage; this is the cramped path")
      .toBeNull();

    const identity = dock.querySelector(".call-identity") as HTMLElement;
    const state = dock.querySelector(".call-state") as HTMLElement;

    expect(Math.round(identity.getBoundingClientRect().width))
      .withContext("the name and duration need room, not forty pixels")
      .toBeGreaterThan(160);
    expect(Math.round(state.getBoundingClientRect().height))
      .withContext("the duration and headcount are one line, not a column")
      .toBeLessThan(28);
  });

  it("names whose screen is on the stage, and says so on every screen tile", () => {
    /*
     * dathq, 2026-09-16: with a share up it was hard to tell who was sharing.
     * Zoom labels the content "X's screen", Meet says "X is presenting" —
     * either way the answer belongs *on* the picture, not in a list elsewhere.
     * The people tiles already carried a name; the screens carried none.
     */
    calls.setPeerScreen(new MediaStream(), "google_them");
    calls.localScreen.set(new MediaStream());
    calls.call.set(
      liveCall({
        media: "video",
        sharingScreen: true,
        sendingVideo: true,
        participantIds: ["google_me", "google_them", "google_third"],
        joinedIds: ["google_me", "google_them", "google_third"],
      }),
    );
    fixture.detectChanges();

    // Both screens carry a label: the one on the stage and the one waiting in
    // the strip, which is where "whose is that" is hardest to answer.
    const labels = Array.from(
      root().querySelectorAll<HTMLElement>("[data-testid='call-screen-owner']"),
    );
    expect(labels.length).toBe(2);

    const byOwner = new Map(
      labels.map((label) => [
        label.getAttribute("data-owner"),
        label.textContent?.trim() ?? "",
      ]),
    );
    expect(byOwner.get("google_them"))
      .withContext("a peer's share is named")
      .toContain("MESSENGER.CALL.SCREEN_OF");
    expect(byOwner.get("google_me"))
      .withContext("and your own says so, rather than naming you")
      .toContain("MESSENGER.CALL.SCREEN_YOURS");

    // The glyph is sized against the words beside it, not against the icon
    // font's own 1rem default, which read half again too big on a 0.625rem
    // label.
    const label = labels[0];
    const glyph = label.querySelector(".pi") as HTMLElement;
    const labelSize = parseFloat(getComputedStyle(label).fontSize);
    const glyphSize = parseFloat(getComputedStyle(glyph).fontSize);
    expect(glyphSize)
      .withContext(`glyph ${glyphSize}px beside ${labelSize}px text`)
      .toBeLessThanOrEqual(labelSize);
  });

  describe("personal pin", () => {
    /*
     * dathq, 2026-09-16: "can we have like GG meet with personal pin?" — and,
     * in the same breath, two shares leaving "way too many dark space". They
     * are one feature: the dark space came from splitting the stage between
     * presentations, and a pin is what lets one of them hold it.
     *
     * Pinning is **local**. Meet, Zoom and Teams all keep "pin" to the viewer
     * and reserve a separate verb for the shared one; nothing here reaches the
     * wire, which is why `LiveCall` is untouched by all of it.
     */
    const twoScreens = () => {
      calls.setPeerStream(new MediaStream());
      calls.localStream.set(new MediaStream());
      calls.setPeerScreen(new MediaStream());
      calls.localScreen.set(new MediaStream());
      calls.call.set(
        liveCall({ media: "video", sharingScreen: true, sendingVideo: true }),
      );
      fixture.detectChanges();
    };

    it("gives the stage to one screen and the strip to the other", () => {
      twoScreens();

      expect(
        root().querySelectorAll("[data-testid='call-tile-aside-screen']")
          .length,
      )
        .withContext(
          "the second share waits in the strip, it does not halve the stage",
        )
        .toBe(1);
    });

    it("moves a pinned screen onto the stage", () => {
      twoScreens();
      const onStage = () =>
        root()
          .querySelector("[data-testid='call-screens'] [data-call-screen]")
          ?.getAttribute("data-owner") ?? null;
      const first = onStage();

      // Pin the one that is not currently up.
      const aside = root().querySelector(
        "[data-testid='call-tile-aside-screen'] [data-testid='call-pin']",
      ) as HTMLElement;
      aside.click();
      fixture.detectChanges();

      expect(onStage()).not.toBe(first);
    });

    it("puts the people on the stage while somebody is still sharing", () => {
      /*
       * Meet: "unpin the presentation if you want to look at the people
       * instead of the slides". The stage always fell back to the first shared
       * screen, so while anybody shared you could not choose to see faces at
       * all — a one-way door into the presentation.
       */
      twoScreens();
      expect(query("[data-testid='call-screens']")).not.toBeNull();

      (query("[data-testid='call-show-people']") as HTMLElement).click();
      fixture.detectChanges();

      expect(query("[data-testid='call-screens']"))
        .withContext("nothing holds the stage; the people do")
        .toBeNull();
      // Both screens are still in the call, as tiles, one click from returning.
      expect(
        root().querySelectorAll("[data-testid='call-tile-aside-screen']")
          .length,
      ).toBe(2);
    });

    it("gives the stage back by pinning a screen again", () => {
      twoScreens();
      (query("[data-testid='call-show-people']") as HTMLElement).click();
      fixture.detectChanges();
      expect(query("[data-testid='call-screens']")).toBeNull();

      (
        root().querySelector(
          "[data-testid='call-tile-aside-screen'] [data-testid='call-pin']",
        ) as HTMLElement
      ).click();
      fixture.detectChanges();

      expect(query("[data-testid='call-screens']")).not.toBeNull();
    });

    it("lets a new share take the stage back from the people view", () => {
      /*
       * Somebody starts sharing to show you something; you must not miss it
       * because you dismissed a different presentation earlier. Meet brings a
       * new presentation forward for the same reason. Only an *increase*
       * counts — a share ending must not drag the stage over your choice.
       */
      calls.setPeerScreen(new MediaStream());
      calls.call.set(liveCall({ media: "video", sharingScreen: true }));
      fixture.detectChanges();
      (query("[data-testid='call-show-people']") as HTMLElement).click();
      fixture.detectChanges();
      expect(query("[data-testid='call-screens']")).toBeNull();

      // A second person starts sharing.
      calls.localScreen.set(new MediaStream());
      fixture.detectChanges();

      expect(query("[data-testid='call-screens']"))
        .withContext("a new presentation is worth seeing")
        .not.toBeNull();
    });

    it("keeps the people view when a share merely stops", () => {
      twoScreens();
      (query("[data-testid='call-show-people']") as HTMLElement).click();
      fixture.detectChanges();

      calls.localScreen.set(null);
      fixture.detectChanges();

      expect(query("[data-testid='call-screens']"))
        .withContext(
          "one share ended; that is not a reason to override a choice",
        )
        .toBeNull();
    });

    it("lets go of a pin when the thing it points at stops", () => {
      /*
       * A pin that outlives its source holds the stage on a rectangle that no
       * longer exists, with no way back — the same failure shape as any state
       * nothing closes when its subject dies.
       */
      twoScreens();
      const aside = root().querySelector(
        "[data-testid='call-tile-aside-screen'] [data-testid='call-pin']",
      ) as HTMLElement;
      aside.click();
      fixture.detectChanges();

      // Everyone stops sharing.
      calls.setPeerScreen(null);
      calls.localScreen.set(null);
      calls.call.set(liveCall({ media: "video", sendingVideo: true }));
      fixture.detectChanges();

      expect(query("[data-testid='call-screens']"))
        .withContext("nothing is shared, so nothing holds the stage")
        .toBeNull();
      expect(query("[data-testid='call-tile-peer']")).not.toBeNull();
    });

    it("pins a person, putting their camera on the stage with no share at all", () => {
      calls.setPeerStream(new MediaStream());
      calls.localStream.set(new MediaStream());
      calls.call.set(liveCall({ media: "video", sendingVideo: true }));
      fixture.detectChanges();
      expect(query("[data-testid='call-tile-stage']")).toBeNull();

      (
        root().querySelector(
          "[data-testid='call-tile-peer'] [data-testid='call-pin']",
        ) as HTMLElement
      ).click();
      fixture.detectChanges();

      expect(query("[data-testid='call-tile-stage']")).not.toBeNull();
      expect(
        (query("[data-testid='call-stage-video']") as HTMLElement).getAttribute(
          "data-owner",
        ),
      ).toBe("google_them");
    });

    it("shows the avatar when the person pinned has no camera", () => {
      /*
       * dathq, 2026-09-16: "when we pin an avatar it just showing blank".
       * The stage rendered a `<video>` and nothing else, so pinning somebody
       * whose camera is off produced a large dark rectangle. The people tiles
       * have always fallen back to the avatar; the stage did not, because it
       * was written for screens, where there is always a picture.
       */
      calls.call.set(
        liveCall({
          media: "video",
          participantIds: ["google_me", "google_them"],
          joinedIds: ["google_me", "google_them"],
        }),
      );
      fixture.detectChanges();

      (
        root().querySelector(
          "[data-testid='call-tile-peer'] [data-testid='call-pin']",
        ) as HTMLElement
      ).click();
      fixture.detectChanges();

      const stage = query("[data-testid='call-tile-stage']") as HTMLElement;
      expect(stage).not.toBeNull();
      expect(stage.querySelector("[data-testid='call-stage-avatar']"))
        .withContext("a face, not an empty video")
        .not.toBeNull();

      /*
       * And it has to be *visible*. `.call-tile` clips its overflow, so a tile
       * with no size of its own hides everything inside it — the element is
       * present and correct in the DOM and the stage is empty on screen, which
       * is what a structural assertion cannot see (dathq, twice in a row).
       */
      const box = stage.getBoundingClientRect();
      expect(box.width)
        .withContext(`stage tile measured ${box.width}x${box.height}`)
        .toBeGreaterThan(50);
      expect(box.height)
        .withContext(`stage tile measured ${box.width}x${box.height}`)
        .toBeGreaterThan(50);
    });

    it("shows the camera on the stage when the person pinned has one", () => {
      const theirs = new MediaStream();
      calls.setPeerStream(theirs, "google_them");
      calls.call.set(
        liveCall({
          media: "video",
          participantIds: ["google_me", "google_them"],
          joinedIds: ["google_me", "google_them"],
        }),
      );
      fixture.detectChanges();

      (
        root().querySelector(
          "[data-testid='call-tile-peer'] [data-testid='call-pin']",
        ) as HTMLElement
      ).click();
      fixture.detectChanges();

      expect(query("[data-testid='call-stage-avatar']")).toBeNull();
      const video = query(
        "[data-testid='call-stage-video']",
      ) as HTMLVideoElement;
      expect(video.srcObject).toBe(theirs);

      // Bound *and* on screen: the element can carry the right stream inside a
      // tile that has collapsed to nothing.
      const box = video.getBoundingClientRect();
      expect(box.width)
        .withContext(`stage video measured ${box.width}x${box.height}`)
        .toBeGreaterThan(50);
    });

    it("unpins when the same tile is pinned twice", () => {
      calls.setPeerStream(new MediaStream());
      calls.call.set(liveCall({ media: "video", sendingVideo: true }));
      fixture.detectChanges();

      const pin = () =>
        root().querySelector(
          "[data-testid='call-tile-peer'] [data-testid='call-pin']",
        ) as HTMLElement;
      pin().click();
      fixture.detectChanges();
      expect(query("[data-testid='call-tile-stage']")).not.toBeNull();

      pin().click();
      fixture.detectChanges();
      expect(query("[data-testid='call-tile-stage']")).toBeNull();
    });
  });

  it("lays the grid out by what is in it, screens included", async () => {
    /*
     * dathq, 2026-09-16, from a screenshot of three shares and three people:
     * the grid came out ragged, with the last tile centred at half width in a
     * row that was already full.
     *
     * `oddTiles` counted *people* — peers + self — but since screens that are
     * not on the stage joined this same container, the count it centres on is
     * no longer the number of tiles being laid out. Six tiles in two columns
     * is three full rows and needs no centring at all.
     */
    if (window.innerWidth < 960) {
      fail(`needs a viewport of at least 960px; got ${window.innerWidth}px`);
      return;
    }
    const everyone = ["google_me", "google_them", "google_third"];
    for (const ownerId of everyone.slice(1)) {
      calls.setPeerStream(new MediaStream(), ownerId);
      calls.setPeerScreen(new MediaStream(), ownerId);
    }
    calls.localStream.set(new MediaStream());
    calls.localScreen.set(new MediaStream());
    calls.call.set(
      liveCall({
        media: "video",
        sharingScreen: true,
        sendingVideo: true,
        participantIds: everyone,
        joinedIds: everyone,
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();

    // The people view, so every screen and every person is a tile together.
    (query("[data-testid='call-show-people']") as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();

    const tiles = Array.from(
      (
        root().querySelector("[data-testid='call-people']") as HTMLElement
      ).querySelectorAll<HTMLElement>(
        "[data-testid='call-tile-peer'], [data-testid='call-tile-self'], [data-testid='call-tile-aside-screen']",
      ),
    );
    expect(tiles.length).withContext("three screens and three people").toBe(6);

    /*
     * Rows, not widths. The centring rule keeps the trailing tile the *same
     * width* as its siblings on purpose — what it changes is that the tile
     * spans the row on its own, which a width assertion cannot see and a
     * screenshot shows instantly.
     */
    const rows = new Map<number, number>();
    for (const tile of tiles) {
      const top = Math.round(tile.getBoundingClientRect().top);
      rows.set(top, (rows.get(top) ?? 0) + 1);
    }
    const perRow = [...rows.values()];
    expect(perRow.length)
      .withContext(`six tiles in two columns is three rows, got ${perRow}`)
      .toBe(3);
    for (const count of perRow) {
      expect(count)
        .withContext(`tiles per row were ${perRow.join(", ")}`)
        .toBe(2);
    }
  });

  it("keeps every tile reachable when the strip is full", async () => {
    /*
     * The mesh cap is 4 (`MAX_CALL_PARTICIPANTS`), so "too many people" is not
     * reachable — realtime-service refuses the invite in a bigger conversation.
     * "Too many **tiles**" is: all four may share a screen at once, and with
     * one screen on the stage the strip holds 4 people + 3 screens = 7. The
     * strip had no overflow rule, so the ones past the bottom were simply
     * clipped by the stage — the same class of fault as the four-tile column
     * that cut off its bottom two (2026-09-11).
     */
    if (window.innerWidth < 960) {
      fail(`needs a viewport of at least 960px; got ${window.innerWidth}px`);
      return;
    }

    const everyone = [
      "google_me",
      "google_them",
      "google_third",
      "google_four",
    ];
    for (const ownerId of everyone.slice(1)) {
      calls.setPeerStream(new MediaStream(), ownerId);
      calls.setPeerScreen(new MediaStream(), ownerId);
    }
    calls.localStream.set(new MediaStream());
    calls.localScreen.set(new MediaStream());
    calls.call.set(
      liveCall({
        media: "video",
        sharingScreen: true,
        sendingVideo: true,
        participantIds: everyone,
        joinedIds: everyone,
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();

    const dock = root().querySelector(
      "[data-testid='call-dock']",
    ) as HTMLElement;
    if (!dock.classList.contains("is-stage")) {
      (
        root().querySelector("[data-testid='call-expand']") as HTMLElement
      ).click();
      fixture.detectChanges();
      await fixture.whenStable();
    }

    const strip = root().querySelector(
      "[data-testid='call-people']",
    ) as HTMLElement;
    const tiles = Array.from(
      strip.querySelectorAll<HTMLElement>(
        "[data-testid='call-tile-peer'], [data-testid='call-tile-self'], [data-testid='call-tile-aside-screen']",
      ),
    );
    expect(tiles.length)
      .withContext("four people and the three screens not on the stage")
      .toBe(7);

    // Either the strip scrolls, or every tile fits. What it must not do is
    // silently hide people below the fold with no way to reach them.
    const scrollable = strip.scrollHeight > strip.clientHeight + 1;
    const canScroll = ["auto", "scroll"].includes(
      getComputedStyle(strip).overflowY,
    );
    expect(!scrollable || canScroll)
      .withContext(
        `strip content ${strip.scrollHeight}px in ${strip.clientHeight}px with overflow-y: ${getComputedStyle(strip).overflowY}`,
      )
      .toBeTrue();
  });

  it("keeps every tile the same width beside a presentation", async () => {
    /*
     * dathq, 2026-09-16, from a screenshot of a three-way call with a screen
     * up: "the third avatar is smaller than the rest".
     *
     * `.call-people.is-grid.is-odd .call-tile:last-child` centres a trailing
     * tile at `width: calc(50% - 0.1875rem)`, which is right in the two-column
     * grid where 50% *is* one column. Above 60rem a presentation puts the
     * people in a **single** column, and that rule went on applying — so the
     * third person rendered at half the width of the other two. Nothing
     * errored and every class and testid assertion passed, which is the whole
     * reason this measures instead.
     */
    if (window.innerWidth < 960) {
      fail(
        `this spec needs a viewport of at least 960px to reach the presenting ` +
          `column layout; got ${window.innerWidth}px. See karma.conf.js.`,
      );
      return;
    }

    calls.call.set(
      liveCall({
        media: "video",
        sharingScreen: true,
        sendingVideo: true,
        participantIds: ["google_me", "google_them", "google_third"],
        joinedIds: ["google_me", "google_them", "google_third"],
      }),
    );
    calls.setPeerScreen(new MediaStream(), "google_them");
    fixture.detectChanges();
    await fixture.whenStable();

    const root = fixture.nativeElement.parentElement ?? document.body;
    const dock = root.querySelector("[data-testid='call-dock']") as HTMLElement;
    if (!dock.classList.contains("is-stage")) {
      (
        root.querySelector("[data-testid='call-expand']") as HTMLElement
      ).click();
      fixture.detectChanges();
      await fixture.whenStable();
    }

    const tiles = [
      ...root.querySelectorAll(
        "[data-testid='call-tile-peer'], [data-testid='call-tile-self']",
      ),
    ] as HTMLElement[];
    expect(tiles.length).withContext("two others plus this user").toBe(3);

    const widths = tiles.map((tile) =>
      Math.round(tile.getBoundingClientRect().width),
    );
    for (const width of widths) {
      expect(width)
        .withContext(`tile widths were ${widths.join(", ")}`)
        .toBe(widths[0]);
    }
  });

  it("renders a tile per person, keyed by owner, and never by position", async () => {
    /*
     * A mesh adds and drops tiles mid-call. Bound by index, one person's
     * camera lands in another's tile the moment somebody between them leaves
     * — and every class and testid assertion still passes while it does.
     */
    calls.call.set(
      liveCall({
        media: "video",
        participantIds: ["google_me", "google_them", "google_third"],
        joinedIds: ["google_me", "google_them", "google_third"],
      }),
    );
    const theirs = new MediaStream();
    calls.setPeerStream(theirs, "google_them");
    fixture.detectChanges();
    await fixture.whenStable();

    const tiles = [
      ...(
        fixture.nativeElement.parentElement ?? document.body
      ).querySelectorAll(
        "[data-testid='call-tile-peer'], [data-testid='call-tile-self']",
      ),
    ] as HTMLElement[];
    expect(tiles.length).withContext("two others plus this user").toBe(3);
    expect(tiles.map((t) => t.dataset["owner"])).toEqual([
      "google_them",
      "google_third",
      "google_me",
    ]);

    const video = (
      fixture.nativeElement.parentElement ?? document.body
    ).querySelector(
      "[data-call-video][data-owner='google_them']",
    ) as HTMLVideoElement;
    expect(video.srcObject)
      .withContext("their camera is on their own tile")
      .toBe(theirs);

    const empty = (
      fixture.nativeElement.parentElement ?? document.body
    ).querySelector(
      "[data-call-video][data-owner='google_third']",
    ) as HTMLVideoElement;
    expect(empty.srcObject).withContext("and nobody else's is").toBeNull();
  });

  it("gives up the fixed tile shape once there are more than two faces", () => {
    // Four 16:9 tiles in one auto-fit column are taller than the stage, and
    // the bottom two are simply cut off.
    calls.call.set(liveCall({ media: "video" }));
    fixture.detectChanges();
    const people = query("[data-testid='call-people']") as HTMLElement;
    expect(people.classList).not.toContain("is-grid");

    calls.call.set(
      liveCall({
        media: "video",
        participantIds: ["google_me", "google_them", "google_third"],
        joinedIds: ["google_me", "google_them", "google_third"],
      }),
    );
    fixture.detectChanges();

    expect(
      (query("[data-testid='call-people']") as HTMLElement).classList,
    ).toContain("is-grid");
  });

  it("names a group by its conversation, never by one participant", () => {
    // "Dat Ha" on a call with three people is simply wrong — the same mistake
    // a group presence dot makes by reporting whoever is listed first.
    calls.call.set(
      liveCall({
        participantIds: ["google_me", "google_them", "google_third"],
        joinedIds: ["google_me", "google_them", "google_third"],
      }),
    );
    fixture.detectChanges();

    expect((query(".call-peer") as HTMLElement).textContent?.trim()).toBe(
      "Project Falcon",
    );
  });

  it("says who is calling on a group ring, which the group's name cannot", () => {
    // Translated for real here: the point of the line is the interpolated
    // name, and an untranslated key renders no parameters at all.
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation(
      "en",
      { MESSENGER: { CALL: { INCOMING_GROUP: "{{name}} is calling" } } },
      true,
    );
    translate.use("en");

    calls.call.set(
      liveCall({
        direction: "incoming",
        state: "ringing",
        callerOwnerId: "google_them",
        participantIds: ["google_me", "google_them", "google_third"],
        joinedIds: [],
      }),
    );
    fixture.detectChanges();

    expect((query(".call-state") as HTMLElement).textContent).toContain(
      "Dat Ha",
    );
  });
});
