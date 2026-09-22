import type { Page } from "@playwright/test";

/**
 * Notification stubs shared by the bell/drawer and preferences specs, plus a
 * recorder so a spec can assert on the request it caused. No backend is
 * required or contacted.
 *
 * Registration order matters: Playwright gives the last matching handler
 * priority, so the catch-all tripwire goes first and the specific routes after
 * the generic list route.
 */

export interface NotificationFixture {
  id: string;
  type: string;
  severity: string;
  sourceService: string;
  titleKey: string;
  bodyKey: string;
  params: Record<string, unknown>;
  link: string | null;
  correlationId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreferences {
  locale: string;
  pushEnabled: boolean;
  pushMinSeverity: string;
  emailDigest: boolean;
}

export interface NotificationMockOptions {
  notifications?: NotificationFixture[];
  /** What `unread-count` resyncs to — the server counts a pushed row already. */
  unreadCount?: number;
  /** Push one SSE frame on the first stream connection. */
  pushEvent?: boolean;
  preferences?: Partial<NotificationPreferences>;
}

export interface NotificationRecorder {
  /** Bodies of every `PUT /preferences`, in call order. */
  putBodies: unknown[];
  /** URLs that reached the tripwire — a non-empty list means a missing stub. */
  unmocked: string[];
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  locale: "en",
  pushEnabled: false,
  pushMinSeverity: "info",
  emailDigest: false,
};

export const NOTIFICATION: NotificationFixture = {
  id: "e2e-noti-1",
  type: "file.cleanup",
  severity: "info",
  sourceService: "file-service",
  titleKey: "NOTIFICATIONS.FILE_CLEANUP.TITLE",
  bodyKey: "NOTIFICATIONS.FILE_CLEANUP.BODY",
  params: {},
  link: null,
  correlationId: null,
  readAt: null,
  createdAt: new Date().toISOString(),
};

export const OLDER_UNREAD: NotificationFixture = {
  ...NOTIFICATION,
  id: "e2e-noti-2",
  createdAt: "2026-01-01T00:00:00.000Z",
};

export async function mockNotificationApi(
  page: Page,
  options: NotificationMockOptions = {},
): Promise<NotificationRecorder> {
  const notifications = options.notifications ?? [NOTIFICATION, OLDER_UNREAD];
  const unreadCount = options.unreadCount ?? 1;
  const pushEvent = options.pushEvent ?? false;
  const preferences = { ...DEFAULT_PREFERENCES, ...options.preferences };

  const recorder: NotificationRecorder = { putBodies: [], unmocked: [] };
  let streamServed = false;

  // Tripwire, registered first so every real stub outranks it. Without it a
  // missing stub reaches the real gateway on :8080, which 401s the seeded JWT
  // and pops the global error dialog — a failure that looks nothing like its
  // cause.
  await page.route("**/api/**", async (route) => {
    recorder.unmocked.push(route.request().url());
    await route.fulfill({
      status: 599,
      json: { error: "unmocked request", url: route.request().url() },
    });
  });

  // The messenger header widget lives in this header too, and it starts its
  // socket and loads conversations as soon as it mounts. Those requests are
  // not what these specs are about, but they are real traffic — stubbed here
  // so a spec is hermetic whether or not the remote happens to be running.
  await page.routeWebSocket(/\/api\/realtime\/ws/, () => {});
  await page.route("**/api/realtime/token*", async (route) => {
    await route.fulfill({
      json: { stream_token: "e2e-token", expires_in: 90 },
    });
  });
  await page.route("**/api/messenger/**", async (route) => {
    if (route.request().url().includes("/unread")) {
      await route.fulfill({ json: { data: { conversation_ids: [] } } });
      return;
    }
    await route.fulfill({ json: { data: [], meta: { next_cursor: null } } });
  });
  await page.route("**/api/accounts/**", async (route) => {
    await route.fulfill({ json: { data: [] } });
  });

  // Generic list route first — the specific routes below take precedence.
  await page.route("**/api/notifications**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { data: notifications } });
      return;
    }
    // read / unread / read-all actions
    await route.fulfill({ status: 204, body: "" });
  });

  await page.route("**/api/notifications/unread-count**", (route) =>
    route.fulfill({ json: { count: unreadCount } }),
  );

  await page.route("**/api/notifications/preferences**", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      recorder.putBodies.push(body);
      await route.fulfill({ json: body });
      return;
    }
    await route.fulfill({ json: preferences });
  });

  // The first mint always succeeds, even with no event to push: the bell
  // resyncs its unread count on a successful connect, so 401-ing straight away
  // would leave the badge at zero and look like a broken count.
  await page.route("**/api/notifications/stream-token**", (route) => {
    if (streamServed) {
      // Park the client in reconnect backoff — keeps counts deterministic.
      return route.fulfill({ status: 401, json: { error: "expired" } });
    }
    return route.fulfill({ json: { stream_token: "e2e-stream-token" } });
  });

  // Regex, not glob — a glob's `?` wildcard would also match "stream-token".
  await page.route(/\/api\/notifications\/stream\?stream_token=/, (route) => {
    streamServed = true;
    const push = pushEvent
      ? `event: notification\ndata: ${JSON.stringify(NOTIFICATION)}\n\n`
      : "";
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `retry: 5000\n\n${push}`,
    });
  });

  return recorder;
}
