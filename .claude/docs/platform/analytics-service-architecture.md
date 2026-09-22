# analytics-service — architecture (deferred)

_Future analytics-service — daily rollups from event-store, manual refresh; not audit, not realtime. Do not scaffold until explicitly asked._

## Not the same as audit

| | **event-store** | **analytics-service** (future) |
|--|-----------------|----------------------------------|
| Question | What happened? (raw facts) | How much / trends? (aggregates) |
| Storage | `events` table — append-only audit | **Separate** rollup tables in analytics DB |
| When to build | **Now** (shipped) | **Only when product needs dashboards/metrics** |

**Do not** duplicate event ingest in analytics. **Read** from event-store (Postgres or internal API), **write** derived summaries elsewhere.

## Processing model (v1 — agreed)

**No realtime NATS consumer** incrementing counters on every business event.

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Daily batch** | ADO cron (~nightly); local: manual CLI like `pnpm retain` / orphan reconcile | Roll up **calendar days** from raw events; idempotent upsert by `(day, metric, …)` |
| **Manual refresh** | Admin UI button → `POST /analytics/refresh` (gateway + admin role) | **Catch-up** from last watermark to now — not streaming realtime; rate-limit (e.g. 15 min) |

Shared **watermark** (`last_processed_at` or last event id) so cron and button use the same incremental rollup logic.

UI label: **“Data through …”** — never imply sub-second live data.

## NATS (`events.analytics.>`)

Topology already reserves **`events.analytics.>`** on stream **`EVENTS`** (**`platform/platform-nats-architecture.md`**). When analytics exists, publish **job lifecycle only**, e.g.:

- `events.analytics.job.started` / `events.analytics.job.completed`

Ingested by **event-store** like other platform events. **Do not** re-publish rolled-up business facts onto the bus.

## Out of scope until explicitly asked

- Realtime JetStream consumers on `events.chatbot.>` / `events.file.>` for live counters
- Replacing **event-store** as audit source of truth
- Warehouse/BI export (future v2)

## Related rules

- **`platform/event-store-architecture.md`** — raw events, envelope, retention (`pnpm retain`)
- **`platform/platform-nats-architecture.md`** — `events.analytics.>` subject prefix
- **`services/api-gateway-architecture.md`** — future admin role for analytics + ops routes
