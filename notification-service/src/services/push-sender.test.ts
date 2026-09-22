import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { Counter } from "prom-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import * as preferencesModule from "./preferences";
import * as subscriptionsModule from "./push-subscriptions";
import type { NotificationDto } from "./query";
import { sendPush } from "./push-sender";

vi.mock("web-push");
vi.mock("./preferences");
vi.mock("./push-subscriptions");
vi.mock("../config", () => ({
  config: {
    VAPID_PUBLIC_KEY: "test-public",
    VAPID_PRIVATE_KEY: "test-private",
    VAPID_SUBJECT: "mailto:test@example.com",
  },
}));

const getPreferences = vi.mocked(preferencesModule.getPreferences);
const listSubscriptions = vi.mocked(subscriptionsModule.listSubscriptions);
const pruneSubscription = vi.mocked(subscriptionsModule.pruneSubscription);
const sendNotification = vi.mocked(webpush.sendNotification);

const NOTIFICATION: NotificationDto = {
  id: "n1",
  type: "file.cleanup",
  severity: "info",
  sourceService: "file-service",
  titleKey: "NOTIFICATIONS.FILE_CLEANUP.TITLE",
  bodyKey: "NOTIFICATIONS.FILE_CLEANUP.BODY",
  params: { file_id: "f1" },
  link: null,
  correlationId: null,
  readAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const SUBSCRIPTION = {
  id: "s1",
  owner_id: "google_owner",
  endpoint: "https://push.example/abc",
  p256dh: "p",
  auth: "a",
};

function deps() {
  return {
    db: {} as Pool,
    log: { error: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger,
    pushSent: { inc: vi.fn() } as unknown as Counter<"outcome">,
  };
}

function prefs(
  overrides: Partial<preferencesModule.NotificationPreferences> = {},
) {
  return {
    locale: "de",
    pushEnabled: true,
    pushMinSeverity: "info" as const,
    emailDigest: false,
    email: "",
    ...overrides,
  };
}

describe("sendPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPreferences.mockResolvedValue(prefs());
    listSubscriptions.mockResolvedValue([SUBSCRIPTION]);
    sendNotification.mockResolvedValue({} as never);
  });

  it("skips when push is disabled in preferences", async () => {
    getPreferences.mockResolvedValue(prefs({ pushEnabled: false }));
    await sendPush(deps(), "google_owner", NOTIFICATION);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("respects the severity floor", async () => {
    getPreferences.mockResolvedValue(prefs({ pushMinSeverity: "warning" }));
    await sendPush(deps(), "google_owner", NOTIFICATION); // info < warning
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("sends i18n keys + params + locale to every subscription", async () => {
    listSubscriptions.mockResolvedValue([
      SUBSCRIPTION,
      { ...SUBSCRIPTION, id: "s2", endpoint: "https://push.example/def" },
    ]);
    const d = deps();
    await sendPush(d, "google_owner", NOTIFICATION);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    const [target, payload] = sendNotification.mock.calls[0];
    expect(target).toEqual({
      endpoint: "https://push.example/abc",
      keys: { p256dh: "p", auth: "a" },
    });
    expect(JSON.parse(payload as string)).toMatchObject({
      titleKey: "NOTIFICATIONS.FILE_CLEANUP.TITLE",
      params: { file_id: "f1" },
      locale: "de",
    });
    expect(d.pushSent.inc).toHaveBeenCalledWith({ outcome: "sent" });
  });

  it("prunes the subscription when the push service returns 410", async () => {
    sendNotification.mockRejectedValue(
      Object.assign(new Error("gone"), { statusCode: 410 }),
    );
    const d = deps();
    await sendPush(d, "google_owner", NOTIFICATION);

    expect(pruneSubscription).toHaveBeenCalledWith(
      expect.anything(),
      "https://push.example/abc",
    );
    expect(d.pushSent.inc).toHaveBeenCalledWith({ outcome: "pruned" });
  });

  it("logs and counts non-prune failures without throwing", async () => {
    sendNotification.mockRejectedValue(
      Object.assign(new Error("boom"), { statusCode: 500 }),
    );
    const d = deps();
    await sendPush(d, "google_owner", NOTIFICATION);

    expect(pruneSubscription).not.toHaveBeenCalled();
    expect(d.pushSent.inc).toHaveBeenCalledWith({ outcome: "failed" });
  });
});
