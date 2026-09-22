-- Product that created the upload (chatbot reconcile only deletes origin = 'chatbot').
-- Do NOT backfill here — run a manual UPDATE only when you have verified legacy rows are chatbot-only.
ALTER TABLE files ADD COLUMN IF NOT EXISTS origin TEXT;

ALTER TABLE files ALTER COLUMN origin SET DEFAULT 'chatbot';

CREATE INDEX IF NOT EXISTS files_owner_origin_idx ON files (owner_id, origin)
  WHERE deleted_at IS NULL;
