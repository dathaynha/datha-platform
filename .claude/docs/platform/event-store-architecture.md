# event-store — architecture & design intent

_Architecture, design rules, and open concerns for the event-store service (NATS JetStream + Postgres)_

## Purpose

A purpose-built service that acts as the event backbone for the entire platform. Every service publishes structured business events to **NATS JetStream**; the event-store subscribes to all of them, persists to **Postgres**, and exposes a query API for debugging, auditing, and root-cause analysis.

This replaces the need for third-party log aggregators for business-level traceability.

**Platform decision:** ship **event-store alongside NATS JetStream** as soon as the backbone exists — do not defer event-store for “later scaling.” Other services add publishers and additional pull consumers on the same broker without coupling.

## Stack

| Concern | Choice | Reason |
|---------|--------|--------|
| Language | Node.js + TypeScript + Fastify | Consistent with file-service; fast enough for I/O-bound work |
| Message broker | **NATS JetStream** | Persistent, replay-capable, low footprint, simple multi-consumer fan-out |
| Storage | **Postgres** (`events` table, `jsonb` payload) | Same DB cluster as other services; queryable, durable |

## Local dev

From `event-store/` (Postgres + NATS up; **`platform-nats` `pnpm reconcile`**; DB migrated):

```bash
pnpm dev   # tsx watch — preferred for local work
```

- **`pnpm start`** runs compiled **`dist/`** — run **`pnpm build`** after route/handler changes or routes 404.
- Ops UI: **`event-store-frontend/`** → **`pnpm start`** (port **4002**).

## Standard Event Envelope

Every publisher (chatbot-service, file-service, api-gateway, analytics-service, …) **must** emit this exact shape. No exceptions.

```json
{
  "id": "<uuid v4>",
  "type": "file.uploaded",
  "service": "file-service",
  "entity_id": "<file-uuid>",
  "owner_id": "google_<sub> | entra_<oid>",
  "correlation_id": "<X-Correlation-ID from gateway>",
  "timestamp": "<ISO 8601 UTC>",
  "payload": {}
}
```

### NATS subject convention

`events.<service>.<noun>.<verb>`

Examples:
- `events.chatbot.message.sent`
- `events.chatbot.conversation.deleted`
- `events.file.file.uploaded`
- `events.gateway.auth.login`
- `events.analytics.job.completed` — **analytics job lifecycle only**; see **`platform/analytics-service-architecture.md`** (rollup service deferred)

**DLQ subjects (mandatory pattern, separate stream — see JetStream topology):** `events.dlq.>` — e.g. `events.dlq.file.conversation_cleanup`. These **must not** be ingested as normal business rows by event-store; they live on the **`DLQ` JetStream stream** for ops and replay.

**Conversation → orphan file cleanup (chatbot + file choreography):** authoritative steps, payload, and consumer name live only in **`platform/chatbot-file-events.md`** — do not copy that narrative here.

## JetStream topology (platform-wide)

Two streams so business events and poison / exhausted-retry traffic stay separated:

| Stream | Subjects | Dev defaults | Purpose |
|--------|----------|----------------|----------|
| **`EVENTS`** | Explicit includes: `events.chatbot.>`, `events.file.>`, `events.gateway.>`, `events.analytics.>`, `events.messenger.>` (added 2026-09-08), … (add new `{service}` prefixes as services appear). **Do not** use a single catch-all `events.>` if that would also match `events.dlq.>`. | `max_age`: **14d** default (`JETSTREAM_EVENTS_MAX_AGE_DAYS` in **platform-nats**), `max_bytes`: **~1 GiB**, storage `file`, discard `old` | JetStream replay buffer; **Postgres query TTL** is separate (**90d** default — `EVENTS_RETENTION_DAYS`, `pnpm retain`). |
| **`DLQ`** | `events.dlq.>` | **30d** default (`JETSTREAM_DLQ_MAX_AGE_DAYS`); Postgres **`dlq_records`**: **180d** (`DLQ_RETENTION_DAYS`, `pnpm retain`) | After **`max_deliver`** or handler-defined final failure, workers **publish** an enriched record (original subject, correlation_id, owner_id, payload, `last_error`, optional stream sequence metadata) to `events.dlq.<logical-sink>`, then **ack** the original message. |

