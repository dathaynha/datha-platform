CREATE TABLE IF NOT EXISTS notifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Idempotency key: envelope id for EVENTS, "dlq:<stream sequence>" for DLQ arrivals.
  source_key     TEXT NOT NULL UNIQUE,
  owner_id       TEXT NOT NULL,
  type           TEXT NOT NULL,
  title_key      TEXT NOT NULL,
  body_key       TEXT NOT NULL,
  params         JSONB NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  read_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_owner_list_idx
  ON notifications (owner_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_correlation_id_idx
  ON notifications (correlation_id);
