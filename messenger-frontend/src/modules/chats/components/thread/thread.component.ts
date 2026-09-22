import type { CallMedia, CallRecord } from "src/models/call.model";
import { callRowLabel, type CallLabel } from "src/helper/call-row-label";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { TranslateModule } from "@ngx-translate/core";
import { isPending, type ThreadMessage } from "src/models/messenger.model";
import { PersonAvatarComponent } from "src/modules/shared/person-avatar/person-avatar.component";
import {
  AvatarStackComponent,
  type AvatarFace,
} from "src/modules/shared/avatar-stack/avatar-stack.component";

export interface ThreadRow {
  message: ThreadMessage;
  own: boolean;
  senderName: string;
  /** First of a run by the same sender. */
  startsRun: boolean;
  /** Last of a run: carries the avatar and, for own runs, the status tick. */
  endsRun: boolean;
  /**
   * A name above the bubble, for **group** conversations only. In a direct
   * thread the header already says who this is, so repeating it on every run
   * is noise.
   */
  showName: boolean;
  /**
   * Palette index (0-5) for this sender's name in a group.
   *
   * WhatsApp and Telegram both colour participant names, and it is the thing
   * that makes a busy group scannable — the eye tracks the colour, not the
   * text. Derived from the owner id, so a person keeps their colour across
   * reloads and devices rather than depending on who spoke first.
   */
  senderTone: number;
  /** Incoming avatar, rendered once per run beside the last bubble. */
  avatarUrl: string;
  /**
   * A ready-to-paint URL when this attachment is an image.
   *
   * Empty for everything else, and for a picture whose link has not resolved
   * yet — the bubble is the file card until it does.
   */
  previewUrl?: string;
  /**
   * Width ÷ height of the original, when the sender recorded it.
   *
   * Reserves the bubble's shape before the picture arrives, so the thread does
   * not jump as images resolve.
   */
  previewAspect?: number;
  /** ISO timestamp for a time separator above this row, or null for none. */
  separatorAt: string | null;
  /** Which day label the separator uses. */
  separatorDay: "today" | "yesterday" | "other";
  /**
   * Set when this row is a **call**, not a message.
   *
   * A call still carries a `message` — a synthetic anchor holding the call's id
   * and its start time — because the timeline is ordered and keyed by that, and
   * a second parallel list could not interleave by timestamp. Nothing of that
   * anchor is rendered: the template branches on this field first.
   */
  call?: CallRecord | null;
}

/** Someone who has read the newest own message. */
export interface SeenReader {
  ownerId: string;
  name: string;
  avatarUrl: string;
}

/**
 * One conversation: header, messages, and the composer.
 *
 * The composer lives here rather than on the page because a composer with no
 * thread to send to is the confusing state every mainstream messenger avoids.
 */
@Component({
  selector: "messenger-thread",
  imports: [
    TranslateModule,
    DatePipe,
    PersonAvatarComponent,
    AvatarStackComponent,
  ],
  templateUrl: "./thread.component.html",
  styleUrls: ["./thread.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "flex min-h-0 min-w-0 flex-1 flex-col",
    "[class.is-windowed]": "windowed()",
  },
})
export class ThreadComponent {
  readonly title = input.required<string>();
  /** Null for a group, which has no single presence to report. */
  readonly presence = input<"online" | "away" | "offline" | null>("offline");
  readonly rows = input.required<readonly ThreadRow[]>();
  readonly loading = input(false);
  readonly typists = input<readonly string[]>([]);
  /** Read state for the thread — empty unless our message is the newest. */
  readonly seenBy = input<readonly SeenReader[]>([]);
  readonly connected = input(false);
  /** Direct conversations only — group calling arrives with the SFU (phase 3). */
  readonly callable = input(false);
  /**
   * False on a device with no camera.
   *
   * Only changes the hover hint — the button stays **enabled**, because a
   * device without a camera can still place a video call and see the other
   * person. Meet, Zoom, Teams and Messenger all allow exactly that.
   */
  readonly videoCallable = input(true);
  /** The header's faces: the peer, or a group's members. */
  readonly faces = input<readonly AvatarFace[]>([]);
  /** Members in this group, or 0 for a direct thread — drives the subtitle. */
  readonly memberCount = input(0);
  /**
   * A call happening in this thread right now that we are **not** in.
   *
   * Null while nothing is live and while we are already in the call — the dock
   * is on screen then, and offering Join would be offering to join twice.
   */
  readonly ongoingCall = input<CallRecord | null>(null);
  /**
   * True when this thread is a docked mini window rather than the page.
   *
   * The same component either way — a window with its own header would fork
   * the title, the avatars, the presence dot, the group affordance and the
   * call buttons, five rules that would then drift apart. All this changes is
   * the chrome that is specific to each surface: the page's mobile back arrow,
   * and the window's minimise and close.
   */
  readonly windowed = input(false);