- **Stream and durable consumer creation:** **`platform/platform-nats-architecture.md`**. **Apps connect only**.
- **Consumers (event-store ingest, file-service cleanup, …):** pull durables, explicit ack, bounded `fetch`.
- **`max_deliver`:** centralized in **platform-nats**. On exhaustion, **DLQ publish + ack** (domain consumers and **ingest** on `event-store-ingest`, sink **`event_store.ingest`**). Invalid envelopes on ingest use **`term()`**, not DLQ.

**event-store ingest consumer:** pull durable (e.g. `event-store-ingest`) on stream **`EVENTS`** only — `filter_subject` per prefix or multi-filter as supported; **never** attach ingest to the **`DLQ`** stream. Optional separate read-only tooling may subscribe to `DLQ` for alerts.

## Postgres Schema

```sql
CREATE TABLE events (
  id            UUID PRIMARY KEY,
  type          TEXT NOT NULL,
  service       TEXT NOT NULL,
  entity_id     TEXT,
  owner_id      TEXT,
  correlation_id TEXT,
  timestamp     TIMESTAMPTZ NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX ON events (type);
CREATE INDEX ON events (service);   -- filter column, and the distinct-values walk
CREATE INDEX ON events (entity_id);
CREATE INDEX ON events (owner_id);
CREATE INDEX ON events (correlation_id);
CREATE INDEX ON events (timestamp DESC);
```

### `events` is partitioned by month (2026-09-19, migration `005`)

`PARTITION BY RANGE (timestamp)`, one partition per month
(`events_y2026m09`), plus `events_default`. Retention drops whole partitions
instead of deleting rows, and every ops query is keyed on `timestamp`, so
pruning takes the common "recent" scan down to one or two partitions.

Four consequences, all load-bearing:

1. **The primary key is `(id, timestamp)`.** A unique index on a partitioned
   table must contain the partition key. Ingest's conflict target moved with it
   (`ON CONFLICT (id, "timestamp") DO NOTHING`) and dedupe is still global,
   because every republish path — DLQ replay included — sends the stored
   envelope verbatim, so the timestamp is the one the first insert used.
2. **Retention granularity is the month.** A partition can only be dropped once
   its whole range is past the cutoff, so a row 91 days old lives until every
   row in its month is 90 days old. Measured on a clone: 64 rows past the
   cutoff, 59 actually removed. `runRetention` reports both numbers and they are
   *meant* to differ.
3. **`events_default` is a safety net, not a home.** DLQ replay republishes an
   envelope with its original timestamp, so replaying something older than the
   oldest surviving partition has nowhere else to go; losing it to an ingest
   error would be worse. Rows accumulating there are a signal to look.
4. **Partitions must exist before rows arrive.** `events_ensure_partitions(n)`
   creates the current month plus `n` more and is called from **two** places
   that do not depend on each other — the service on boot (`app.ts`) and the
   retention job daily (`retain.ts`) — for the same reason the call reaper
   exists: whatever closes a gap must be reachable by more than the one process
   you expect to be alive.

**Partition bounds are explicit UTC, and must stay that way** (migration `007`).
`FOR VALUES FROM ('2027-05-01')` parses that literal in the **session**
TimeZone, and `events.timestamp` is `timestamptz` — so the same statement
produced different partitions depending on who ran it. Measured on a clone,
2026-09-20: under `Asia/Ho_Chi_Minh`, `events_y2027m03` covered
`2027-02-28 17:00+00` onward; under `America/New_York`, `events_y2027m05` ran to
`2027-06-01 04:00+00`.

