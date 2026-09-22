# platform-nats — architecture and design rules

_platform-nats ADO repo — JetStream topology, reconcile, max_deliver (single source), deploy order_

## Purpose

**ADO repo** (not a runtime app). Owns **shared NATS JetStream** configuration: streams (`EVENTS`, `DLQ`) and **all platform pull durables**. Other services **connect only** — they never call `streams.add` or `consumers.add` on startup.

**Local dev:** run a NATS server with JetStream on your machine (Docker, install, or cloud dev instance), set `NATS_URL`, then **`pnpm reconcile`** from this repo.

## Responsibility boundary

| Does | Does not |
|------|----------|
| `topology.ts` — streams, subjects, durable names, `max_deliver` | Run HTTP APIs or ingest events |
| `reconcile.ts` — idempotent add/update via JetStream manager | Replace per-service NATS publish/consume logic |
| `max-deliver.ts` — **only** place that defines how `max_deliver` env vars map to durables | Host application Postgres or blobs |
| ADO pipeline `azure-pipelines/jetstream-reconcile.yml` | Deploy chatbot, file-service, or event-store images |

Keep durable **names** in sync with each service `src/nats/streams.ts` constants.

**Topology PRs:** follow **`platform-nats/TOPOLOGY_PR_CHECKLIST.md`** (cross-repo durable/subject sync, reconcile, deploy order).

**Node client:** `@nats-io/transport-node` + `@nats-io/jetstream` (`jetstream(nc)`, `jetstreamManager(nc)` — not legacy `nats` package).

## `max_deliver` (centralized — do not scatter)

**All logic lives in this repo:** `max-deliver.ts` + `topology.ts` + reconcile env (`.env.example`).

| Variable | Scope |
|----------|--------|
| `NATS_CONSUMER_MAX_DELIVER` | Default for **every** platform pull durable (e.g. **3**) |
| `NATS_CONSUMER_MAX_DELIVER_<DURABLE>` | Optional override; durable name with `-` → `_`, uppercased (e.g. `NATS_CONSUMER_MAX_DELIVER_FILE_SERVICE_CONVERSATION_CLEANUP`) |

**Broker config** is centralized here (`max-deliver.ts` + reconcile). **Application-side DLQ** (e.g. file-service on `conversation.deleted`) cannot be centralized in this repo — each service reads the **per-durable env key** for its consumer:

| Durable | Env var (sync platform-nats + service `.env` when app DLQ) |
|---------|-----------------------------------------------------------|
| `file-service-conversation-cleanup` | `NATS_CONSUMER_MAX_DELIVER_FILE_SERVICE_CONVERSATION_CLEANUP` |
| `event-store-ingest` | `NATS_CONSUMER_MAX_DELIVER_EVENT_STORE_INGEST` |
| `event-store-dlq-ingest` | `NATS_CONSUMER_MAX_DELIVER_EVENT_STORE_DLQ_INGEST` (optional; defaults to `NATS_CONSUMER_MAX_DELIVER`) |
| `notification-service-events` (EVENTS) | `NATS_CONSUMER_MAX_DELIVER_NOTIFICATION_SERVICE_EVENTS` |
| `notification-service-dlq` (DLQ) | `NATS_CONSUMER_MAX_DELIVER_NOTIFICATION_SERVICE_DLQ` (optional; defaults to `NATS_CONSUMER_MAX_DELIVER`) |
| `messenger-service-calls` (EVENTS) | `NATS_CONSUMER_MAX_DELIVER_MESSENGER_SERVICE_CALLS` (optional; defaults to `NATS_CONSUMER_MAX_DELIVER`). **Filtered to `events.messenger.call.>`** — unlike the notification durable, because it exists to build one table. Added 2026-09-09 (Messenger phase 2); the `EVENTS` stream already carried `events.messenger.>`, so **no stream change was needed** |

Pattern: `NATS_CONSUMER_MAX_DELIVER_<DURABLE>` with `-` → `_`, uppercased. Reconcile uses `NATS_CONSUMER_MAX_DELIVER` default unless the per-durable var is set.

**DLQ sinks:** `file.conversation_cleanup`, **`event_store.ingest`** (persist to Postgres failed after max deliveries), **`notification_service.projection`** (notification projection failed; notification-service's own DLQ consumer skips this sink — loop guard).

## Reconcile

```bash
pnpm install
pnpm reconcile   # requires NATS_URL
```

Run after: new environment, `topology.ts` change, or suspected missing durables.

## Updating durables (`filter_subject` / `max_deliver`)

JetStream may reject in-place `consumers.update`. Reconcile logs a warning.

1. **Prefer additive** — new durable name + filter; migrate; delete old durable.
2. **Dev / empty broker** — wipe the JetStream data directory or use a fresh NATS instance, then reconcile.
3. **Prod** — `nats consumer rm <stream> <durable>` (or UI), then `pnpm reconcile`.
4. **Verify** — `nats consumer info …` for `max_deliver` / `filter_subject`.

Do not expect app restarts to fix consumer config.

## Deploy order

Every environment:

1. **NATS** reachable.
2. **platform-nats** — `pnpm reconcile` (ADO pipeline or manual).
3. **Apps** — event-store, file-service, chatbot-service (any order after step 2).

**For now:** manual checklist — run reconcile pipeline before app deploys in that environment.

**Later orchestration (no app code change):** ADO stage running `jetstream-reconcile.yml` first, environment gate, or pipeline trigger from a platform release.

## Azure DevOps

Register **`/azure-pipelines/jetstream-reconcile.yml`**. Variable group: `NATS_URL` (secret), `NATS_CONSUMER_MAX_DELIVER`, optional per-durable overrides.

## Production NATS (future deployment)

Not implemented in repo yet. **When deploying to Azure/prod**, provision separately:

- Managed NATS / **NATS Cloud** / **Helm on AKS** with JetStream enabled and persistent volumes.
- `NATS_URL` (and TLS/credentials) in ADO variable group / Key Vault for **platform-nats reconcile** and all app repos.
- Network: app subnets and reconcile job can reach broker **4222** (or TLS port).
- Align stream retention with event-store Postgres TTL when both exist — defaults: **`JETSTREAM_EVENTS_MAX_AGE_DAYS=14`**, **`JETSTREAM_DLQ_MAX_AGE_DAYS=30`** (broker buffer); Postgres **90d / 180d** via event-store **`pnpm retain`**.

## Related platform rules

- **`always-apply/workspace-layout.md`** — multi-repo workspace; local Postgres / Redis / NATS per developer.
- **`platform/chatbot-file-events.md`** — conversation delete choreography.
- **`platform/event-store-architecture.md`** — ingest, query API, DLQ replay.
- **`services/api-gateway-architecture.md`** — proxy `/api/event-store/*`; **future admin role** for ops routes.

## Future (documented — not built)

| Item | Intent | Rule |
|------|--------|------|
| **Gateway admin role** | Restrict `/api/event-store/*` (and future analytics ops) to ops/admin JWT claims — today any authenticated JWT. | **`services/api-gateway-architecture.md`** |
| **event-store-frontend ops UI** | **Built** — MF remote at `/event-store`: Overview, Events list/detail, DLQ list/filter/replay → gateway `/api/event-store/*`. **Gateway admin role** still required before prod. Spec: **`platform/event-store-architecture.md`**; **`services/event-store-frontend-architecture.md`**. |
| **E2E / integration tests** | `int` journeys: delete → NATS → file cleanup → ingest → DLQ → replay. | **`testing/e2e-testing-strategy.md`** |
| **ADO orchestration** | Auto-run platform-nats reconcile before app rollouts. | this rule (prod NATS section) |
