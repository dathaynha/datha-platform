import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import nodemailer, { type Transporter } from "nodemailer";
import type client from "prom-client";
import { config } from "../config";
import type { NotificationSeverity } from "../types/notifications";
import { renderDigestEmail, type DigestItem } from "./email-templates";

const DIGEST_TOP_N = 5;

export function smtpConfigured(): boolean {
  return Boolean(config.SMTP_HOST);
}

let transporter: Transporter | null = null;
function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER
        ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
        : undefined,
    });
  }
  return transporter;
}

export interface DigestDeps {
  db: Pool;
  log: FastifyBaseLogger;
  emailsSent: client.Counter<"outcome">;
}

interface DigestCandidate {
  owner_id: string;
  email: string;
  locale: string;
}

/**
 * Owners due a digest: digest enabled, ≥ the interval since the last one
 * (never sent counts as due), and at least one unread notification created
 * since the last send. Empty digests are never sent by construction.
 */
async function findCandidates(db: Pool): Promise<DigestCandidate[]> {
  const result = await db.query<DigestCandidate>(
    `SELECT p.owner_id, p.email, p.locale
     FROM notification_preferences p
     LEFT JOIN digest_state s ON s.owner_id = p.owner_id
     WHERE p.email_digest
       AND (s.last_sent_at IS NULL OR s.last_sent_at < now() - ($1 * interval '1 hour'))
       AND EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.owner_id = p.owner_id
           AND n.read_at IS NULL
           AND (s.last_sent_at IS NULL OR n.created_at > s.last_sent_at)
       )`,
    [config.NOTIFICATIONS_DIGEST_MIN_INTERVAL_HOURS],
  );
  return result.rows;
}

interface UnreadStats {
  unreadCount: number;
  severityCounts: Partial<Record<NotificationSeverity, number>>;
  items: DigestItem[];
}

async function unreadStats(db: Pool, ownerId: string): Promise<UnreadStats> {
  const [counts, top] = await Promise.all([
    db.query<{ severity: NotificationSeverity; count: string }>(
      `SELECT severity, count(*) AS count FROM notifications
       WHERE owner_id = $1 AND read_at IS NULL GROUP BY severity`,
      [ownerId],
    ),
    db.query<{
      title_key: string;
      body_key: string;
      params: Record<string, unknown>;
      severity: NotificationSeverity;
      created_at: Date;
    }>(
      `SELECT title_key, body_key, params, severity, created_at FROM notifications
       WHERE owner_id = $1 AND read_at IS NULL
       ORDER BY created_at DESC LIMIT $2`,
      [ownerId, DIGEST_TOP_N],
    ),
  ]);

  const severityCounts: Partial<Record<NotificationSeverity, number>> = {};
  let unreadCount = 0;
  for (const row of counts.rows) {
    severityCounts[row.severity] = Number(row.count);
    unreadCount += Number(row.count);
  }

  return {
    unreadCount,
    severityCounts,
    items: top.rows.map((row) => ({
      titleKey: row.title_key,
      bodyKey: row.body_key,
      params: row.params,
      severity: row.severity,
      createdAt: row.created_at,
    })),
  };
}

async function stampSent(db: Pool, ownerId: string): Promise<void> {
  await db.query(
    `INSERT INTO digest_state (owner_id, last_sent_at) VALUES ($1, now())
     ON CONFLICT (owner_id) DO UPDATE SET last_sent_at = now()`,
    [ownerId],
  );
}

/**
 * One sweep pass — called hourly by the email-digest plugin. Never throws.
 * Failures never stamp digest_state, so the next sweep retries; skipped
 * owners (no email captured / catalog unreachable) likewise retry.
 */
export async function sweepDigests(deps: DigestDeps): Promise<void> {
  try {
    if (!smtpConfigured()) return;

    const candidates = await findCandidates(deps.db);
    for (const candidate of candidates) {
      try {
        if (!candidate.email) {
          deps.log.warn(
            { ownerId: candidate.owner_id },
            "digest enabled but no email captured yet — will retry after next preferences save",
          );
          deps.emailsSent.inc({ outcome: "skipped_no_email" });
          continue;
        }

        const stats = await unreadStats(deps.db, candidate.owner_id);
        if (stats.unreadCount === 0) continue;

        const rendered = await renderDigestEmail(candidate.locale, {
          ...stats,
          shellUrl: config.SHELL_PUBLIC_URL,
        });
        if (!rendered) {
          deps.log.warn(
            { ownerId: candidate.owner_id, locale: candidate.locale },
            "digest skipped — shell i18n catalog unreachable, retrying next sweep",
          );
          deps.emailsSent.inc({ outcome: "skipped_no_catalog" });
          continue;
        }

        await getTransporter().sendMail({
          from: config.SMTP_FROM,
          to: candidate.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        });
        await stampSent(deps.db, candidate.owner_id);
        deps.emailsSent.inc({ outcome: "sent" });
        deps.log.info(
          { ownerId: candidate.owner_id, unread: stats.unreadCount },
          "digest email sent",
        );
      } catch (err) {
        deps.log.error(
          { err, ownerId: candidate.owner_id },
          "digest email send failed",
        );
        deps.emailsSent.inc({ outcome: "failed" });
      }
    }
  } catch (err) {
    deps.log.error({ err }, "digest sweep failed");
  }
}

/** Test hook — resets the transporter singleton between tests. */
export function resetTransporter(): void {
  transporter = null;
}