That is not cosmetic. Retention derives a partition's upper bound from its
**name**, so at a negative offset the real bound is *later* than the name says
and the daily drop takes rows that have not expired — silent data loss in a job
that reports success. The functions now build bounds as explicit `+00` text, and
`events_ensure_partitions` takes its window from `now() AT TIME ZONE 'UTC'`, so
a session an hour before local midnight on the 1st cannot skip the month about
to receive rows. Verified by creating the same months from three session
timezones and getting identical UTC bounds, and by a row on a boundary landing
in the partition its name claims.

Migration `007` also **refuses to run** against a database whose existing
partitions disagree with their names, naming them. Repair means detaching and
moving rows, which a migration should not do silently to data it has never seen.

`GET /events/:id` now touches every partition, because an id alone does not say
which month. That is a handful of index lookups, not a scan.

⚠️ **`pnpm build` nested the migrations directory** until 2026-09-19:
`cp -r src/db/migrations dist/db/migrations` copies *into* an existing target,
so the second build onwards put new migrations in
`dist/db/migrations/migrations/` and `pnpm migrate` silently skipped them. Found
because `005` would not apply. The script now `rm -rf`s the target first.

## Service Structure

```
event-store/
  README.md          -- short intro + pointer to .claude/docs
  CLAUDE.md          -- pointer to platform/event-store-architecture.md + platform/chatbot-file-events.md
  .env.example       -- NATS_URL, DATABASE_URL, PORT (no secrets)
  src/
    index.ts           -- Fastify bootstrap + lifespan (NATS consumers)
    app.ts             -- route registration
    config.ts          -- env validation (NATS_URL, DATABASE_URL, PORT)
    retain.ts          -- `pnpm retain` / `--execute` (manual; ADO cron later)
    plugins/
      db.ts            -- postgres pool plugin
      nats.ts          -- NATS connection plugin
    db/
      migrate.ts       -- migration runner
      migrations/      -- SQL migration files
    nats/
      streams.ts       -- durable name constants (sync with platform-nats)
      consumer.ts      -- EVENTS ingest handler (validate envelope → ingest)
      run-pull-consumer.ts -- shared pull loop
      dlq-consumer.ts  -- DLQ stream ingest handler
    routes/
      events.ts        -- GET /events, /events/services, /events/types,
                       --     /events/payload-keys, /events/payload-values,
                       --     /events/:id
      events.test.ts   -- route inject tests (`order`, /events/:id,
                       --     /events/services, /events/types)
      dlq.ts           -- GET /dlq, /dlq/sinks, /dlq/:id, POST /dlq/:id/replay
      dlq.test.ts      -- route inject tests (`order`)
      health.ts        -- GET /health → { status: "ok" }
    services/
      ingest.ts        -- validate envelope, write to DB
      query.ts         -- GET /events query logic
      retention.ts     -- Postgres TTL delete (used by retain CLI)
      dlq-ingest.ts    -- persist DLQ JetStream messages to dlq_records
      dlq-query.ts     -- DLQ list/detail queries
      dlq-replay.ts    -- republish stored envelope to EVENTS
```

## Query API

`GET /events` — all params optional, all combinable:

| Param | Example |
|-------|---------|
| `type` | `file.uploaded` — repeat or comma-separate for multiple (`?type=a&type=b`) |
| `service` | `file-service` — repeat or comma-separate for multiple |
| `entity_id` | `<file-uuid>` |
| `owner_id` | `google_abc123` |
| `correlation_id` | `<req-uuid>` |
| `from` | `2026-01-01T00:00:00Z` |
| `to` | `2026-01-02T00:00:00Z` |
| `limit` | `100` (default) |
| `offset` | `0` |
| `order` | `asc` \| `desc` — sort by **`timestamp`** (default **`desc`**, newest first) |
| `payload.<key>` | `payload.origin=messenger` — equality on a payload field, repeatable and ANDed |

Response: `{ data: Event[], total: number, totalCapped: boolean }`

### Filtering on a payload field

`?payload.<key>=<value>`, e.g. `?payload.origin=messenger`. Repeatable; several
pairs are ANDed.

