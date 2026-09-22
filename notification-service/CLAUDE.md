# AI context — `notification-service`

AI guidance for this project is maintained in **`.claude/docs/`**:

- **`platform/platform-notifications.md`** — service purpose, event→notification mapping, i18n-key contract, phases (polling → SSE)
- **`platform/platform-nats-architecture.md`** — reconcile; durables `notification-service-events` / `notification-service-dlq`; sync **`NATS_CONSUMER_MAX_DELIVER_NOTIFICATION_SERVICE_EVENTS`**
- **`platform/event-store-architecture.md`** — envelope shape (`owner_id`, `correlation_id`) and DLQ record shape this service consumes
- **`lang/lang-typescript-fastify.md`** — TypeScript / Fastify conventions

Do not duplicate long platform prose in this file; edit the **`.md`** rules when behavior changes.
