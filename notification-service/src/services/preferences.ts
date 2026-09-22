import type { Pool } from "pg";
import type {
  NotificationSeverity,
  PreferencesRow,
} from "../types/notifications";

export interface NotificationPreferences {
  locale: string;
  pushEnabled: boolean;
  pushMinSeverity: NotificationSeverity;
  emailDigest: boolean;
  /** Digest recipient — captured server-side from X-User-Email, never client-supplied. */
  email: string;
}

/** Absent row = these defaults; a row is only written on first PUT. */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  locale: "en",
  pushEnabled: false,
  pushMinSeverity: "info",
  emailDigest: false,
  email: "",
};

function rowToPreferences(row: PreferencesRow): NotificationPreferences {
  return {
    locale: row.locale,
    pushEnabled: row.push_enabled,
    pushMinSeverity: row.push_min_severity,
    emailDigest: row.email_digest,
    email: row.email,
  };
}

export async function getPreferences(
  db: Pool,
  ownerId: string,
): Promise<NotificationPreferences> {
  const result = await db.query<PreferencesRow>(
    `SELECT owner_id, locale, push_enabled, push_min_severity, email_digest, email, updated_at
     FROM notification_preferences WHERE owner_id = $1`,
    [ownerId],
  );
  const row = result.rows[0];
  return row ? rowToPreferences(row) : DEFAULT_PREFERENCES;
}

export interface PreferencesInput {
  locale: string;
  pushEnabled: boolean;
  pushMinSeverity: NotificationSeverity;
  emailDigest: boolean;
}

export async function upsertPreferences(
  db: Pool,
  ownerId: string,
  preferences: PreferencesInput,
  /** From X-User-Email; '' never overwrites a previously captured address. */
  email: string,
): Promise<NotificationPreferences> {
  const result = await db.query<PreferencesRow>(
    `INSERT INTO notification_preferences (owner_id, locale, push_enabled, push_min_severity, email_digest, email, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (owner_id) DO UPDATE SET
       locale = EXCLUDED.locale,
       push_enabled = EXCLUDED.push_enabled,
       push_min_severity = EXCLUDED.push_min_severity,
       email_digest = EXCLUDED.email_digest,
       email = COALESCE(NULLIF(EXCLUDED.email, ''), notification_preferences.email),
       updated_at = now()
     RETURNING owner_id, locale, push_enabled, push_min_severity, email_digest, email, updated_at`,
    [
      ownerId,
      preferences.locale,
      preferences.pushEnabled,
      preferences.pushMinSeverity,
      preferences.emailDigest,
      email,
    ],
  );
  return rowToPreferences(result.rows[0]);
}
