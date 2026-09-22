-- Deep paging past the count cap walks a keyset, not an OFFSET, and a keyset
-- needs a total order: `timestamp` alone has ties, and two rows that compare
-- equal can be skipped or repeated as the cursor steps over them.
--
-- `(timestamp DESC, id DESC)` replaces the timestamp-only index rather than
-- joining it. A composite index serves its own leading column, so every query
-- that used `events_timestamp_idx` still has one — this is strictly more
-- useful, not one more thing to maintain.
DROP INDEX IF EXISTS events_timestamp_idx;
CREATE INDEX IF NOT EXISTS events_timestamp_id_idx ON events (timestamp DESC, id DESC);
