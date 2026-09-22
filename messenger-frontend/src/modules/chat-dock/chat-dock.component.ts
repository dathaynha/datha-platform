import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
} from "@angular/core";
import { ChatDockService } from "@services/implementations/chat-dock.service";
import { ChatStore } from "@services/implementations/chat-store.service";
import { WebrtcCallService } from "@services/implementations/webrtc-call.service";
import { ChatWindowComponent } from "./chat-window.component";

/**
 * The strip of docked mini chat windows — phase 3 slice 4.
 *
 * Mounted by the same two hosts as the call dock (the shell's header widget
 * when hosted, the authenticated layout when standalone) for the same reason:
 * a window inside /messenger's routes would be destroyed the moment the user
 * navigated to /chatbot, which is precisely when a docked chat is worth having.
 *
 * Like the call dock it re-parents itself to `body`, because the shell's
 * toolbar uses `backdrop-filter` and that creates a containing block for
 * `position: fixed` — a fixed element rendered from inside the header would be
 * anchored to the header rather than to the viewport. Done in
 * `afterNextRender` and never in the constructor: Angular has not decided where
 * the host element goes until after the first render, so a constructor that
 * moves it is silently undone by the first control-flow mount (2026-09-15).
 */
@Component({
  selector: "messenger-chat-dock",
  imports: [ChatWindowComponent],
  templateUrl: "./chat-dock.component.html",
  styleUrls: ["./chat-dock.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatDockComponent {
  /** `/chats` standalone, `/messenger/chats` when the shell hosts this remote. */
  readonly chatsLink = input<readonly string[]>(["/chats"]);

  private readonly dock = inject(ChatDockService);
  private readonly store = inject(ChatStore);
  private readonly calls = inject(WebrtcCallService);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * The windows worth drawing.
   *
   * A window for the thread the chats page is already showing full-size is
   * dropped rather than closed: the conversation is on screen twice otherwise,
   * once in a 20rem box on top of itself. Navigating away brings it back,
   * which is the behaviour Messenger has on its own messages page.
   */
  protected readonly windows = computed(() => {
    const active = this.store.activeConversationId();
    return this.dock
      .windows()
      .filter((window) => window.conversationId !== active);
  });

  /**
   * True while the call dock occupies the bottom-right corner.
   *
   * An incoming ring is excluded because that one is centred over a backdrop,
   * not docked — reserving the corner for it would leave a hole. The expanded
   * call stage needs no exclusion: it draws a scrim above this strip's
   * z-index, so the windows are covered rather than displaced.
   */
  protected readonly callDocked = computed(() => {
    const call = this.calls.call();
    if (!call) return false;
    return !(call.state === "ringing" && call.direction === "incoming");
  });

  constructor() {
    afterNextRender(() => {
      const element = this.host.nativeElement;
      document.body.appendChild(element);
      this.destroyRef.onDestroy(() => element.remove());
    });
  }
}
