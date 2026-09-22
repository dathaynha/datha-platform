ALTER TABLE dlq_records
  ADD COLUMN IF NOT EXISTS replayed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS dlq_records_replayed_at_idx ON dlq_records (replayed_at);