Generic rather than a param per field, and the reason is the bug that prompted
it: `origin` was added to the file events so an audit could tell a chatbot
attachment from a messenger one, and was then **unfilterable**, because the list
filters columns and `origin` lives in `payload`. A column or a `->>` expression
index per interesting field does not scale and repeats that conversation every
time; a **GIN index on the whole document** (`events_payload_idx`, migration
`008`, `jsonb_path_ops`) serves containment for every key at once, so the next
publisher to add a payload field gets filtering for free.

Two details that are easy to get wrong:

- **Containment is type-strict, and a query string is always text.** Payloads
  hold numbers and booleans (measured: 3,650 strings, 238 numbers, 1 boolean),
  so `payload.duration_seconds=0` matched as `"0"` would silently never find the
  number `0`. Each pair is matched as the string **or** as the JSON scalar it
  parses to, both answered by the same index. A strict numeric test is used, so
  `" 1 "` and `""` stay strings.
- **The key never reaches the SQL text.** It is part of a bound JSON value, so
  there is no identifier to quote. Keys are still validated as
  `[A-Za-z0-9_]{1,64}` and a bad one is a **400** rather than being ignored —
  a silently dropped filter returns more rows than asked for, which reads as
  the filter not working.

`jsonb_path_ops` cannot answer key-existence (`?`), which this service does not
ask.

**The filter's own menus** — so a payload key, which is an implementation detail
of whichever service published the event, is picked rather than remembered:

| Route | Returns |
|---|---|
| `GET /events/payload-keys` | Field names present, ascending — `{ data: string[] }` |
| `GET /events/payload-values?key=<k>` | Values seen for one field, ascending, capped |

Both read the **newest `PAYLOAD_SAMPLE_ROWS` (5,000) events**, not the whole
table: `jsonb_object_keys` over all history is a scan no index can feed, and
this store only grows. "The fields events carry lately" is the useful answer for
a dropdown, and the work is bounded the way the count cap bounds `COUNT(*)`.
Values are additionally capped at `PAYLOAD_VALUE_LIMIT` (200) so one
high-cardinality field cannot flood the menu, and objects and arrays are
excluded because neither has a single value a filter could match. A bad key is
a **400**.

**`total` is capped, not exact.** `COUNT(*)` reads every matching row, so an ops
list opened unfiltered gets slower forever as the store grows — and nobody pages
to record 40,000. The count is taken over a `LIMIT cap + 1` subquery
(`countCapped` in `services/query.ts`), so it reads at most `cap + 1` rows
whatever the table holds; `totalCapped` is true when it hit the ceiling and the
UI renders "10,000+". The cap is **`LIST_COUNT_CAP`**, default **10,000**.
Measured at 715 rows: 6 buffers capped at 100 against a full scan for the exact
count. Deep `OFFSET` is bounded by the same cap, since the page links stop
there.

**Past the cap the list keeps walking, on a cursor.** Numbers and keyset are not
a choice between two designs — they answer different halves of the same list.
Offset paging holds while the total is exact, because page numbers need a total.
Beyond it, `?after=<cursor>` returns the rows strictly after that one in the
sort order, and the response carries `nextCursor` (null on the last page).
Stopping at the cap instead would strand a reader at page 200 with rows still
below them, which is worse than the Previous/Next this paginator replaced.

- The cursor is **opaque** (`base64url` of `timestamp|id`) — it encodes the sort
  key, and a client that builds one makes the ordering a breaking change for
  everybody. A malformed one is a **400**, never a quiet reset to page 1: a deep
  page that silently restarts at the top reads as data loss.
- Keyset needs a **total order**, so the sort is `(timestamp, id)` and migration
  `006` replaced `events_timestamp_idx` with `events_timestamp_id_idx
  (timestamp DESC, id DESC)`. A composite index serves its own leading column,
  so nothing lost a covering index.
- The predicate is a **row comparison** — `(timestamp, id) < ($1, $2)` — which
  the index seeks on directly and which cannot be got subtly wrong at the
  boundary the way the expanded `OR` form can.
- `total` ignores the cursor, so the readout describes the result set rather
  than shrinking as you walk.
