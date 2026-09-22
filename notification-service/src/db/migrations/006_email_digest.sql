-- Email digest (phase 3 wave 2).
-- email is snapshotted from the gateway-injected X-User-Email on every
-- preferences save ('' until the owner saves once after this migration).
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';

-- One row per owner who has ever received a digest; absent row = never sent.
CREATE TABLE IF NOT EXISTS digest_state (
  owner_id TEXT PRIMARY KEY,
  last_sent_at TIMESTAMPTZ NOT NULL
);
