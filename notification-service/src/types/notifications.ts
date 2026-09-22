export type NotificationSeverity = "info" | "warning" | "critical";

export interface PreferencesRow {
  owner_id: string;
  locale: string;
  push_enabled: boolean;
  push_min_severity: NotificationSeverity;
  email_digest: boolean;
  /** Digest recipient — snapshotted from X-User-Email on save; '' = not captured yet. */
  email: string;
  updated_at: Date;
}

export interface NotificationRow {
  id: string;
  owner_id: string;
  type: string;
  severity: NotificationSeverity;
  source_service: string;
  title_key: string;
  body_key: string;
  params: Record<string, unknown>;
  /** In-app route the notification points at (shell-side navigation target). */
  link: string | null;
  correlation_id: string | null;
  read_at: Date | null;
  created_at: Date;
}