- Measured at 715 rows: keyset **15 buffers** against **1,234** for
  `OFFSET 650`, and the keyset figure does not grow with depth.

Only the **events** list has this. DLQ keeps offset paging and the cap: if that
table is ever deep enough to need a cursor, the pager is not the problem.

`GET /events/:id` — single event by UUID. **404** if not found.

`GET /events/services` — the distinct `service` values actually present,
ascending. Response: `{ data: string[] }`. It is what
`event-store-frontend`'s service filter offers; there is no hard-coded list any
more, because the one there used to be had drifted to the point where 78% of
events could not be filtered at all (measured 2026-09-19).

Implemented as a **loose index scan** over `events_service_idx` rather than
`SELECT DISTINCT`: Postgres 16 has no index skip scan, so `DISTINCT` reads every
row (or, once indexed, every index entry), while the recursive form costs N+1
probes for N services whatever the table holds. Measured on the dev database at
715 rows: 11 buffers and 0.18 ms against a 45-buffer sequential scan. See
`services/query.ts`.

`GET /events/types` — the distinct `type` values actually present, ascending.
Response: `{ data: string[] }`. Same loose index scan, over the
`events_type_idx` that has existed since migration `001` — so this endpoint
needed **no migration**. Added 2026-09-20; the filter it feeds had been free
text over ten values, which meant a typo returned an empty list that reads
exactly like "nothing of that kind happened".

## DLQ query API (operational)

DLQ JetStream messages (`events.dlq.>`) are **not** stored in `events`. A separate **`dlq_records`** table is filled by durable consumer **`event-store-dlq-ingest`** on stream **`DLQ`**.

| Route | Purpose |
|-------|---------|
| `GET /dlq` | List failed messages — filters below. |
| `GET /dlq/:id` | Single DLQ record by UUID. |
| `GET /dlq/sinks` | Distinct `sink` values present, ascending — `{ data: string[] }`. Same loose index scan as `/events/services`, over `dlq_records_sink_idx`. |
| `POST /dlq/:id/replay` | Re-publish stored **`envelope`** to **`original_subject`** on stream **`EVENTS`**; sets **`replayed_at`**. Returns **202**. **400** if no envelope; **409** if already replayed. |

`GET /dlq` — all params optional, all combinable:

| Param | Example |
|-------|---------|
| `owner_id` | `google_abc123` — optional ops filter (same as events list) |
| `sink` | `file.conversation_cleanup` — repeat or comma-separate for multiple |
| `correlation_id` | `<req-uuid>` |
| `from` | `2026-01-01T00:00:00Z` |
| `to` | `2026-01-02T00:00:00Z` |
| `limit` | `100` (default) |
| `offset` | `0` |
| `order` | `asc` \| `desc` — sort by **`failed_at`** (default **`desc`**, newest first) |

Response list shape: `{ data: DlqRecord[], total: number, totalCapped: boolean }` — same cap as the events list. Single record returns one object (camelCase fields). Replay response: `{ id, originalSubject, replayedAt }`.

**Replay semantics:** same event `id` in envelope is allowed (ingest dedupes; domain consumers must be idempotent). event-store does **not** call other services over HTTP — only republishes to NATS.

### Auth

- **Today:** expose query/replay only via **api-gateway** (`/api/event-store/*`) with **JWT** on protected routes. event-store lists **all** rows (optional `?owner_id=` filter only). **`POST /dlq/:id/replay`** has no extra auth inside event-store (gateway JWT is the gate).
- **Later:** **admin role** at gateway — documented in **`platform/platform-nats-architecture.md`** (future). No owner-scoped DLQ/events for end users.

## Design Rules

1. **event-store is read-only for consumers** — it never calls other services over HTTP; it ingests from NATS, answers queries, and may **republish** a stored envelope to **`EVENTS`** for operational DLQ replay only.
2. **No business logic here** — ingest, validate shape, persist. That's it. Analytics, alerting, and aggregation belong in dedicated consumers.
3. **Idempotent writes** — use `INSERT … ON CONFLICT (id) DO NOTHING`. NATS delivers at-least-once; duplicate events must be silently dropped.
4. **Never block the NATS consumer** — if Postgres is slow, buffer in memory briefly; do not let backpressure propagate to publishers.
5. **`payload` is opaque** — the event-store does not parse or validate payload contents beyond confirming it is a JSON object.
6. **Correlation ID is the primary debugging key** — every query for root-cause starts with `correlation_id`. Design indexes and UI around it.

