-- Per-owner notification preferences (phase 3 wave 0).
-- Absent row = defaults; the in-app channel is never gated by preferences.
CREATE TABLE IF NOT EXISTS notification_preferences (
  owner_id TEXT PRIMARY KEY,
  locale TEXT NOT NULL DEFAULT 'en',
  push_enabled BOOLEAN NOT NULL DEFAULT false,
  push_min_severity TEXT NOT NULL DEFAULT 'info',
  email_digest BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
