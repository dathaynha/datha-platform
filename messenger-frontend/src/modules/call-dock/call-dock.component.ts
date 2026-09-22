import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { ButtonModule } from "primeng/button";
import type { CallLabel } from "src/helper/call-row-label";
import { environment } from "src/environments/environment";
import { ChatStore } from "src/services/implementations/chat-store.service";
import { WebrtcCallService } from "src/services/implementations/webrtc-call.service";
import { PersonAvatarComponent } from "src/modules/shared/person-avatar/person-avatar.component";
import {
  AvatarStackComponent,
  type AvatarFace,
} from "src/modules/shared/avatar-stack/avatar-stack.component";

/** Timer tick. One second is the resolution a call duration is read at. */
const TICK_MS = 1_000;

/** How often the dev-only call diagnostics are sampled. */
const DIAGNOSTICS_MS = 5_000;

/**
 * The floating call panel: ring, accept/decline, mute, hang up, duration.
 *
 * Rendered by the **header widget**, not by a route. That is the whole design:
 * the widget is mounted by the shell from login onward, so navigating to
 * `/chatbot` mid-call re-renders nothing here and the `RTCPeerConnection`
 * survives — the phase-2 exit criterion. A dock inside `/messenger`'s routes
 * would be destroyed the moment the user left, dropping the call.
 *
 * It renders nothing at all when there is no call, so the header is untouched
 * the rest of the time.
 */
