import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  DestroyRef,
  inject,
  viewChild,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { Router } from "@angular/router";
import {
  TranslateModule,
  TranslateService,
  TranslateStore,
} from "@ngx-translate/core";
import { conversationPreview } from "src/helper/conversation-preview";
import {
  registerRemoteTranslations,
  type DathaTranslationTree,
} from "@datha/platform-ui";
import { ButtonModule } from "primeng/button";
import { Popover, PopoverModule } from "primeng/popover";
import { BadgeModule } from "primeng/badge";
import { REMOTE_TRANSLATION_BUNDLES } from "src/i18n/remote-translation-bundles";
import { CallDockComponent } from "src/modules/call-dock/call-dock.component";
import { ChatDockComponent } from "src/modules/chat-dock/chat-dock.component";
import { ChatDockService } from "src/services/implementations/chat-dock.service";
import { ChatStore } from "src/services/implementations/chat-store.service";
import { RealtimeService } from "src/services/implementations/realtime.service";

/** Below this width the icon navigates straight to /messenger, popover-free. */
const NARROW_VIEWPORT_PX = 640;

/** PrimeNG's design token for the popover arrow's horizontal position. */
/** Recent conversations shown in the popover; the rest live in the full page. */
const POPOVER_ROWS = 20;

/**
 * The messenger icon the shell renders in its header, exposed to Module
 * Federation as "./HeaderWidget".
 *
 * Loaded outside this remote's routes, so AppModule and MessengerRemoteEntryModule
 * have both never run: the widget registers its own MESSENGER.* catalog, and
 * must keep working with nothing else of this remote mounted.
 *
 * Starting the socket here rather than in a route is deliberate: the widget is
 * mounted from login onward, so the badge is live on every page instead of only
 * after a visit to /messenger.
 *
 * It hosts the **call dock** for the same reason, and that reason is stronger:
 * a dock inside /messenger's routes would be destroyed the moment the user
 * navigated to /chatbot, taking the RTCPeerConnection and the call with it.
 * Mounted here, the call survives every navigation — the phase-2 exit
 * criterion. The dock renders nothing when there is no call.
 *
 * The popover lists **conversations only**. A people section would mean a
 * second data source, a second presence subscription for users you are not
 * talking to, and a second empty state, all inside a 320px panel — directory
 * search lives in the full page, where there is room. Search here filters the
 * already-loaded list client-side: no endpoint, no debounce, no race.
 */