  readonly send = output<string>();
  readonly attach = output<File>();
  readonly open = output<ThreadRow>();
  /**
   * `true` while there is text to send, `false` the moment the box is emptied.
   * Emitting a bare "still typing" left the indicator up for the other person
   * after the draft was deleted (reported 2026-09-10).
   */
  readonly typing = output<boolean>();
  /** The composer took focus — the user is reading this thread. */
  readonly read = output<void>();
  readonly retry = output<string>();
  readonly back = output<void>();
  /** Windowed only: collapse to the title bar, keeping the thread open. */
  readonly minimise = output<void>();
  /** Windowed only: close the window and let go of the thread. */
  readonly closeWindow = output<void>();
  readonly call = output<CallMedia>();
  /** Join the call already happening here. Carries the row, not just its id:
   *  the invited set on it is what decides who this side connects to. */
  readonly joinCall = output<CallRecord>();
  /** Open the group's details: members, rename, add people, leave. */
  readonly details = output<void>();
  /** A picture would not load; the page mints a fresh link before giving up. */
  readonly previewExpired = output<ThreadRow>();

  /**
   * Pictures whose URL would not load twice over.
   *
   * The first failure is almost always an expired signed link, so it asks for
   * a fresh one; only a second failure gives up and shows the file card, which
   * is the order every mainstream client uses. Anything else would turn a
   * routine expiry into a permanently broken bubble.
   */
  private readonly brokenPreviews = signal<ReadonlySet<string>>(new Set());
  private readonly retriedPreviews = new Set<string>();

  /**
   * Shapes learned from the picture itself, for messages carrying no stored
   * dimensions — everything sent before the sender started recording them.
   *
   * With a shape the bubble sizes from a ratio and the box is exact. Without
   * one it falls back to intrinsic sizing of a replaced element inside a
   * shrink-to-fit box, which is where the alignment drifted (dathq,
   * 2026-09-11): the button kept its unconstrained width while the picture
   * inside it shrank against the height cap, leaving background where the
   * image was not.
   */
  private readonly measuredAspects = signal<ReadonlyMap<string, number>>(
    new Map(),
  );

  protected showsPreview(row: ThreadRow): boolean {
    return (
      Boolean(row.previewUrl) && !this.brokenPreviews().has(row.message.id)
    );
  }

  /** The sender's recorded shape, else the one measured when it loaded. */
  protected aspectFor(row: ThreadRow): number | null {
    return (
      row.previewAspect ?? this.measuredAspects().get(row.message.id) ?? null
    );
  }

  protected onPreviewLoad(row: ThreadRow, event: Event): void {
    const image = event.target as HTMLImageElement;
    const { naturalWidth, naturalHeight } = image;
    if (naturalWidth > 0 && naturalHeight > 0 && !row.previewAspect) {
      this.measuredAspects.update((current) =>
        new Map(current).set(row.message.id, naturalWidth / naturalHeight),
      );
    }

    // A picture that lands taller than the space it was given pushes the
    // newest message off screen — the thread stops being at the bottom without
    // the reader doing anything, which is why opening a chat full of images
    // left it scrolled up (dathq, 2026-09-11). Re-pin, but only for a reader
    // who was following along.
    if (!this.atBottom()) return;
    const element = this.scroller()?.nativeElement;
    if (!element) return;
    queueMicrotask(() => {
      element.scrollTop = element.scrollHeight;
    });
  }

  protected onPreviewError(row: ThreadRow): void {
    const id = row.message.id;
    if (!this.retriedPreviews.has(id)) {
      this.retriedPreviews.add(id);
      this.previewExpired.emit(row);
      return;
    }
    this.brokenPreviews.update((current) => new Set(current).add(id));
  }

