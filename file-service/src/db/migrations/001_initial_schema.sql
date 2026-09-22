CREATE TABLE IF NOT EXISTS files (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       TEXT NOT NULL,
  name           TEXT NOT NULL,
  mime_type      TEXT,
  size_bytes     BIGINT,
  blob_path      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'deleted')),
  correlation_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS files_owner_id_idx   ON files (owner_id);
CREATE INDEX IF NOT EXISTS files_status_idx     ON files (status);
CREATE INDEX IF NOT EXISTS files_created_at_idx ON files (created_at DESC);
