import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import webpush from "web-push";
import type client from "prom-client";
import type { NotificationSeverity } from "../types/notifications";
import type { NotificationDto } from "./query";
import { getPreferences } from "./preferences";
import { listSubscriptions, pruneSubscription } from "./push-subscriptions";
import { config } from "../config";

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function vapidConfigured(): boolean {
  return Boolean(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);
}

let vapidInitialized = false;
function ensureVapid(): void {
  if (vapidInitialized) return;
  webpush.setVapidDetails(
    config.VAPID_SUBJECT,
    config.VAPID_PUBLIC_KEY,
    config.VAPID_PRIVATE_KEY,
  );
  vapidInitialized = true;
}

export interface PushDeps {
  db: Pool;
  log: FastifyBaseLogger;
  pushSent: client.Counter<"outcome">;
}

/**
 * Fire-and-forget Web Push fanout after a notification is inserted.
 * Never throws — push failure must not affect the JetStream ack path.
 * Payload carries i18n keys + params + the owner's locale; the shell
 * service worker fetches the translation catalog and renders client-side
 * (single source of truth stays in shell — platform/platform-notifications.md).
 */
export async function sendPush(
  deps: PushDeps,
  ownerId: string,
  notification: NotificationDto,
): Promise<void> {
  try {
    if (!vapidConfigured()) return;
    ensureVapid();

    const prefs = await getPreferences(deps.db, ownerId);
    if (!prefs.pushEnabled) return;
    if (
      SEVERITY_RANK[notification.severity] <
      SEVERITY_RANK[prefs.pushMinSeverity]
    )
      return;

    const subscriptions = await listSubscriptions(deps.db, ownerId);
    if (subscriptions.length === 0) return;

    const payload = JSON.stringify({
      id: notification.id,
      type: notification.type,
      severity: notification.severity,
      titleKey: notification.titleKey,
      bodyKey: notification.bodyKey,
      params: notification.params,
      link: notification.link,
      locale: prefs.locale,
    });

    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            payload,
          );
          deps.pushSent.inc({ outcome: "sent" });
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            // Push service says the subscription is gone — self-clean.
            await pruneSubscription(deps.db, sub.endpoint);
            deps.pushSent.inc({ outcome: "pruned" });
            return;
          }
          deps.log.error(
            { err, endpoint: sub.endpoint },
            "web push send failed",
          );
          deps.pushSent.inc({ outcome: "failed" });
        }
      }),
    );
  } catch (err) {
    deps.log.error({ err, ownerId }, "web push fanout failed");
  }
}
