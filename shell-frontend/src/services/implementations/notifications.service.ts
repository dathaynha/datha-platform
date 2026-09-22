import { HttpClient, HttpContext, HttpParams } from "@angular/common/http";
import { Injectable, inject, signal } from "@angular/core";
import { Subject, firstValueFrom } from "rxjs";
import { SKIP_GLOBAL_ERROR_DIALOG } from "src/interceptors/http-context.tokens";
import type {
  NotificationListResponse,
  NotificationStreamTokenResponse,
  PlatformNotification,
  UnreadCountResponse,
} from "@models/index";
import { environment } from "src/environments/environment";

const PAGE_SIZE = 20;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Notification drawer state for the shell toolbar. Live SSE push (phase 2,
 * platform/platform-notifications.md): mint a stream_token from the gateway,
 * open an EventSource, prepend pushed notifications. Reconnects with backoff
 * and a fresh token — EventSource's built-in retry would reuse the expired one.
 * Background calls are silent; user actions are optimistic and roll back on
 * failure, and list-load failures surface an error state in the drawer.
 */
@Injectable({ providedIn: "root" })
export class NotificationsService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.gateway.baseUrl}/api/notifications`;
  private readonly silentContext = new HttpContext().set(
    SKIP_GLOBAL_ERROR_DIALOG,
    true,
  );

  private readonly pushedSubject = new Subject<PlatformNotification>();
  /** Notifications arriving over SSE — consumed by the bell for toasts. */
  readonly pushed$ = this.pushedSubject.asObservable();

  readonly unreadCount = signal(0);
  readonly notifications = signal<PlatformNotification[]>([]);
  readonly unreadOnly = signal(false);
  readonly hasMore = signal(false);
  readonly loading = signal(false);
  readonly loadError = signal(false);

  private eventSource: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private connected = false;

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    void this.openStream();
  }

  disconnect(): void {
    this.connected = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.eventSource?.close();
    this.eventSource = null;
  }

  private async openStream(): Promise<void> {
    if (!this.connected || this.eventSource) return;

    let token: string;
    try {
      const res = await firstValueFrom(
        this.http.get<NotificationStreamTokenResponse>(
          `${this.baseUrl}/stream-token`,
          { context: this.silentContext },
        ),
      );
      token = res.stream_token;
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (!this.connected) return;

    const source = new EventSource(
      `${this.baseUrl}/stream?stream_token=${encodeURIComponent(token)}`,
    );
    this.eventSource = source;

    source.onopen = () => {
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      // Resync — notifications pushed while disconnected are not replayed.
      void this.refreshUnreadCount();
    };
    source.addEventListener("notification", (event) => {
      this.onStreamNotification(event as MessageEvent<string>);
    });
    source.onerror = () => {
      source.close();
      if (this.eventSource === source) this.eventSource = null;
      this.scheduleReconnect();
    };
  }

  private onStreamNotification(event: MessageEvent<string>): void {
    let notification: PlatformNotification;
    try {
      notification = JSON.parse(event.data) as PlatformNotification;
    } catch {
      return;
    }
    // Duplicate push (e.g. a concurrent list load already delivered the row):
    // skip entirely — no count bump, no prepend, no toast.
    if (this.notifications().some((n) => n.id === notification.id)) return;

    this.unreadCount.update((c) => c + 1);
    this.notifications.update((list) => [notification, ...list]);
    this.pushedSubject.next(notification);
  }

  private scheduleReconnect(): void {
    if (!this.connected || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openStream();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      RECONNECT_MAX_MS,
    );
  }

  async refreshUnreadCount(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<UnreadCountResponse>(`${this.baseUrl}/unread-count`, {
          context: this.silentContext,
        }),
      );
      this.unreadCount.set(res.count);
    } catch {
      // Background poll — keep the last known count.
    }
  }

  /** Load the first page (replaces the list). */
  async loadNotifications(): Promise<void> {
    await this.fetchPage(null);
  }

  /** Cursor pagination — appends the page before the oldest loaded row. */
  async loadMore(): Promise<void> {
    const oldest = this.notifications().at(-1);
    if (!oldest) return;
    await this.fetchPage(oldest.createdAt);
  }

  async setUnreadOnly(value: boolean): Promise<void> {
    if (this.unreadOnly() === value) return;
    this.unreadOnly.set(value);
    await this.loadNotifications();
  }

  private async fetchPage(before: string | null): Promise<void> {
    this.loading.set(true);
    try {
      let params = new HttpParams().set("limit", PAGE_SIZE);
      if (this.unreadOnly()) params = params.set("unread", "true");
      if (before) params = params.set("before", before);

      const res = await firstValueFrom(
        this.http.get<NotificationListResponse>(this.baseUrl, {
          params,
          context: this.silentContext,
        }),
      );
      this.notifications.update((list) =>
        before ? [...list, ...res.data] : res.data,
      );
      this.hasMore.set(res.data.length === PAGE_SIZE);
      this.loadError.set(false);
    } catch {
      // Don't keep stale rows around pretending everything is fine.
      if (!before) this.notifications.set([]);
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  async markRead(id: string): Promise<void> {
    await this.setReadState(id, true);
  }

  async markUnread(id: string): Promise<void> {
    await this.setReadState(id, false);
  }

  private async setReadState(id: string, read: boolean): Promise<void> {
    const previousList = this.notifications();
    const previousCount = this.unreadCount();

    // Optimistic: apply immediately, roll back if the API rejects.
    const readAt = read ? new Date().toISOString() : null;
    this.notifications.update((list) =>
      read && this.unreadOnly()
        ? list.filter((n) => n.id !== id)
        : list.map((n) => (n.id === id ? { ...n, readAt } : n)),
    );
    this.unreadCount.update((c) => Math.max(0, c + (read ? -1 : 1)));

    try {
      await firstValueFrom(
        this.http.post<void>(
          `${this.baseUrl}/${id}/${read ? "read" : "unread"}`,
          null,
          { context: this.silentContext },
        ),
      );
    } catch {
      this.notifications.set(previousList);
      this.unreadCount.set(previousCount);
      this.loadError.set(true);
    }
  }

  async markAllRead(): Promise<void> {
    const previousList = this.notifications();
    const previousCount = this.unreadCount();

    const readAt = new Date().toISOString();
    this.notifications.update((list) =>
      this.unreadOnly()
        ? []
        : list.map((n) => (n.readAt ? n : { ...n, readAt })),
    );
    this.unreadCount.set(0);

    try {
      await firstValueFrom(
        this.http.post<{ updated: number }>(`${this.baseUrl}/read-all`, null, {
          context: this.silentContext,
        }),
      );
    } catch {
      this.notifications.set(previousList);
      this.unreadCount.set(previousCount);
      this.loadError.set(true);
    }
  }
}
