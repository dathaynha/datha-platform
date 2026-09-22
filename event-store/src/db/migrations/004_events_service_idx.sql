-- `service` is a filter column with no index: every distinct-values lookup and
-- every `service = ANY(...)` filter read the whole table without it.
--
-- It also carries the distinct-values endpoint. Postgres 16 has no index skip
-- scan, so `SELECT DISTINCT service` reads every index entry; the recursive
-- form in `services/query.ts` walks this index one distinct value at a time
-- instead, which needs the index to exist to be worth anything.
CREATE INDEX IF NOT EXISTS events_service_idx ON events (service);
