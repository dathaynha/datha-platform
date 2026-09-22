# AI context — `realtime-service`

AI guidance for this project is maintained in **`.claude/docs/`**:

- **`services/realtime-service-architecture.md`** — WS protocol, presence, fanout, TURN credentials, design rules
- **`products/messenger-architecture.md`** — the product this serves: phases, transport table, security rules
- **`services/messenger-service-architecture.md`** — the durable half, and what it publishes to `rt.owner.<owner_id>`
- **`services/api-gateway-architecture.md`** — stream-token pattern, `Origin` validation, header injection this service trusts
- **`platform/platform-nats-architecture.md`** — durable ownership (this service uses core subjects only)
- **`lang/lang-go.md`** — Go conventions

Do not duplicate long platform prose in this file; edit the **`.md`** rules when behavior changes.
