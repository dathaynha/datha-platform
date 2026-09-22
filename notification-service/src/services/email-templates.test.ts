import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalogModule from "../lib/shell-catalog";
import {
  formatRelativeTime,
  renderDigestEmail,
  type DigestData,
} from "./email-templates";

vi.mock("../lib/shell-catalog");

const translate = vi.mocked(catalogModule.translate);

const COPY: Record<string, string> = {
  "NOTIFICATIONS.EMAIL_DIGEST.SUBJECT": "Daily digest — {{count}} unread",
  "NOTIFICATIONS.EMAIL_DIGEST.SUBJECT_ONE":
    "Daily digest — 1 unread notification",
  "NOTIFICATIONS.EMAIL_DIGEST.HEADING": "Your daily digest",
  "NOTIFICATIONS.EMAIL_DIGEST.INTRO":
    "You have {{count}} unread notifications.",
  "NOTIFICATIONS.EMAIL_DIGEST.INTRO_ONE": "You have 1 unread notification.",
  "NOTIFICATIONS.EMAIL_DIGEST.LATEST": "Latest unread",
  "NOTIFICATIONS.EMAIL_DIGEST.MORE":
    "…and {{count}} more unread notifications.",
  "NOTIFICATIONS.EMAIL_DIGEST.MORE_ONE": "…and 1 more unread notification.",
  "NOTIFICATIONS.EMAIL_DIGEST.OPEN": "Open notifications",
  "NOTIFICATIONS.EMAIL_DIGEST.FOOTER":
    "You receive this because the digest is enabled.",
  "NOTIFICATIONS.SEVERITY.INFO": "Info",
  "NOTIFICATIONS.SEVERITY.WARNING": "Warning",
  "NOTIFICATIONS.SEVERITY.CRITICAL": "Critical",
  "NOTIFICATIONS.DLQ_ARRIVAL.TITLE": "Background task failed (<script>)",
  "NOTIFICATIONS.DLQ_ARRIVAL.BODY": "A background task could not be completed.",
};

const DATA: DigestData = {
  unreadCount: 3,
  severityCounts: { critical: 1, info: 2 },
  items: [
    {
      titleKey: "NOTIFICATIONS.DLQ_ARRIVAL.TITLE",
      bodyKey: "NOTIFICATIONS.DLQ_ARRIVAL.BODY",
      params: {},
      severity: "critical",
      createdAt: new Date(Date.now() - 2 * 3_600_000),
    },
  ],
  shellUrl: "http://localhost:4000",
};

describe("renderDigestEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    translate.mockImplementation(async (_locale, key, params) => {
      const template = COPY[key];
      if (!template) return key;
      return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) =>
        params?.[name] == null ? m : String(params[name]),
      );
    });
  });

  it("returns null when the catalog is unavailable (subject unresolved)", async () => {
    translate.mockImplementation(async (_locale, key) => key);
    expect(await renderDigestEmail("de", DATA)).toBeNull();
  });

  it("renders subject, severity counts, items with bodies and timestamps, and the link", async () => {
    const rendered = await renderDigestEmail("en", DATA);
    expect(rendered).not.toBeNull();
    expect(rendered!.subject).toBe("Daily digest — 3 unread");
    expect(rendered!.text).toContain("Critical: 1 · Info: 2");
    expect(rendered!.text).toContain(
      "- [Critical] Background task failed (<script>) (2 hours ago)",
    );
    expect(rendered!.text).toContain(
      "A background task could not be completed.",
    );
    expect(rendered!.text).toContain(
      "Open notifications: http://localhost:4000",
    );
    expect(rendered!.html).toContain("DatHa Platform");
    expect(rendered!.html).toContain("2 hours ago");
    expect(rendered!.html).toContain(
      "A background task could not be completed.",
    );
  });

  it('adds the "and N more" line when unread exceeds the listed items', async () => {
    const rendered = await renderDigestEmail("en", DATA); // 3 unread, 1 listed
    expect(rendered!.text).toContain("…and 2 more unread notifications.");
    expect(rendered!.html).toContain("…and 2 more unread notifications.");
  });

  it('omits the "and N more" line when everything unread is listed', async () => {
    const rendered = await renderDigestEmail("en", { ...DATA, unreadCount: 1 });
    expect(rendered!.text).not.toContain("more unread");
    expect(rendered!.html).not.toContain("more unread");
  });

  it("escapes HTML in rendered titles", async () => {
    const rendered = await renderDigestEmail("en", DATA);
    expect(rendered!.html).not.toContain("(<script>)");
    expect(rendered!.html).toContain("&lt;script&gt;");
  });

  it("uses the singular key pair when exactly one notification is unread", async () => {
    const rendered = await renderDigestEmail("en", { ...DATA, unreadCount: 1 });
    expect(rendered!.subject).toBe("Daily digest — 1 unread notification");
    expect(rendered!.text).toContain("You have 1 unread notification.");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-08-04T12:00:00Z");

  it("formats hours and days in the given locale", () => {
    expect(
      formatRelativeTime("en", new Date("2026-08-04T10:00:00Z"), now),
    ).toBe("2 hours ago");
    expect(
      formatRelativeTime("de", new Date("2026-08-03T12:00:00Z"), now),
    ).toBe("gestern");
  });

  it("falls back to minutes granularity for fresh items and en for bad locales", () => {
    expect(
      formatRelativeTime("en", new Date("2026-08-04T11:59:40Z"), now),
    ).toBe("this minute");
    expect(
      formatRelativeTime("nope!!", new Date("2026-08-04T10:00:00Z"), now),
    ).toBe("2 hours ago");
  });
});
