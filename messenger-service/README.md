# messenger-service

Durable domain state for the platform **Messenger** product — conversations, messages, read state and (phase 2) call history. Node TS + Fastify 5 + Postgres, port **3005**, reached through **api-gateway** at `/api/messenger/*`.

The socket half of Messenger lives in **`realtime-service`** (Go, 3004). This service is the write path: the browser POSTs a message here and receives it over that socket. Full design: **`services/messenger-service-architecture.md`**.

## Development

```bash
pnpm install
cp .env.example .env      # then set DATABASE_URL / NATS_URL
docker exec -it datha_platform_db createdb -U postgres messenger_service_db
pnpm migrate:dev
pnpm dev
```

Needs Postgres and NATS from `_local/docker-compose.yml`. Identity arrives as the gateway-injected `X-Owner-ID` header — there is no JWT code in this service.

## API

All routes below sit behind the gateway prefix `/api/messenger`, which the gateway strips.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | unauthenticated |
| `GET` | `/metrics` | Prometheus exposition |
| `POST` | `/conversations` | `{ type, participant_owner_ids[], title? }`; idempotent for `direct` |
| `GET` | `/conversations?limit=&cursor=` | keyset paged, newest activity first |
| `GET` | `/conversations/unread` | `{ conversation_ids[] }` — the badge resync |
| `GET` | `/conversations/:id` | 404 (not 403) when not a participant |
| `PATCH` | `/conversations/:id` | group `title`, admin only |
| `POST` | `/conversations/:id/participants` | add members (group, admin) |
| `DELETE` | `/conversations/:id/participants/me` | leave |
| `POST` | `/conversations/:id/messages` | `{ client_message_id, body?, attachment_file_id? }` → 201, or 200 on replay |
| `GET` | `/conversations/:id/messages?before=&limit=` | thread paging, newest first |
| `POST` | `/conversations/:id/read` | `{ message_id }` → advances the read watermark |

Three invariants worth knowing before changing anything here:

- **Sends are idempotent** on `client_message_id`, so a retried POST returns the original message rather than a duplicate.
- **The read watermark only moves forward** — a stale tab cannot mark a thread unread again.
- **Unread is derived**, never stored: a set of conversation ids, so a duplicate frame costs nothing and a dropped one self-heals.

## Events and fanout

Every durable write publishes twice — JetStream `EVENTS` for the record (`events.messenger.*`, ingested by `event-store`), core NATS `rt.owner.<owner_id>` for the wire (forwarded to browsers by `realtime-service`). Both happen **after** the transaction commits.

Topology (streams, durables) belongs to **`platform-nats`**; this service connects and publishes only.

## Tests

```bash
pnpm test            # vitest, single run (same as bot-review)
pnpm typecheck:test  # vitest transpiles; this is the type check
pnpm knip            # dead exports and dependencies
```

## CI — bot review

PRs targeting `main`: `azure-pipelines/bot-review.yml` extends `stack-node-vitest.yml` from `platform-pipelines` (pinned tag). See **`ci/bot-review-pipelines.md`**.