## Integration Checklist (per service that publishes)

- [ ] Add `NATS_URL` to the service's env and connect on startup
- [ ] Publish events after successful mutations (not before — same rule as Postgres writes)
- [ ] Always include `correlation_id` from the inbound `X-Correlation-ID` header
- [ ] Never publish on failed operations — a failed event is a misleading event

## Resolved platform decisions

**NATS JetStream vs Redis for chatbot jobs**
- **NATS JetStream** is the **durable multi-consumer bus** for business events (`EVENTS` / `DLQ` streams, publishers, event-store, file cleanup, future services).
- **Redis** remains the **chatbot job queue + SSE streams** (BLPOP, Redis Streams for chunks). Do not replace Redis with NATS for that path unless product explicitly asks.

**7. NATS in Docker Compose (action)**
- Add a `nats` service with JetStream enabled (`-js`), persistence volume (`-sd /data`), port **4222**, healthcheck.
- Set `NATS_URL` in **chatbot-service**, **file-service**, **event-store**, and any future publisher or consumer via **`.env.example`** only in-repo; never commit real `.env` files.

## Open Concerns — Evaluate Before Starting

**1. Shared Postgres cluster vs dedicated DB**
Sharing the same Postgres instance as chatbot-service and file-service saves infra cost but means a heavy event write load could affect query latency for other services. At the current scale this is fine. For production, consider a separate schema at minimum, separate instance when volume justifies it.

**2. Event schema versioning**
What happens when `file.uploaded` needs a new field 6 months from now? Options: (a) additive-only changes to `payload` — safe, always backward compatible; (b) version in the type string (`file.uploaded.v2`) — explicit but verbose. Recommendation: additive-only for now, introduce versioning when a breaking change actually happens.

**3. Who reads the events UI?**
**Resolved:** **`event-store-frontend`** ops UI — Events list/detail (`GET /events`, `GET /events/:id`) and DLQ list/detail/replay via gateway `/api/event-store/*`. Direct Postgres access remains fine for one-off debugging.

**4. Auth on the query endpoint**
Gateway JWT required for `/api/event-store/*`. event-store does not enforce owner scope; add **admin role** at gateway before **event-store-frontend** DLQ ops UI ships to prod — **`platform/platform-nats-architecture.md`**, **`services/event-store-frontend-architecture.md`**.

**5. Retention policy**

| Layer | Default TTL | Config | Cleanup |
|-------|-------------|--------|---------|
| Postgres **`events`** | **90 days** | `EVENTS_RETENTION_DAYS` | **`pnpm retain`** (dry-run) · **`pnpm retain --execute`** · ADO cron later |
| Postgres **`dlq_records`** | **180 days** (`failed_at`) | `DLQ_RETENTION_DAYS` | same CLI |
| JetStream **`EVENTS`** | **14 days** | `JETSTREAM_EVENTS_MAX_AGE_DAYS` in **platform-nats** | `pnpm reconcile` (broker discard) |
| JetStream **`DLQ`** | **30 days** | `JETSTREAM_DLQ_MAX_AGE_DAYS` in **platform-nats** | `pnpm reconcile` |

JetStream limits are a **replay/ops buffer**, not the query audit window — Postgres holds longer history after ingest. Keep env defaults documented in **event-store** `.env.example` and **platform-nats** `.env.example`.

## CI (bot-review)

**In repo:** `azure-pipelines/bot-review.yml`, `.mega-linter.yml`, `.pr_agent.toml` (copy pattern from **`file-service`** — change markers/titles only). **ADO:** bot-review pipeline registered. New-repo checklist: **`ci/bot-review-pipelines.md`**.
