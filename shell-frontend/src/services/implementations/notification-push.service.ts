import { HttpClient, HttpContext } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { SKIP_GLOBAL_ERROR_DIALOG } from "src/interceptors/http-context.tokens";
import { environment } from "src/environments/environment";

/**
 * Web Push subscription lifecycle (phase 3 wave 1). The service worker is
 * registered at bootstrap; this service owns permission + PushManager
 * subscribe/unsubscribe and mirrors the subscription to notification-service.
 */
@Injectable({ providedIn: "root" })
export class NotificationPushService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.gateway.baseUrl}/api/notifications/push-subscriptions`;
  private readonly silentContext = new HttpContext().set(
    SKIP_GLOBAL_ERROR_DIALOG,
    true,
  );

  get supported(): boolean {
    return (
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  }

  /** Request permission + subscribe + register server-side. */
  async enable(): Promise<
    "granted" | "denied" | "dismissed" | "unsupported" | "error"
  > {
    if (!this.supported) return "unsupported";

    // Already denied = the browser will NOT show a prompt again — the user
    // must unblock in the site settings. Detect it before requesting.
    if (Notification.permission === "denied") return "denied";

    const permission = await Notification.requestPermission();
    if (permission === "denied") return "denied";
    if (permission !== "granted") return "dismissed"; // prompt closed without a choice

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this.vapidKeyBytes(),
        }));

      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.["p256dh"] || !json.keys?.["auth"]) {
        return "error";
      }

      await firstValueFrom(
        this.http.post<void>(
          this.url,
          {
            endpoint: json.endpoint,
            keys: { p256dh: json.keys["p256dh"], auth: json.keys["auth"] },
            userAgent: navigator.userAgent,
          },
          { context: this.silentContext },
        ),
      );
      return "granted";
    } catch (err) {
      console.error("web push subscription failed", err);
      return "error";
    }
  }

  /** Unsubscribe the browser and remove the server-side registration. */
  async disable(): Promise<void> {
    if (!this.supported) return;

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;

    // Server first: if the DELETE fails the browser subscription survives,
    // so a retry can still clean up. (Reverse order would orphan the server
    // row until the 410-prune on a later send.)
    await firstValueFrom(
      this.http.delete<void>(this.url, {
        body: { endpoint: subscription.endpoint },
        context: this.silentContext,
      }),
    );
    await subscription.unsubscribe();
  }

  private vapidKeyBytes(): Uint8Array<ArrayBuffer> {
    const base64 = (environment.push.vapidPublicKey as string)
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const raw = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }
}
