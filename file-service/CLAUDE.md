# AI context — `file-service`

AI guidance for this project is maintained in **`.claude/docs/`**:

- **`lang/lang-typescript-fastify.md`** — TypeScript / Fastify best practices
- **`services/file-service-architecture.md`** — service architecture and responsibility boundary
- **`products/chatbot-architecture.md`** — cross-service chat flow when files attach to chat messages
- **`platform/chatbot-file-events.md`** — **canonical** NATS flow: conversation delete → orphan files → file-service consumer (edit this file when that story changes; do not duplicate long prose in `CLAUDE.md`)
- **`platform/platform-nats-architecture.md`** — reconcile before start; **`NATS_CONSUMER_MAX_DELIVER_FILE_SERVICE_CONVERSATION_CLEANUP`** must match platform-nats for that durable
