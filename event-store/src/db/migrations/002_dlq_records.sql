CREATE TABLE IF NOT EXISTS dlq_records (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject            TEXT NOT NULL,
  sink               TEXT NOT NULL,
  jetstream_stream   TEXT NOT NULL DEFAULT 'DLQ',
  jetstream_sequence BIGINT NOT NULL,
  original_subject   TEXT NOT NULL,
  owner_id           TEXT,
  correlation_id     TEXT,
  last_error         TEXT NOT NULL,
  failed_at          TIMESTAMPTZ NOT NULL,
  payload            JSONB,
  envelope           JSONB,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dlq_records_stream_seq_uidx
  ON dlq_records (jetstream_stream, jetstream_sequence);

CREATE INDEX IF NOT EXISTS dlq_records_owner_id_idx ON dlq_records (owner_id);
CREATE INDEX IF NOT EXISTS dlq_records_correlation_id_idx ON dlq_records (correlation_id);
CREATE INDEX IF NOT EXISTS dlq_records_sink_idx ON dlq_records (sink);
CREATE INDEX IF NOT EXISTS dlq_records_failed_at_idx ON dlq_records (failed_at DESC);
