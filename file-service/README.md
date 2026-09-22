# file-service

File metadata (Postgres) and blob lifecycle (Azure SAS). Publishes and consumes **NATS JetStream** events for platform choreography.

**Architecture:** `.claude/docs/services/file-service-architecture.md` and **`platform/chatbot-file-events.md`**.

## Local run

From `file-service/` (Postgres, NATS up, **`platform-nats` reconcile** run):

```bash
cp .env.example .env
pnpm install
pnpm build   # required before migrate (SQL migrations copied to dist/db)
pnpm migrate
pnpm dev
```

- **Health:** `GET http://localhost:3001/health`
- **Via gateway:** `/api/files/*` — gateway validates Bearer JWT and injects `X-Owner-ID` (see api-gateway rule)

## Tests

```bash
pnpm test
```

## Env

Copy **`.env.example`** to `.env` locally (never commit `.env`).
