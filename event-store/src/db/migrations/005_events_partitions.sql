-- Monthly range partitioning for `events`, with the retention job dropping
-- whole partitions instead of scanning for rows to delete.
--
-- Why: `retain.ts` deleted by `timestamp < cutoff`, which reads and writes every
-- expired row, leaves the table needing a vacuum, and gets slower exactly as the
-- table gets bigger. `DROP TABLE events_y2026m05` is O(1) and returns the disk
-- immediately. Ops queries are keyed on `timestamp` too, so partition pruning
-- makes the common "last N days" scan touch one or two partitions.
--
-- The cost, recorded because it is not reversible by accident: a unique index on
-- a partitioned table MUST contain the partition key, so the primary key becomes
-- `(id, timestamp)` rather than `(id)`. Ingest's `ON CONFLICT` target moves with
-- it. Dedupe stays correct because every path that re-publishes an event sends
-- the stored envelope verbatim — DLQ replay included — so the timestamp is the
-- same one the first insert used. A publisher that reuses an event id with a
-- *different* timestamp would now get two rows; that was already a bug, and it
-- is now a bug with a visible symptom.

-- Idempotent creation of one month's partition.
CREATE OR REPLACE FUNCTION events_ensure_partition(month_start DATE)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  part_name TEXT := format('events_y%sm%s',
                           to_char(month_start, 'YYYY'),
                           to_char(month_start, 'MM'));
BEGIN
  IF to_regclass(part_name) IS NOT NULL THEN
    RETURN;
  END IF;
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
    part_name,
    month_start,
    month_start + INTERVAL '1 month'
  );
END;
$$;

-- The current month plus `months_ahead` more. Called from the service on boot
-- and from the retention job, because a partition that does not exist when a
-- row arrives is an ingest failure, and the process most likely to be down is
-- the one you were relying on to create it.
CREATE OR REPLACE FUNCTION events_ensure_partitions(months_ahead INT DEFAULT 3)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  m DATE;
BEGIN
  FOR m IN
    SELECT generate_series(
      date_trunc('month', now())::date,
      (date_trunc('month', now()) + make_interval(months => months_ahead))::date,
      '1 month'
    )::date
  LOOP
    PERFORM events_ensure_partition(m);
  END LOOP;
END;
$$;

-- A rename carries the table's indexes with it under their existing names, so
-- every one has to move aside before the new table claims it.
ALTER TABLE events RENAME TO events_unpartitioned;
ALTER INDEX events_pkey RENAME TO events_unpartitioned_pkey;
ALTER INDEX events_type_idx RENAME TO events_unpartitioned_type_idx;
ALTER INDEX events_service_idx RENAME TO events_unpartitioned_service_idx;
ALTER INDEX events_entity_id_idx RENAME TO events_unpartitioned_entity_id_idx;
ALTER INDEX events_owner_id_idx RENAME TO events_unpartitioned_owner_id_idx;
ALTER INDEX events_correlation_id_idx RENAME TO events_unpartitioned_correlation_id_idx;
ALTER INDEX events_timestamp_idx RENAME TO events_unpartitioned_timestamp_idx;

CREATE TABLE events (
  id             UUID NOT NULL,
  type           TEXT NOT NULL,
  service        TEXT NOT NULL,
  entity_id      TEXT,
  owner_id       TEXT,
  correlation_id TEXT,
  timestamp      TIMESTAMPTZ NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, timestamp)
) PARTITION BY RANGE (timestamp);

-- Declared on the parent, so every partition made later inherits them.
CREATE INDEX events_type_idx ON events (type);
CREATE INDEX events_service_idx ON events (service);
CREATE INDEX events_entity_id_idx ON events (entity_id);
CREATE INDEX events_owner_id_idx ON events (owner_id);
CREATE INDEX events_correlation_id_idx ON events (correlation_id);
CREATE INDEX events_timestamp_idx ON events (timestamp DESC);

-- A safety net, not a place rows are meant to live. DLQ replay re-publishes an
-- envelope with its ORIGINAL timestamp, so replaying something older than the
-- oldest surviving partition has nowhere else to go — and losing it to an
-- ingest error would be worse than parking it here. Anything that accumulates
-- in this partition is a signal to look, not normal operation.
CREATE TABLE events_default PARTITION OF events DEFAULT;

-- Partitions for the data already on disk, then the forward window.
DO $$
DECLARE
  m DATE;
BEGIN
  FOR m IN
    SELECT DISTINCT date_trunc('month', timestamp)::date
    FROM events_unpartitioned
    ORDER BY 1
  LOOP
    PERFORM events_ensure_partition(m);
  END LOOP;
END;
$$;

SELECT events_ensure_partitions(3);

INSERT INTO events (id, type, service, entity_id, owner_id, correlation_id, timestamp, payload)
SELECT id, type, service, entity_id, owner_id, correlation_id, timestamp, payload
FROM events_unpartitioned;

DROP TABLE events_unpartitioned;
