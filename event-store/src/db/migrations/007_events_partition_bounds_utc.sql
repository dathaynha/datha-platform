-- Partition bounds must not depend on the session's TimeZone.
--
-- `CREATE TABLE ... FOR VALUES FROM ('2027-05-01')` parses that literal in the
-- **session** TimeZone, and `events.timestamp` is `timestamptz`. So the same
-- statement produced different partitions depending on who ran it. Measured on
-- a clone, 2026-09-20:
--
--   session TZ UTC                 -> events_y2027m05 covers 05-01 00:00+00 ...
--   session TZ Asia/Ho_Chi_Minh    -> events_y2027m03 covers 02-28 17:00+00 ...
--   session TZ America/New_York    -> events_y2027m05 covers 05-01 04:00+00 ...
--
-- Two things break. The partition name stops describing its contents — the
-- Ho Chi Minh one holds the last seven hours of February. And retention derives
-- a partition's upper bound from its **name** (`expiredEventPartitions` in
-- `services/retention.ts`), so at a negative offset the real bound is *later*
-- than the name implies and the drop takes rows that have not expired: silent
-- data loss, in a job that runs daily and reports success.
--
-- This machine's server is UTC, so the partitions already created are correct;
-- the bug was latent, waiting for a container, a managed instance or a psql
-- session with a different TimeZone. The check at the bottom is what makes that
-- assumption stop being an assumption.

-- Bounds built as explicit UTC text, never as a bare date the session reparses.
CREATE OR REPLACE FUNCTION events_ensure_partition(month_start DATE)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  part_name   TEXT := format('events_y%sm%s',
                             to_char(month_start, 'YYYY'),
                             to_char(month_start, 'MM'));
  lower_bound TEXT := to_char(month_start, 'YYYY-MM-DD') || ' 00:00:00+00';
  upper_bound TEXT := to_char((month_start + INTERVAL '1 month')::date,
                              'YYYY-MM-DD') || ' 00:00:00+00';
BEGIN
  IF to_regclass(part_name) IS NOT NULL THEN
    RETURN;
  END IF;
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
    part_name, lower_bound, upper_bound
  );
END;
$$;

-- The month window is UTC too: `now()` in a session an hour before midnight on
-- the 1st, at a positive offset, is already the next month locally and would
-- skip creating the month that is about to receive rows.
--
-- `now() AT TIME ZONE 'UTC'` yields a plain `timestamp`, which also makes the
-- `generate_series` overload exact rather than resolved through the preferred
-- type — the arguments now match one candidate with no implicit cast at all.
CREATE OR REPLACE FUNCTION events_ensure_partitions(months_ahead INT DEFAULT 3)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  m DATE;
  first_month TIMESTAMP := date_trunc('month', now() AT TIME ZONE 'UTC');
BEGIN
  FOR m IN
    SELECT generate_series(
      first_month,
      first_month + make_interval(months => months_ahead),
      INTERVAL '1 month'
    )::date
  LOOP
    PERFORM events_ensure_partition(m);
  END LOOP;
END;
$$;

-- Fail loudly if this database already holds a partition whose real bounds
-- disagree with its name. Repairing one means detaching it and moving rows,
-- which is not something a migration should do silently to data it has never
-- seen — so this stops and says which one, rather than guessing.
DO $$
DECLARE
  bad TEXT;
BEGIN
  SET LOCAL TimeZone = 'UTC';
  SELECT string_agg(c.relname || ' ' || pg_get_expr(c.relpartbound, c.oid), '; ')
    INTO bad
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  WHERE p.relname = 'events'
    AND c.relname ~ '^events_y[0-9]{4}m[0-9]{2}$'
    AND pg_get_expr(c.relpartbound, c.oid) <> format(
      'FOR VALUES FROM (%L) TO (%L)',
      substr(c.relname, 9, 4) || '-' || substr(c.relname, 14, 2)
        || '-01 00:00:00+00',
      to_char(
        ((substr(c.relname, 9, 4) || '-' || substr(c.relname, 14, 2) || '-01')
          ::date + INTERVAL '1 month')::date,
        'YYYY-MM-DD'
      ) || ' 00:00:00+00'
    );

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'events partitions were created under a non-UTC TimeZone and their bounds do not match their names: %. Detach, move the rows into the correctly-named partition, and re-run.', bad;
  END IF;
END;
$$;
