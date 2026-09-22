import { inject, Injectable, signal } from "@angular/core";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import { ChatStore } from "./chat-store.service";

/**
 * How many conversations can be docked at once.
 *
 * Three 20rem windows plus their gaps is about 66rem, which fits a laptop
 * beside the call dock and leaves the page behind them usable. It is also what
 * keeps a reconnect inside realtime-service's budget: `conversation.open` draws
 * on the tighter of the two token buckets (burst 5, refilling at 0.5/s), and a
 * reconnect re-sends one frame per remembered thread — three windows plus the
 * chats page's own open thread is four.
 */
export const MAX_DOCKED_WINDOWS = 3;

export interface DockWindow {
  conversationId: string;
  /** Collapsed to its title bar, but still open and still subscribed. */
  minimised: boolean;
}

/** What is persisted: enough to put the same windows back, nothing more. */
interface StoredWindow {
  id: string;
  min: boolean;
}

/**
 * The docked mini chat windows — phase 3 slice 4.
 *
 * A service rather than state inside the strip, for the same reason the call
 * dock's state lives in `WebrtcCallService`: the thing that *opens* a window is
 * the shell's header widget, which is a different component tree from the
 * overlay host that renders it, and on a different page entirely.
 *
 * Each open window is a holder on its conversation's socket subscription
 * (`ChatStore.openThread`), so a window keeps receiving messages and typing
 * indicators while the page navigates anywhere else. Refcounted in the store,
 * which is what lets the chats page and a window show the same thread without
 * either one unsubscribing the other.
 */
@Injectable({ providedIn: "root" })
export class ChatDockService {
  private readonly store = inject(ChatStore);

  private readonly open = signal<readonly DockWindow[]>([]);

  /** Oldest first, which is the order they are laid out in. */
  readonly windows = this.open.asReadonly();

  constructor() {
    this.restore();
  }

  /**
   * Where this user's windows are persisted.
   *
   * Scoped by owner id, and that is not cosmetic: `clearAuthData` on logout
   * removes the session keys and knows nothing about this one, so a single
   * shared key meant the **next person to sign in on this browser** had the
   * previous person's conversations restored into their dock. Every fetch
   * would then be refused and the windows would render blank, which is a
   * confusing way to find out. Keying by owner means a different user simply
   * has no entry, and the first user's list survives for when they come back.
   */
  private storageKey(): string {
    this.store.syncOwnerId();
    return `${LOCAL_STORAGE_KEY.CHAT_DOCK}:${this.store.currentOwnerId()}`;
  }

  /** The holder key a window uses on the store's subscription refcount. */
  private static holderFor(conversationId: string): string {
    return `dock:${conversationId}`;
  }

  /**
   * Opens a conversation in a window, or un-minimises the one already open.
   *
   * Opening past the cap closes the oldest: a fourth window would not fit, and
   * silently refusing to open the one that was just asked for is worse than
   * dropping the one nobody has touched in a while.
   */
  openWindow(conversationId: string): void {
    const existing = this.open().find(
      (window) => window.conversationId === conversationId,
    );
    if (existing) {
      if (existing.minimised) this.setMinimised(conversationId, false);
      return;
    }

    const evicted = this.open().slice(
      0,
      Math.max(0, this.open().length + 1 - MAX_DOCKED_WINDOWS),
    );
    for (const window of evicted) this.closeWindow(window.conversationId);

    this.open.update((windows) => [
      ...windows,
      { conversationId, minimised: false },
    ]);
    void this.store.openThread(
      conversationId,
      ChatDockService.holderFor(conversationId),
    );
    this.persist();
  }

  closeWindow(conversationId: string): void {
    if (!this.open().some((w) => w.conversationId === conversationId)) return;
    this.open.update((windows) =>
      windows.filter((window) => window.conversationId !== conversationId),
    );
    this.store.closeThread(
      conversationId,
      ChatDockService.holderFor(conversationId),
    );
    this.persist();
  }

  /**
   * Collapses a window to its title bar, or restores it.
   *
   * The thread stays **open**: a minimised window still counts as a holder, so
   * its unread badge is live and expanding it shows the messages that arrived
   * meanwhile rather than a spinner.
   */
  setMinimised(conversationId: string, minimised: boolean): void {
    this.open.update((windows) =>
      windows.map((window) =>
        window.conversationId === conversationId
          ? { ...window, minimised }
          : window,
      ),
    );
    if (!minimised) this.store.markRead(conversationId);
    this.persist();
  }

  private persist(): void {
    try {
      const stored: StoredWindow[] = this.open().map((window) => ({
        id: window.conversationId,
        min: window.minimised,
      }));
      localStorage.setItem(this.storageKey(), JSON.stringify(stored));
    } catch {
      // A private window, or storage the browser has blocked. The windows are
      // still on screen; they just will not come back after a reload.
    }
  }

  /**
   * Puts back the windows that were open before a reload.
   *
   * Restored without asking the store for anything yet — `openThread` runs per
   * window below — and every read is guarded, because storage can be blocked,
   * cleared, or hold something written by a different version of this code.
   */
  private restore(): void {
    let stored: StoredWindow[] = [];
    try {
      const raw = localStorage.getItem(this.storageKey());
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        stored = parsed
          .filter(
            (entry): entry is StoredWindow =>
              typeof entry === "object" &&
              entry !== null &&
              typeof (entry as StoredWindow).id === "string",
          )
          .slice(-MAX_DOCKED_WINDOWS);
      }
    } catch {
      return;
    }

    if (stored.length === 0) return;
    this.open.set(
      stored.map((entry) => ({
        conversationId: entry.id,
        minimised: Boolean(entry.min),
      })),
    );
    for (const entry of stored) {
      void this.store.openThread(entry.id, ChatDockService.holderFor(entry.id));
    }
  }
}
