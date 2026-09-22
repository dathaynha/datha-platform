# AI context — `event-store`

AI guidance for this project is maintained in **`.claude/docs/`**:

- **`platform/event-store-architecture.md`** — service purpose, envelope, JetStream topology (`EVENTS` / `DLQ`), ingest consumer, Postgres, query API
- **`platform/platform-nats-architecture.md`** — reconcile; sync **`NATS_CONSUMER_MAX_DELIVER_EVENT_STORE_INGEST`**
- **`platform/chatbot-file-events.md`** — canonical choreography for conversation → file events (subjects you ingest alongside other `events.*` traffic)
- **`lang/lang-typescript-fastify.md`** — TypeScript / Fastify conventions (when code exists)

Do not duplicate long platform NATS prose in this file; edit the **`.md`** rules when behavior changes.