  protected readonly draft = signal("");
  protected readonly canSend = computed(() => this.draft().trim().length > 0);

  private readonly scroller =
    viewChild<ElementRef<HTMLElement>>("messageScroller");
  private readonly composer =
    viewChild<ElementRef<HTMLTextAreaElement>>("composerInput");

  /** Bubble widths for the loading skeleton — irregular, so it reads as text. */
  protected readonly skeletonWidths = [8, 12, 6, 14, 9, 11];

  /** False once the reader has scrolled up into history. */
  protected readonly atBottom = signal(true);
  constructor() {
    // Follow the conversation, but only while the reader is *at* the bottom.
    // Pinning unconditionally yanks someone out of the history they scrolled
    // up to read the moment anybody sends anything — the behaviour every
    // mainstream client avoids with exactly this check.
    effect(() => {
      this.rows();
      const element = this.scroller()?.nativeElement;
      if (!element || !this.atBottom()) return;
      queueMicrotask(() => {
        element.scrollTop = element.scrollHeight;
      });
    });

    // A switched thread always starts at the bottom, whatever the last one did.
    effect(() => {
      this.title();
      this.atBottom.set(true);
    });
  }

  /**
   * Two names joined with a comma read as "A, B is typing…", which is both
   * wrong and the common case in a group. WhatsApp and Telegram both name one
   * or two people and collapse beyond that rather than growing the line.
   */
  protected readonly typingLabel = computed(() => {
    const names = this.typists();
    return names.length === 2 ? names.join(" & ") : (names[0] ?? "");
  });

  /** Within this many pixels of the end still counts as "following along". */
  private static readonly BOTTOM_SLACK_PX = 48;

  protected onScroll(event: Event): void {
    const element = event.target as HTMLElement;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    this.atBottom.set(distance <= ThreadComponent.BOTTOM_SLACK_PX);
  }

  protected jumpToLatest(): void {
    const element = this.scroller()?.nativeElement;
    if (!element) return;
    this.atBottom.set(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }

  protected onInput(event: Event): void {
    const element = event.target as HTMLTextAreaElement;
    this.draft.set(element.value);
    this.grow(element);
    this.typing.emit(this.draft().trim().length > 0);
  }

  /**
   * Grows the composer with its content up to the CSS max-height.
   * `rows="1"` with no growth meant a multi-line draft scrolled inside a
   * single line — the `max-h-32` on the element was unreachable.
   */
  private grow(element: HTMLTextAreaElement): void {
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }

  /** Enter sends, Shift+Enter breaks the line — the convention everywhere. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    this.submit();
  }

  protected submit(): void {
    const text = this.draft().trim();
    if (!text) return;
    this.send.emit(text);
    this.draft.set("");
    // Sending is always "follow the conversation" — and the box shrinks back.
    this.atBottom.set(true);
    const element = this.composer()?.nativeElement;
    if (element) {
      element.value = "";
      element.style.height = "auto";
    }
  }

  /** What this call row says. Shared with the conversation list's preview. */
  protected callLabel(record: CallRecord): CallLabel {
    return callRowLabel(record);
  }

  /**
   * How many people were actually on a group call.
   *
   * `joinedOwnerIds`, not `participantOwnerIds`: who was rung and who picked
   * up are different questions, and somebody who dropped out early was still
   * on the call. Zero for a row projected before phase 3, which carries no
   * participant rows at all — the row then reads exactly as it did before.
   */
  protected joinedCount(record: CallRecord): number {
    return record.joinedOwnerIds.length;
  }

  /** A call in a conversation of more than two people. */
  protected isGroupCall(record: CallRecord): boolean {
    return record.participantOwnerIds.length > 2;
  }

  protected isAttachment(row: ThreadRow): boolean {
    return row.message.kind === "attachment";
  }

  protected onPickFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Reset first: picking the same file twice in a row must still fire.
    input.value = "";
    if (file) this.attach.emit(file);
  }

  protected isPendingRow(row: ThreadRow): boolean {
    return isPending(row.message);
  }

  protected isFailedRow(row: ThreadRow): boolean {
    const message = row.message;
    return isPending(message) && message.failed;
  }
}
