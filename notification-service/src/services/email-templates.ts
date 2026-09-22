import { translate } from "../lib/shell-catalog";
import type { NotificationSeverity } from "../types/notifications";

const KEYS = {
  subject: "NOTIFICATIONS.EMAIL_DIGEST.SUBJECT",
  subjectOne: "NOTIFICATIONS.EMAIL_DIGEST.SUBJECT_ONE",
  heading: "NOTIFICATIONS.EMAIL_DIGEST.HEADING",
  intro: "NOTIFICATIONS.EMAIL_DIGEST.INTRO",
  introOne: "NOTIFICATIONS.EMAIL_DIGEST.INTRO_ONE",
  latest: "NOTIFICATIONS.EMAIL_DIGEST.LATEST",
  more: "NOTIFICATIONS.EMAIL_DIGEST.MORE",
  moreOne: "NOTIFICATIONS.EMAIL_DIGEST.MORE_ONE",
  open: "NOTIFICATIONS.EMAIL_DIGEST.OPEN",
  footer: "NOTIFICATIONS.EMAIL_DIGEST.FOOTER",
} as const;

const SEVERITY_LABEL_KEYS: Record<NotificationSeverity, string> = {
  info: "NOTIFICATIONS.SEVERITY.INFO",
  warning: "NOTIFICATIONS.SEVERITY.WARNING",
  critical: "NOTIFICATIONS.SEVERITY.CRITICAL",
};

/* Email clients get fixed hex, never CSS vars — brand indigo + severity tints. */
const BRAND_COLOR = "#6366f1";
const SEVERITY_COLORS: Record<
  NotificationSeverity,
  { text: string; bg: string }
> = {
  info: { text: "#6366f1", bg: "#eef2ff" },
  warning: { text: "#d97706", bg: "#fef3c7" },
  critical: { text: "#dc2626", bg: "#fee2e2" },
};

export interface DigestItem {
  titleKey: string;
  bodyKey: string;
  params: Record<string, unknown>;
  severity: NotificationSeverity;
  createdAt: Date;
}

export interface DigestData {
  unreadCount: number;
  severityCounts: Partial<Record<NotificationSeverity, number>>;
  items: DigestItem[];
  shellUrl: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "2 hours ago" / "vor 2 Stunden" — Intl handles locale plurals natively. */
export function formatRelativeTime(
  locale: string,
  date: Date,
  now: Date = new Date(),
): string {
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  } catch {
    rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  }
  const diffMs = date.getTime() - now.getTime();
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(diffMs) >= ms)
      return rtf.format(Math.round(diffMs / ms), unit);
  }
  return rtf.format(0, "minute");
}

/**
 * Render the daily digest with the owner's locale. All copy — email chrome and
 * notification titles/bodies — comes from the shell i18n catalog (single source
 * of truth). Returns null when the catalog is unavailable: the caller skips
 * this sweep and retries, so an email of raw keys is never sent.
 *
 * Deliberately a light, inline-styled teaser (not the app's glass theme, not
 * full content): email clients can't render the theme, and the digest's job
 * is to pull the owner into the shell.
 */
