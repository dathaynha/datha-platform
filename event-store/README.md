# event-store

Platform **append-only business event** service: subscribe to **NATS JetStream** (`EVENTS` stream), validate envelopes, persist to **Postgres**, expose a small **query API** for debugging and audits.

## Spec (source of truth)

Implementation and integration rules live in **`.claude/docs/`** (not duplicated here):

| Rule | Purpose |
|------|---------|
| **`platform/event-store-architecture.md`** | Envelope shape, `EVENTS` / `DLQ` streams, pull ingest consumer, Postgres schema, `GET /events`, design constraints |
| **`platform/chatbot-file-events.md`** | Conversation delete → orphan `file_ids` → file-service — subjects this service will see on `EVENTS` |

## Stack

Node.js + TypeScript + Fastify, `nats` JetStream client, Postgres (`events` table with idempotent insert).

## Local run

From `event-store/` (with local Postgres + NATS up, **`platform-nats` reconcile** run, and `event_store_db` created):

```bash
# Once per env: cd ../platform-nats && pnpm install && pnpm reconcile
cp .env.example .env
pnpm install
pnpm build
pnpm migrate
pnpm dev
```

- **Health:** `GET http://localhost:3002/health`
- **Via gateway (preferred):** JWT + `GET http://localhost:8080/api/event-store/events`, `GET .../events/:id`, `/api/event-store/dlq`, `POST /api/event-store/dlq/:id/replay`
- **Direct (dev):** same paths on port **3002** — lists all events/DLQ rows; optional `?owner_id=` filter. No owner scope enforced.
- **List sort:** optional `?order=asc` or `?order=desc` on `GET /events` (by `timestamp`) and `GET /dlq` (by `failed_at`); default **desc** (newest first).
- **Local dev:** prefer **`pnpm dev`** (tsx watch). If using **`pnpm start`**, run **`pnpm build`** after route/handler changes — stale `dist/` causes missing routes (e.g. `GET /events/:id` 404).
- **DLQ replay:** sets **`replayed_at`** after republishing envelope to NATS. Gateway JWT required in normal flow; **admin role** later.
- **DLQ sinks:** `file.conversation_cleanup` (from file-service), **`event_store.ingest`** (ingest could not persist to Postgres after max deliveries). Filter `?sink=` in list API.

Start **after** NATS is up and **platform-nats** reconcile has run.

## Retention

Postgres rows are not auto-deleted on ingest. Prune manually (ADO cron later):

```bash
pnpm retain            # dry-run — counts candidates
pnpm retain --execute  # DELETE rows older than TTL
```

Defaults: **90d** `events`, **180d** `dlq_records` — see **`.env.example`**. JetStream stream ages: **platform-nats** (`JETSTREAM_*_MAX_AGE_DAYS`).

## Env

Copy **`.env.example`** to `.env` locally (never commit `.env`). See variables listed there.
