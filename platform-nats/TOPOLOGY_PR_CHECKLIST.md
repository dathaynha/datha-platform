# JetStream topology change — cross-repo PR checklist

Use when **`platform-nats/topology.ts`** (streams, subjects, durables, `max_deliver`) changes. App repos must stay in sync before reconcile + deploy.

## In `platform-nats` PR

- [ ] **`topology.ts`** — stream names, subjects, durable names, filters, retention limits.
- [ ] **`max-deliver.ts` / `.env.example`** — new or renamed durable → per-durable env var documented (`NATS_CONSUMER_MAX_DELIVER_<DURABLE>`).
- [ ] **`pnpm reconcile`** against a dev broker; fix consumer update warnings (see architecture rule).
- [ ] **ADO** — `azure-pipelines/jetstream-reconcile.yml` variable group if new env vars.

## Matching PRs (same release train)

| Repo                           | File(s)                        | What to sync                                                                                      |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| **file-service**               | `src/nats/streams.ts`          | `STREAM_*`, `CONSUMER_*`, DLQ sink constants, fetch options                                       |
| **event-store**                | `src/nats/streams.ts`          | Same durable/stream names as topology                                                             |
| **chatbot-service**            | publish subjects / event types | New or renamed `events.chatbot.*` subjects                                                        |
| **notification-service**       | `src/nats/streams.ts`          | Durables `notification-service-events` (EVENTS), `notification-service-dlq` (DLQ)                 |
| **messenger-service**          | `src/nats/streams.ts`          | Durable `messenger-service-calls` (EVENTS), filtered to `events.messenger.call.>`                 |
| **realtime-service**           | `internal/events/events.go`    | Publish subjects `events.messenger.call.{started,ended,missed}` — publisher only, owns no durable |
| **Services with app-side DLQ** | `.env.example` + config        | Per-durable `NATS_CONSUMER_MAX_DELIVER_*` must match broker                                       |

- [ ] Durable **names** in each `src/nats/streams.ts` **exactly** match `topology.ts` (`file-service-conversation-cleanup`, `event-store-ingest`, `event-store-dlq-ingest`, `notification-service-events`, `notification-service-dlq`, `messenger-service-calls`, …).
- [ ] **No** `streams.add` / `consumers.add` in app startup — topology only via reconcile.

## Deploy / ops (every environment)

1. NATS up with JetStream.
2. **platform-nats** — `pnpm reconcile` (pipeline or manual).
3. Roll **event-store**, **file-service**, **chatbot-service** (any order after step 2).

## Breaking consumer changes

If `filter_subject`, `max_deliver`, or durable identity cannot be updated in place:

- [ ] Prefer **new durable name** + migrate consumers; delete old durable when drained.
- [ ] Or `nats consumer rm <stream> <durable>` (or wipe dev JetStream data), then reconcile.
- [ ] Verify with `nats consumer info EVENTS <durable>` (and DLQ stream).

## Docs

- [ ] **`.claude/docs/platform/platform-nats-architecture.md`** — deploy order / `max_deliver` table if behavior changed.
- [ ] **`platform/chatbot-file-events.md`** — if conversation-delete or file choreography changed.