export async function renderDigestEmail(
  locale: string,
  data: DigestData,
): Promise<RenderedEmail | null> {
  const params = { count: data.unreadCount };
  // Simple singular/plural key pairs — our interpolation has no ICU plurals.
  const subjectKey = data.unreadCount === 1 ? KEYS.subjectOne : KEYS.subject;
  const introKey = data.unreadCount === 1 ? KEYS.introOne : KEYS.intro;
  const subject = await translate(locale, subjectKey, params);
  if (subject === subjectKey) return null;

  const [heading, intro, latest, open, footer] = await Promise.all([
    translate(locale, KEYS.heading, params),
    translate(locale, introKey, params),
    translate(locale, KEYS.latest, params),
    translate(locale, KEYS.open, params),
    translate(locale, KEYS.footer, params),
  ]);

  const severities: NotificationSeverity[] = ["critical", "warning", "info"];
  const countParts = await Promise.all(
    severities
      .filter((s) => (data.severityCounts[s] ?? 0) > 0)
      .map(async (s) => ({
        severity: s,
        label: await translate(locale, SEVERITY_LABEL_KEYS[s]),
        count: data.severityCounts[s] ?? 0,
      })),
  );

  const items = await Promise.all(
    data.items.map(async (item) => ({
      title: await translate(locale, item.titleKey, item.params),
      body: await translate(locale, item.bodyKey, item.params),
      label: await translate(locale, SEVERITY_LABEL_KEYS[item.severity]),
      severity: item.severity,
      when: formatRelativeTime(locale, item.createdAt),
    })),
  );

  const moreCount = data.unreadCount - data.items.length;
  const more =
    moreCount > 0
      ? await translate(locale, moreCount === 1 ? KEYS.moreOne : KEYS.more, {
          count: moreCount,
        })
      : "";

  const text = [
    "DatHa Platform",
    "",
    heading,
    "",
    intro,
    countParts.map((p) => `${p.label}: ${p.count}`).join(" · "),
    "",
    `${latest}:`,
    ...items.map((i) => `- [${i.label}] ${i.title} (${i.when})\n  ${i.body}`),
    ...(more ? [more] : []),
    "",
    `${open}: ${data.shellUrl}`,
    "",
    footer,
  ].join("\n");

  const html = `
<div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1f2937; background: #ffffff;">
  <div style="padding-bottom: 12px; margin-bottom: 20px; border-bottom: 1px solid #e5e7eb;">
    <span style="color: ${BRAND_COLOR}; font-weight: 700; font-size: 14px; letter-spacing: 0.02em;">DatHa Platform</span>
  </div>
  <h1 style="font-size: 20px; margin: 0 0 8px;">${escapeHtml(heading)}</h1>
  <p style="margin: 0 0 16px;">${escapeHtml(intro)}</p>
  <p style="margin: 0 0 20px;">
    ${countParts
      .map(
        (p) =>
          `<span style="display: inline-block; margin-right: 8px; padding: 3px 12px; border-radius: 999px; background: ${SEVERITY_COLORS[p.severity].bg}; color: ${SEVERITY_COLORS[p.severity].text}; font-weight: 600; font-size: 12px;">${escapeHtml(p.label)}: ${p.count}</span>`,
      )
      .join("")}
  </p>
  <h2 style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin: 0 0 10px;">${escapeHtml(latest)}</h2>
  <ul style="list-style: none; padding: 0; margin: 0 0 8px;">
    ${items
      .map(
        (
          i,
        ) => `<li style="padding: 10px 14px; margin-bottom: 8px; border-left: 3px solid ${SEVERITY_COLORS[i.severity].text}; background: #f9fafb; border-radius: 4px;">
      <div style="margin-bottom: 2px;">
        <span style="font-size: 11px; text-transform: uppercase; color: ${SEVERITY_COLORS[i.severity].text}; font-weight: 700;">${escapeHtml(i.label)}</span>
        <span style="font-size: 12px; color: #9ca3af;"> · ${escapeHtml(i.when)}</span>
      </div>
      <div style="font-weight: 600; margin-bottom: 2px;">${escapeHtml(i.title)}</div>
      <div style="font-size: 13px; color: #6b7280;">${escapeHtml(i.body)}</div>
    </li>`,
      )
      .join("\n    ")}
  </ul>
  ${more ? `<p style="margin: 0 0 20px; font-size: 13px; color: #6b7280;">${escapeHtml(more)}</p>` : ""}
  <a href="${escapeHtml(data.shellUrl)}" style="display: inline-block; background: ${BRAND_COLOR}; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; margin-top: 4px;">${escapeHtml(open)}</a>
  <p style="margin: 24px 0 0; font-size: 12px; color: #9ca3af;">${escapeHtml(footer)}</p>
</div>`;

  return { subject, text, html };
}