@Component({
  selector: "messenger-call-dock",
  imports: [
    TranslateModule,
    ButtonModule,
    PersonAvatarComponent,
    AvatarStackComponent,
  ],
  templateUrl: "./call-dock.component.html",
  styleUrls: ["./call-dock.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallDockComponent {
  private readonly calls = inject(WebrtcCallService);
  private readonly chats = inject(ChatStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /*
   * Re-parented to `body`.
   *
   * The panel is `position: fixed`, but the shell's toolbar carries
   * `backdrop-filter: blur(14px)`, and a backdrop-filter **creates a
   * containing block for fixed descendants**. Mounted inside the header
   * widget, "bottom: 1rem" therefore resolved against the *toolbar* — so an
   * incoming call appeared jammed into the top-right of the screen
   * (reported 2026-09-10).
   *
   * Moving the host element out keeps the component owned by the header
   * widget — which is what makes a call survive navigation — while its DOM
   * escapes the containing block. Cheaper than pulling the CDK overlay
   * across the Module Federation boundary for one panel.
   */
  private reparent(): void {
    /*
     * After the first render, not in the constructor.
     *
     * Angular inserts a host node at its anchor *after* the component is
     * constructed, so a constructor-time `appendChild` is silently undone for
     * any dock that sits inside a control-flow block. It only ever worked
     * because the header widget renders this statically; mounting it under an
     * `@if` for the standalone app (2026-09-15) put it straight back inside
     * the layout, where `backdrop-filter` and `overflow: hidden` ancestors are
     * exactly what the re-parenting exists to escape.
     */
    afterNextRender(() => {
      const element = this.host.nativeElement;
      document.body.appendChild(element);
      this.destroyRef.onDestroy(() => element.remove());
    });
  }

  protected readonly call = this.calls.call;
  protected readonly error = this.calls.error;
  protected readonly endNotice = this.calls.endNotice;

  /**
   * How the call was **set up** — what it is called, not what it is showing.
   *
   * Drives wording only: the incoming ring, and whether the camera control
   * reads "add" or "turn off". A voice call carrying a shared screen is still
   * a voice call (dathq, 2026-09-11).
   */
  protected readonly isVideo = computed(() => this.call()?.media === "video");

  /** Any picture to lay out — a camera or a screen, either side. */
  protected readonly hasVideo = this.calls.hasVideo;

  /** We have a camera track of our own, so the control toggles it. */
  protected readonly sendingCamera = computed(
    () => this.call()?.sendingVideo === true,
  );

  /** No camera means no promoting an audio call, so the control is not shown. */
  protected readonly hasCamera = this.calls.hasCamera;

  protected readonly localStream = this.calls.localStream;
  protected readonly localScreen = this.calls.localScreen;

  /** More than two people invited, so there is no single "the other person". */
  protected readonly isGroup = this.calls.isGroupCall;

  /**
   * Everyone else in the call, in the order the service fixes.
   *
   * A 1:1 call has one entry and a mesh has up to three, and the template
   * renders the same tile for each — the pair is not a special case with its
   * own layout. Two mechanisms for one job is how the stage came to render at
   * the compact width while 135 specs passed (2026-09-11).
   */
  protected readonly peers = this.calls.peers;

  /** Tiles for people: everyone else, plus this user. */
  protected readonly tileCount = computed(() => this.peers().length + 1);

  /**
   * Everything laid out in the people container, screens included.
   *
   * `tileCount` counts *people*, which is what the mesh cares about. The
   * container stopped being people-only on 2026-09-16, when screens that are
   * not holding the stage moved into it — and laying out six tiles on a count
   * of three stranded two of them one per row (dathq, with a screenshot;
   * measured at 2, 2, 1, 1). A layout rule has to count what it is laying out.
   */
  protected readonly laidOutTiles = computed(
    () => this.tileCount() + this.asideScreens().length,
  );

  /**
   * Three or more faces no longer fit in a row, so the tiles give up their
   * fixed 16:9 shape and fill a square grid instead.
   */
  protected readonly gridded = computed(() => this.laidOutTiles() > 2);

  /**
   * An odd number of faces, so the last tile is centred rather than left
   * beside an empty cell that reads as somebody who failed to connect.
   */
  protected readonly oddTiles = computed(() => this.laidOutTiles() % 2 === 1);

  protected readonly localHasVideo = computed(
    () => this.call()?.sendingVideo === true,
  );

  /**
   * Shared screens are tiles of their own, never a participant's tile.
   *
   * A screen used to take over the camera tile, so once both people shared
   * neither could see the other — Meet shows four: two presentations and two
   * people (dathq, 2026-09-11). In a mesh there can be one per participant.
   */
  protected readonly screens = computed<
    readonly { ownerId: string; stream: MediaStream }[]
  >(() => {
    const shared = this.peers().flatMap((peer) =>
      peer.screen ? [{ ownerId: peer.ownerId, stream: peer.screen }] : [],
    );
    const own = this.localScreen();
    return own
      ? [...shared, { ownerId: this.chats.currentOwnerId(), stream: own }]
      : shared;
  });

  /**
   * The shape of each shared screen, by owner, as the track actually reports
   * it.
   *
   * A screen is almost never the shape of the box it is put in: laptops are
   * 16:10, a shared window is whatever the person dragged it to, and an
   * external monitor can be 21:9. The tile was a generic one whose shape came
   * from the grid cell, and `object-fit: contain` — which must stay, because
   * cropping a screen hides the edges of somebody's code — painted the
   * remainder black. That is the "way too many dark space" dathq reported on
   * 2026-09-16.
   *
   * Read from the element rather than guessed, and re-read on `resize`,
   * because a sharer who switches window changes the ratio mid-call.
   */
  protected readonly screenRatios = signal<ReadonlyMap<string, number>>(
    new Map(),
  );

  /** Records one screen's real aspect ratio. Ignores a not-yet-ready track. */
  protected measureScreen(event: Event): void {
    const element = event.target as HTMLVideoElement;
    const ownerId = element.dataset["owner"] ?? "";
    if (!ownerId || !element.videoWidth || !element.videoHeight) return;
    const ratio = element.videoWidth / element.videoHeight;
    this.screenRatios.update((current) => {
      if (current.get(ownerId) === ratio) return current;
      const next = new Map(current);
      next.set(ownerId, ratio);
      return next;
    });
  }

  /** `width / height` for a screen tile, or null before the track reports one. */
  protected screenRatio(ownerId: string): number | null {
    return this.screenRatios().get(ownerId) ?? null;
  }

  protected readonly screenCount = computed(() => this.screens().length);

  /**
   * What this viewer has pinned, if anything.
   *
   * **Personal, and local only.** Pinning is a view preference, so it never
   * reaches the wire and nobody else can tell: Meet, Zoom and Teams all keep
   * "pin" local and reserve a separate verb ("spotlight") for the shared one,
   * which needs a host concept this product does not have. Keeping it out of
   * `LiveCall` is what stops it drifting into announced call state.
   *
   * A **source**, not a person: with two screens up, "pin Dat Ha" cannot say
   * whether it means his camera or his screen. Keyed by owner id and kind,
   * never by tile position — a mesh adds and drops tiles mid-call, and a pin
   * held by position would silently follow whoever slid into that slot.
   */
  private readonly pinnedSource = signal<
    { ownerId: string; kind: "camera" | "screen" } | "people" | null
  >(null);

  protected readonly pinned = this.pinnedSource.asReadonly();

  /** How many screens were up last time, so a *new* share can take the stage. */
  private previousScreenCount = 0;

  /** True when this exact source is the one pinned. */
  protected isPinned(ownerId: string, kind: "camera" | "screen"): boolean {
    const pin = this.pinnedSource();
    return (
      pin !== null &&
      pin !== "people" &&
      pin.ownerId === ownerId &&
      pin.kind === kind
    );
  }

  /** Click a tile to pin it, click the pinned one again to let go. */
  protected togglePin(ownerId: string, kind: "camera" | "screen"): void {
    this.pinnedSource.update((current) =>
      current !== null &&
      current !== "people" &&
      current.ownerId === ownerId &&
      current.kind === kind
        ? null
        : { ownerId, kind },
    );
  }

  /**
   * Take the presentation off the stage and look at the people instead.
   *
   * Meet has this and we did not: the stage always fell back to the first
   * shared screen, so while anybody was sharing you could not choose to see
   * faces at all. "Unpin the presentation if you want to look at the people
   * instead of the slides" is the behaviour being matched.
   *
   * A distinct state rather than a second boolean, because "nothing is
   * pinned" (show the presentation by default) and "the people are what I want
   * to see" are different answers and two flags would drift apart.
   */
  protected showPeople(): void {
    this.pinnedSource.set("people");
  }

  /** True while the people hold the stage even though a screen is up. */
  protected readonly peopleChosen = computed(
    () => this.pinnedSource() === "people" && this.screenCount() > 0,
  );

  /**
   * The source the stage gives its room to.
   *
   * A pin wins; otherwise the first shared screen does, which is what makes a
   * presentation the thing you look at without anybody having to ask for it.
   *
   * Resolved against what is actually on the call rather than trusted: a pin
   * whose person left, or whose screen stopped, would otherwise hold the stage
   * on a source that no longer exists — a dead rectangle with no way back. The
   * same reasoning as any state that must not outlive its subject.
   */
  protected readonly focus = computed<{
    ownerId: string;
    kind: "camera" | "screen";
  } | null>(() => {
    const pin = this.pinnedSource();
    if (pin === "people") return null;
    if (pin) {
      const alive =
        pin.kind === "screen"
          ? this.screens().some((s) => s.ownerId === pin.ownerId)
          : pin.ownerId === this.selfOwnerId() ||
            this.peers().some((p) => p.ownerId === pin.ownerId);
      if (alive) return pin;
    }
    const first = this.screens()[0];
    return first ? { ownerId: first.ownerId, kind: "screen" } : null;
  });

  /**
   * Whether the person on the stage actually has a picture to show.
   *
   * Pinning is about attention, not about video — you pin somebody to watch
   * them while slides are up, and they may well have their camera off. The
   * stage was written for screens, where there is always a picture, so it
   * rendered an empty `<video>` and nothing else (dathq, 2026-09-16: "when we
   * pin an avatar it just showing blank").
   */
  protected readonly stageHasVideo = computed(() => {
    const focused = this.focus();
    if (focused?.kind !== "camera") return false;
    if (focused.ownerId === this.selfOwnerId()) return this.localHasVideo();
    return (
      this.peers().find((peer) => peer.ownerId === focused.ownerId)?.stream !=
      null
    );
  });

  /**
   * Whose screen this is, worded for the tile it sits on.
   *
   * Every mainstream client labels the *content*, not a list somewhere else:
   * Zoom says "X's screen", Meet says "X is presenting". Ours had no label at
   * all, so with two shares up there was nothing to say which was whose
   * (dathq, 2026-09-16). The people tiles have always carried a name; the
   * screens were the odd ones out.
   */
  protected screenLabel(ownerId: string): CallLabel {
    return ownerId === this.selfOwnerId()
      ? { key: "MESSENGER.CALL.SCREEN_YOURS" }
      : {
          key: "MESSENGER.CALL.SCREEN_OF",
          params: { name: this.nameFor(ownerId) },
        };
  }

  /** The focused screen's stream, when a screen is what holds the stage. */
  protected readonly focusedScreen = computed(() => {
    const focused = this.focus();
    if (focused?.kind !== "screen") return null;
    return this.screens().find((s) => s.ownerId === focused.ownerId) ?? null;
  });

  /** The screens that are not on the stage, so they can go in the strip. */
  protected readonly asideScreens = computed(() => {
    const focused = this.focus();
    return this.screens().filter(
      (screen) =>
        !(focused?.kind === "screen" && focused.ownerId === screen.ownerId),
    );
  });

  /** People move to a side strip once there is a presentation to look at. */
  /**
   * The stage has something on it, so the people move to a strip beside it.
   *
   * Driven by `focus`, not by the screen count: pinning a person puts their
   * camera on the stage with no screen shared at all, and the people still
   * belong at the side of it.
   */
  protected readonly presenting = computed(() => this.focus() !== null);

  /**
   * Initial for a tile with no picture.
   *
   * From the directory, never from `displayName` — that falls back to the raw
   * owner id, and every id starts `google_`, so everyone came out "G"
   * (reported 2026-09-11). The store knows who we are too, so this user's own
   * tile gets a real initial rather than a neutral mark: a tile has to read as
   * a person.
   */
  protected initialFor(ownerId: string): string {
    return this.chats.initialOf(ownerId) || "?";
  }

  /** Someone's directory picture, empty when there is none. */
  protected avatarFor(ownerId: string): string {
    return this.chats.pictureUrl(ownerId);
  }

  /** This user's own owner id, for their tile. */
  protected readonly selfOwnerId = computed(() => this.chats.currentOwnerId());

  protected nameFor(ownerId: string): string {
    return this.chats.displayName(ownerId);
  }

  /**
   * The faces of the call for the dock's header.
   *
   * Everyone invited except this user, so a 1:1 renders exactly the single
   * avatar it always did and a group renders the stack — the same component
   * the conversation list and the thread header use, which is what keeps the
   * three rules that kept drifting (directory picture, letter fallback, failed
   * load) in one place.
   */
  protected readonly faces = computed<readonly AvatarFace[]>(() => {
    const call = this.call();
    if (!call) return [];
    return call.participantIds
      .filter((ownerId) => ownerId !== this.selfOwnerId())
      .map((ownerId) => ({
        ownerId,
        url: this.chats.pictureUrl(ownerId),
        name: this.chats.displayName(ownerId),
        initial: this.chats.initialOf(ownerId),
      }));
  });

  private readonly minimised = signal(false);

  /**
   * Whether the call takes over the screen.
   *
   * Video expands by default and audio never does — a voice call has nothing
   * to look at, so a full-screen panel would just be in the way. Messenger
   * solves this with a separate popup **window**, which is not available to
   * us: a new document tears down the `RTCPeerConnection`, and a call
   * surviving navigation is a phase-2 guarantee. So this is Slack's model —
   * expand in place, minimise back to the dock, never drop the call.
   */
  protected readonly expanded = computed(
    () => this.hasVideo() && !this.minimised() && !this.isIncomingRing(),
  );

  protected toggleExpanded(): void {
    this.minimised.update((value) => !value);
  }

  protected toggleScreenShare(): void {
    void this.calls.toggleScreenShare();
  }

  /** Cameras offered by the picker. Empty until permission has been granted. */
  protected readonly cameras = signal<readonly MediaDeviceInfo[]>([]);

  /**
   * Binds the media streams onto the two `<video>` elements.
   *
   * An effect rather than a template binding because `srcObject` is a DOM
   * property that takes an object, which a template cannot express, and
   * because `ontrack` can fire before the element exists — this re-runs when
   * either the stream or the element appears.
   */
  private bindStreams(): void {
    /*
     * `afterRenderEffect`, not `effect`, and it reads `call()` deliberately.
     *
     * The tiles are created when the call becomes video — but at that moment
     * no *value* this binding depends on has changed (a computed that
     * recomputes to the same result does not propagate), so a plain effect
     * never re-ran and the viewer's main tile was left with no `srcObject` at
     * all: one side shared, the other saw black (reported 2026-09-11).
     * Reading the whole call state re-runs it on any transition, and running
     * after render means the elements exist by the time it looks for them.
     */
    afterRenderEffect(() => {
      this.call();
      /*
       * And the stage, because pinning creates a `<video>` this effect has to
       * fill — and pinning changes nothing else it reads. A computed that
       * recomputes to the same value does not propagate, so without this the
       * new element is never bound and the stage shows a dark rectangle: the
       * same fault as the 2026-09-11 black tile, reached by a new route.
       */
      this.focus();
      const root = this.host.nativeElement;

      /*
       * Every tile carries the owner it belongs to, and the stream is looked
       * up by that id rather than by position — a mesh adds and drops tiles
       * mid-call, and an index-based binding would hand one person's camera to
       * another the moment somebody in between them left.
       */
      const byOwner = new Map<string, MediaStream | null>();
      for (const peer of this.peers()) byOwner.set(peer.ownerId, peer.stream);
      byOwner.set(this.selfOwnerId(), this.localStream());

      for (const element of Array.from(
        root.querySelectorAll<HTMLVideoElement>("[data-call-video]"),
      )) {
        const stream = byOwner.get(element.dataset["owner"] ?? "") ?? null;
        if (element.srcObject !== stream) element.srcObject = stream;
      }

      // Screens are separate tracks on separate streams, so separate elements.
      const screens = new Map(
        this.screens().map((entry) => [entry.ownerId, entry.stream]),
      );
      for (const element of Array.from(
        root.querySelectorAll<HTMLVideoElement>("[data-call-screen]"),
      )) {
        const stream = screens.get(element.dataset["owner"] ?? "") ?? null;
        if (element.srcObject !== stream) element.srcObject = stream;
      }
    });
  }

  /**
   * Lists cameras once a call is live.
   *
   * Deliberately after the call starts: before `getUserMedia` has been
   * granted, `enumerateDevices` returns entries with empty labels, so a picker
   * built from it would show "Camera 1, Camera 2" and nothing useful.
   */
  private async loadCameras(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.cameras.set(devices.filter((d) => d.kind === "videoinput"));
    } catch {
      this.cameras.set([]);
    }
  }

  /** Drives the duration label; a signal so OnPush re-renders on each tick. */
  private readonly now = signal(Date.now());

  /**
   * Who is on the other end, from the directory the store already caches.
   * `displayName` falls back to the owner id itself, so an unresolved user
   * still renders something rather than an empty panel.
   */
  private readonly peerName = computed(() => {
    const peer = this.calls.peerOwnerId();
    return peer ? this.chats.displayName(peer) : "";
  });

  /**
   * What the dock calls this call.
   *
   * A group is named by its conversation, not by whoever happens to sort
   * first: "Alice" on a call with Alice, Bob and Carol is simply wrong, and it
   * is the same mistake a group's presence dot would make by reporting the
   * first participant's. Falls back to a count when the conversation is not in
   * the loaded list — a call can ring from a thread the list has not reached.
   */
  protected readonly title = computed(() => {
    const call = this.call();
    if (!call) return "";
    if (!this.isGroup()) return this.peerName();
    const conversation = this.chats.conversationById(call.conversationId);
    return conversation ? this.chats.conversationTitle(conversation) : "";
  });

  /** Who placed the call — the only thing a group's own name cannot say. */
  protected readonly callerName = computed(() => {
    const call = this.call();
    return call ? this.chats.displayName(call.callerOwnerId) : "";
  });

  /** The name for the "Declined"/"Missed" line, after the call itself is gone. */
  protected readonly endPeerName = computed(() => {
    const notice = this.endNotice();
    if (!notice?.peerOwnerId) return "";
    return this.chats.displayName(notice.peerOwnerId);
  });

  /** `m:ss`, and empty until the call is actually active. */
  protected readonly duration = computed(() => {
    const activeSince = this.call()?.activeSince;
    if (!activeSince) return "";
    const total = Math.max(0, Math.floor((this.now() - activeSince) / 1_000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  });

  /** Incoming and still ringing — the only state with an accept button. */
  protected readonly isIncomingRing = computed(() => {
    const call = this.call();
    return call?.direction === "incoming" && call.state === "ringing";
  });

  /**
   * STUN-only, i.e. no relay on offer. Surfaced rather than hidden: it is the
   * difference between "works here" and "works for everyone", and it is
   * invisible on one machine.
   */
  protected readonly relayWarning = computed(() => {
    const call = this.call();
    return call !== null && call.state !== "ringing" && !call.relayAvailable;
  });

  constructor() {
    this.reparent();
    this.bindStreams();

    /*
     * A *new* share takes the stage back, even from a viewer who had chosen to
     * look at the people.
     *
     * Meet does the same — a new presentation arrives as a primary tile — and
     * the alternative is worse than it sounds: somebody starts sharing to show
     * you something, and you never see it because you dismissed a different
     * presentation ten minutes ago. Only an *increase* counts, so a share
     * ending does not drag the stage back over your choice.
     */
    effect(() => {
      const count = this.screenCount();
      const grew = count > this.previousScreenCount;
      this.previousScreenCount = count;
      if (grew && untracked(() => this.pinnedSource()) === "people") {
        this.pinnedSource.set(null);
      }
    });

    /*
     * A permanent development tool, deliberately kept (dathq, 2026-09-13).
     *
     * It was written to answer one question — unclear audio, which turned out
     * to be two tabs contending for one microphone, now surfaced properly by
     * `micSilent`. It stayed because the same numbers answer every *later*
     * question about a call: which candidate pair was nominated, whether loss
     * or jitter is real, whether this side is actually sending audio. Reasoning
     * about a live call without them is guesswork, and it proved so again
     * closing the cross-network relay criterion on 2026-09-13.
     *
     * Development builds only — `environment.production` keeps it out of a
     * shipped bundle, and nothing outside this block depends on it.
     */
    if (!environment.production) {
      const probe = setInterval(() => {
        if (this.calls.call()?.state !== "active") return;
        void this.calls.diagnostics().then((stats) => {
          if (!stats) return;
          console.info(
            "[call diagnostics]",
            `codec=${stats.codec}/${stats.clockRate}`,
            `in: lost=${stats.packetsLost} jitter=${stats.jitter} conceal=${stats.concealment}`,
            `out: sent=${stats.outbound.packetsSent} level=${stats.outbound.audioLevel}`,
            `pair=${stats.pair?.local}/${stats.pair?.remote} ${stats.pair?.protocol}`,
            `aec=${stats.capture.echoCancellation} ns=${stats.capture.noiseSuppression} agc=${stats.capture.autoGainControl}`,
          );
        });
      }, DIAGNOSTICS_MS);
      this.destroyRef.onDestroy(() => clearInterval(probe));
    }

    // Cameras can only be listed with useful labels once media permission has
    // been granted, so wait for a video call to actually be live.
    effect(() => {
      if (this.call()?.media === "video") void this.loadCameras();
    });

    const timer = setInterval(() => this.now.set(Date.now()), TICK_MS);
    this.destroyRef.onDestroy(() => clearInterval(timer));

    // A modal that asks a question has to take focus, or a keyboard user has
    // to hunt for the answer.
    effect(() => {
      if (!this.isIncomingRing()) return;
      queueMicrotask(() => {
        this.host.nativeElement
          .querySelector<HTMLButtonElement>(
            '[data-testid="call-accept"] button',
          )
          ?.focus();
      });
    });

    /*
     * Our own directory entry, which `hydratePeople` deliberately skips — a
     * chat title never needs our own name, but a call tile does. Without it
     * `displayName` fell back to the raw owner id and every self tile showed
     * "G", from `google_…` (reported 2026-09-11). Asked for here rather than
     * in the store, so a lookup only happens when a call actually needs it.
     */
    effect(() => {
      if (!this.call()) return;
      // `untracked`, because `ensurePerson` reads the directory as its own
      // guard — tracked, that makes this effect depend on the very signal the
      // lookup writes, so it re-runs on every directory change and asks again.
      untracked(
        () => void this.chats.ensurePerson(this.chats.currentOwnerId()),
      );
    });

    // A call can come from someone with no thread yet, so the directory may
    // not know their name. Ask for it rather than ringing an owner id — for
    // everyone invited, because a group tile needs a face before that person
    // has said anything.
    effect(() => {
      const call = this.call();
      if (!call) return;
      untracked(() => {
        for (const ownerId of call.participantIds) {
          void this.chats.ensurePerson(ownerId);
        }
      });
    });

    // Escape declines, as it dismisses any other modal.
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !this.isIncomingRing()) return;
      event.preventDefault();
      this.hangUp();
    };
    document.addEventListener("keydown", onKeydown);
    this.destroyRef.onDestroy(() =>
      document.removeEventListener("keydown", onKeydown),
    );
  }

  protected accept(): void {
    void this.calls.accept();
  }

  protected hangUp(): void {
    this.calls.hangUp();
  }

  protected toggleMute(): void {
    this.calls.toggleMute();
  }

  /**
   * One control, two meanings — which is what every messenger does.
   *
   * On a video call it suppresses the camera. On an audio call it *adds* one,
   * which is a renegotiation rather than a track flag.
   */
  protected onCamera(): void {
    // Toggle what we are already sending; otherwise add a camera. Keyed on the
    // track, not on the call's label, so it still means "add my camera" during
    // a screen share and on a video call answered without one.
    if (this.sendingCamera()) {
      this.calls.toggleCamera();
      return;
    }
    void this.calls.promoteToVideo();
  }

  protected pickCamera(event: Event): void {
    const deviceId = (event.target as HTMLSelectElement).value;
    if (deviceId) void this.calls.useCamera(deviceId);
  }

  protected dismissNotice(): void {
    this.calls.clearEndNotice();
  }
}
