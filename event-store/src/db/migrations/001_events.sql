CREATE TABLE IF NOT EXISTS events (
  id             UUID PRIMARY KEY,
  type           TEXT NOT NULL,
  service        TEXT NOT NULL,
  entity_id      TEXT,
  owner_id       TEXT,
  correlation_id TEXT,
  timestamp      TIMESTAMPTZ NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS events_type_idx ON events (type);
CREATE INDEX IF NOT EXISTS events_entity_id_idx ON events (entity_id);
CREATE INDEX IF NOT EXISTS events_owner_id_idx ON events (owner_id);
CREATE INDEX IF NOT EXISTS events_correlation_id_idx ON events (correlation_id);
CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events (timestamp DESC);