@Component({
  selector: "messenger-header-widget",
  imports: [
    TranslateModule,
    ButtonModule,
    PopoverModule,
    BadgeModule,
    CallDockComponent,
    ChatDockComponent,
  ],
  styleUrls: ["./header-widget.component.scss"],
  templateUrl: "./header-widget.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HeaderWidgetComponent {
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly realtime = inject(RealtimeService);
  private readonly chats = inject(ChatStore);
  private readonly dock = inject(ChatDockService);

  /** "" when nothing is unread, else the count capped at 9+. */
  readonly unreadBadge = this.realtime.unreadBadge;

  /** The recent conversations, newest first — the store already sorts them. */
  protected readonly rows = computed(() =>
    this.chats
      .conversations()
      .slice(0, POPOVER_ROWS)
      .map((conversation) => ({
        id: conversation.id,
        title: this.chats.conversationTitle(conversation),
        // The same derivation the chats list uses. This used to be
        // `lastMessage?.body`, which showed a blank line for a picture, no
        // speaker in a group, and nothing at all for a call.
        preview: conversationPreview(conversation, {
          selfOwnerId: this.chats.currentOwnerId(),
          displayName: (ownerId) => this.chats.displayName(ownerId),
          translate: (key, params) => this.translate.instant(key, params),
        }),
        unread: conversation.unread,
        presence:
          this.realtime.presence().get(this.chats.counterpart(conversation))
            ?.state ?? "offline",
      })),
  );

  private readonly popover = viewChild.required<Popover>("messengerPopover");
  private readonly trigger =
    viewChild.required<ElementRef<HTMLElement>>("messengerTrigger");

  /** Languages already merged — also the re-entrancy guard, see registerLanguage. */
  private readonly registered = new Set<string>();

  constructor(
    private readonly translate: TranslateService,
    private readonly store: TranslateStore,
  ) {
    this.registerLanguage(
      translate.currentLang || translate.defaultLang || "en",
    );
    translate.onLangChange
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ lang }) => this.registerLanguage(lang));

    // Idempotent — a second tab, or a re-mount, reuses the same socket.
    this.realtime.start();
    // The widget is mounted from login, so the popover has its rows before it
    // is ever opened, and the list is warm when /messenger is first visited.
    void this.chats.loadConversations();
  }

  /**
   * Re-centres the popover arrow on the trigger.
   *
   * PrimeNG positions it from the target's **left** edge
   * (`arrowLeft = target.left - container.left - 2 * borderRadius`), which only
   * lines up when the panel is left-aligned to the target. This trigger sits at
   * the right of the header, so the panel is right-aligned against the viewport
   * and the arrow lands ~34px to the left of the icon (reported 2026-09-10).
   *
   * Writes PrimeNG's own `popover.arrow.left` token rather than overriding the
   * arrow in CSS, and measures the theme's additional offset instead of
   * assuming it, so a theme change cannot silently un-centre it again.
   */
  /**
   * Centres the panel on the trigger.
   *
   * Was `centreArrow`, which moved the tail to point at the icon. Platform
   * menus have no tail since `@datha/platform-ui` v0.6.0 — Apple draws one on
   * a popover, not on a pull-down button's menu — so there is nothing left to
   * point, and a tail here beside a tail-less theme menu was the visible
   * inconsistency (dathq, 2026-09-17).
   *
   * `offsetWidth`, not a bounding rect: `onShow` fires while the panel is
   * still scaling in, and a rect read mid-animation is ~12px off its resting
   * position — the same trap the arrow maths documented.
   */
  protected centrePanel(): void {
    const panel = (this.popover() as { container?: HTMLElement }).container;
    if (!panel) return;

    const anchor = this.trigger().nativeElement.getBoundingClientRect();
    const width = panel.offsetWidth;
    if (width === 0) return;

    const centre = anchor.left + window.scrollX + anchor.width / 2;
    const rightLimit = window.scrollX + document.documentElement.clientWidth;
    const left = Math.max(
      window.scrollX + 8,
      Math.min(centre - width / 2, rightLimit - width - 8),
    );
    panel.style.left = `${left}px`;
  }

  /**
   * Picking a conversation docks it, rather than navigating away.
   *
   * This is the whole point of phase 3 slice 4: the widget is reachable from
   * every page of the platform, and taking someone to /messenger to answer one
   * message costs them whatever they were doing. Facebook, Google Chat and
   * Teams all open a window from the header for the same reason. "See all"
   * below the list is still the way into the full product.
   *
   * Below the narrow breakpoint the popover never opens — the trigger
   * navigates — so there is no path here that could dock a window on a screen
   * too small to show one.
   */
  openConversation(conversationId: string): void {
    this.popover().hide();
    this.dock.openWindow(conversationId);
  }

  onTriggerClick(event: Event): void {
    if (window.innerWidth < NARROW_VIEWPORT_PX) {
      void this.openMessenger();
      return;
    }
    // Anchor explicitly to the trigger wrapper. p-button re-emits the DOM click
    // after dispatch has finished, so `currentTarget` is already null by the
    // time PrimeNG reads it and the arrow lands ~44px off the icon.
    this.popover().toggle(event, this.trigger().nativeElement);
  }

  async openMessenger(): Promise<void> {
    this.popover().hide();
    await this.router.navigate(["/messenger"]);
  }

  /**
   * Register MESSENGER.* for one language, and only once the shell is already
   * on it.
   *
   * Two rules the routed entry does not need, both learned the hard way:
   *
   * 1. **Only the active language.** Writing a catalog for a language the shell
   *    has not fetched yet marks it loaded, and ngx-translate then skips the
   *    shell's own lazy fetch — the shell loses every key it has not registered
   *    (the home page went blank in German).
   * 2. **Only the MESSENGER subtree.** The widget renders inside shell pages,
   *    so replacing shared subtrees (PROFILE, THEME, DIALOG, errors) with this
   *    remote's copies would rewrite chrome the shell owns.
   */
  private registerLanguage(lang: string): void {
    if (this.registered.has(lang)) {
      return;
    }
    const bundle = REMOTE_TRANSLATION_BUNDLES[lang];
    const messenger = bundle?.["MESSENGER"] as DathaTranslationTree | undefined;
    if (!messenger) {
      return;
    }
    // Marked before the call, not after: registerRemoteTranslations ends with
    // translate.use(currentLang), which re-emits onLangChange straight back
    // into this method. Without the guard that recurses until the stack blows.
    this.registered.add(lang);
    registerRemoteTranslations(this.translate, this.store, {
      [lang]: { MESSENGER: messenger },
    });
  }
}
