# AI context — `messenger-service`

AI guidance for this project is maintained in **`.claude/docs/`**:

- **`services/messenger-service-architecture.md`** — data model, REST surface, publish-twice rule, design rules
- **`products/messenger-architecture.md`** — the product this serves: phases, transport table, security rules
- **`services/realtime-service-architecture.md`** — the socket half this service feeds over core NATS
- **`platform/event-store-architecture.md`** — event envelope and `EVENTS` retention
- **`platform/platform-nats-architecture.md`** — durable ownership (this service publishes only)
- **`lang/lang-typescript-fastify.md`** — TypeScript / Fastify conventions

Do not duplicate long platform prose in this file; edit the **`.md`** rules when behavior changes.
