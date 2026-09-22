# file-service — architecture and design rules

_Architecture, responsibility boundary, and design rules for the file-service_

## Purpose

**Node.js (TypeScript) + Fastify** microservice. Owns all file lifecycle: metadata in **Postgres**, blobs in **Azure Blob Storage**. Trusts **`X-Owner-ID`** injected by **api-gateway** (or internal callers on a private network) — **never parses JWTs** and never touches Google OAuth credentials.

file-service is a **pure infrastructure service** — file-aware, AI-blind. It owns one thing: the lifecycle of a blob. It knows nothing about what a file *means* to any consumer. This makes it reusable by any future service without modification.

## Responsibility boundary

| Does | Does not |
|------|----------|
| Read **`X-Owner-ID`** from trusted gateway / internal callers | Issue or exchange OAuth tokens |
| Record file metadata in Postgres (`files` table) | Parse or verify Bearer JWTs |
| Generate **Azure Blob SAS upload URLs** for direct client upload | Proxy blob bytes through itself |
| Confirm upload and update metadata (status: `uploaded`) | Run chat or AI logic |
| Serve file metadata and download SAS URLs | Share a Redis instance with chatbot-service |
| Soft-delete / mark files inactive | Parse or interpret file content |
| Publish NATS events on state changes | Know *chat* intent from blobs (only trusts signed cleanup envelopes) |
| **Subscribe** to `events.chatbot.conversation.deleted` and run **orphan-only** file cleanup (pull consumer) | Own conversation or message domain |

## Upload flow (direct-to-blob)

```
Client
  1. POST /files/prepare       ──→  file-service  ──→  Postgres (insert row, status=pending)
                               ←──  { fileId, sasUploadUrl }
  2. PUT <sasUploadUrl>        ──→  Azure Blob (direct, no gateway hop)
  3. POST /files/:id/confirm   ──→  file-service  ──→  Postgres (status=uploaded)
                                    file-service  ──→  NATS: events.file.file.uploaded
  4. Message payload includes { fileId } reference only — chatbot-service never touches blobs
```

## Reading a file you do not own

Every read here is scoped to `X-Owner-ID`, so a consumer whose users share files with *each other* cannot serve them from this service directly. **Messenger brokers its own attachments**: it authorizes the reader by conversation membership, then asks this service for a download URL **as the uploader** over the private network. The authoritative description is **`services/messenger-service-architecture.md` § Attachments** — this service stays chat-blind and gains no ACL.

Uploads from Messenger carry `origin: "messenger"`, which keeps them out of the orphan reconcile (it only ever deletes `chatbot`).

**`origin` rides the events too (2026-09-19).** `file.uploaded` and
`file.deleted` carry it in `payload.origin`. The envelope's `service` field says
`file-service` — that is the *publisher*, not the product that asked — so until
this landed, an audit in the event store could not tell a chatbot attachment
from a messenger one without joining back to this database, which is the one
place nobody looks during an incident. Two products share this service today
and the number only goes up. `null` for rows predating the column.

`FileEvent.origin` is **required**, deliberately: making it optional would have
let the third publish site (`conversation-cleanup.consumer.ts`, which emits
`file.deleted` for the chatbot cleanup choreography) keep publishing without it.
The compiler found that one.

## Cross-service interaction pattern: references, not data

Every service that touches a file stores only a **`file_id` (UUID)** — never the bytes, never duplicated metadata. When a service needs file content, it fetches a fresh SAS download URL from file-service at the time it needs it.

```
chatbot-service DB:  message_files(message_id, file_id)  ← UUID only, no cross-service FK
file-service DB:     files(id, owner_id, blob_path, ...)  ← single source of truth
```

No cross-service foreign keys — that is a microservice anti-pattern that couples deployments and schemas.

No cross-service foreign keys — that is a microservice anti-pattern that couples deployments and schemas.

## Identity / ownership

The **api-gateway** validates Bearer JWTs and injects **`X-Owner-ID`** before proxying. **This service never parses JWTs** — same model as **`chatbot-service`**.

- Every authenticated route uses **`fastify.authenticate`**: require non-empty **`X-Owner-ID`**; reject with **401** if missing.
- Gateway **strips** client-supplied `X-Owner-ID` before injecting the value from JWT claims — prevents header spoofing on the public path.
- **Internal callers** (chatbot worker, orphan reconcile) send **`X-Owner-ID`** on a private network; those routes must **not** be exposed via api-gateway.
- Every query **must** filter by `request.ownerId` — never trust a client-supplied owner in the body.

## Download SAS (worker + browser)

`GET /files/:id/download-url` returns `{ sasDownloadUrl, expiresAt }` — **worker / internal only** (chatbot-service → Gemini inline data). Call with **`X-Owner-ID`**; **do not** expose this path through api-gateway.

**Browser:** file uploads and previews go through **`/api/files/*`** on the gateway (JWT at gateway → **`X-Owner-ID`** downstream). Prefer **`GET /files/:id/content`** (proxied) for same-origin previews when needed.

Do **not** call file-service directly from the SPA in production; always use the gateway so JWT is enforced at the edge.

## Internal-only HTTP routes

**Never** expose these through **api-gateway**; restrict to private network (worker → file-service, orphan reconcile CLI).

| Route | Purpose |
|-------|---------|
| **`GET /files/:id/download-url`** | SAS download URL for chatbot worker |
| **`GET /internal/files`** | Paginated file list for orphan reconcile (`?origin=chatbot`) |

**Browser-facing routes** (`POST /files/prepare`, confirm, `GET /files`, `GET /files/:id/content`, `DELETE /files/:id`): same **`X-Owner-ID`** auth via gateway in prod.

- SAS TTL for downloads: configurable (`SAS_DOWNLOAD_TTL_SECONDS` / env naming in file-service config).

## NATS event publishing

file-service **must** publish to NATS JetStream after every successful state mutation. Publish after the Postgres write succeeds — never before. Never publish on failed operations.

| Event type | Trigger | Key payload fields |
|---|---|---|
| `events.file.file.uploaded` | `POST /files/:id/confirm` succeeds | `file_id`, `owner_id`, `mime_type`, `blob_path`, `correlation_id` |
| `events.file.file.deleted` | soft-delete succeeds | `file_id`, `owner_id`, `correlation_id` |

**Publish from day one.** Downstream services (event-store, search, analytics) depend on durable events.

**Conversation delete → orphan file cleanup (pull consumer, DLQ, payload contract):** authoritative spec is **`platform/chatbot-file-events.md`** only — do not duplicate that narrative here. **Broker topology / envelope:** `platform/event-store-architecture.md`.

**Other consumers:** **event-store** on stream `EVENTS`; **planned** `search-service` on `events.file.file.uploaded`.

## Design rules

1. **No blob bytes through the service**: always use SAS URLs for both upload and download. The service only touches metadata.
2. **`X-Owner-ID` required**: every route except health must reject missing identity (**401**) before any DB or Blob call. No `JWT_SECRET` in this service.
3. **Postgres is source of truth**: file metadata (owner, name, mime type, size, blob path, status, **`origin`**, timestamps) lives in Postgres. Azure Blob is storage only.
4. **Ownership check**: a user can only read/delete their own files. Enforce with `WHERE owner_id = $userId` on every query — scope from **`X-Owner-ID`**, not request body.
5. **Correlation IDs**: read `X-Correlation-ID` from the gateway, attach to all logs, Postgres audit fields, and NATS event payloads.
6. **Soft delete only**: mark `deleted_at`, never hard-delete rows in Postgres. **Azure:** the HTTP delete path removes the blob as part of soft-delete today; consumer-driven deletes must log failures and use **DLQ** when retries are exhausted — do not leave silent partial state without observability.
7. **Config via env only**: `.env.example` pattern, no secrets committed.
8. **NATS publish is non-blocking**: if NATS is unavailable, log the failure but do not fail the HTTP response. The confirm endpoint's contract is with Postgres; event publishing is best-effort.
9. **JetStream consumers** (including conversation cleanup): **`platform/chatbot-file-events.md`** + **`platform/platform-nats-architecture.md`** — broker `max_deliver` in platform-nats; app DLQ uses **`NATS_CONSUMER_MAX_DELIVER_FILE_SERVICE_CONVERSATION_CLEANUP`** (must match effective reconcile value for that durable).

## Key env vars

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection string |
| `AZURE_STORAGE_ACCOUNT` | Blob storage account name |
| `AZURE_STORAGE_CONTAINER` | Target container name |
| `AZURE_STORAGE_CONNECTION_STRING` | Or use managed identity / SAS key |
| `SAS_UPLOAD_TTL_SECONDS` / `SAS_DOWNLOAD_TTL_SECONDS` | SAS URL lifetimes |
| `NATS_URL` | NATS JetStream connection string (e.g. `nats://localhost:4222`) |
| `NATS_CONSUMER_MAX_DELIVER_FILE_SERVICE_CONVERSATION_CLEANUP` | App DLQ after N attempts on `conversation.deleted`; must match **platform-nats** for durable `file-service-conversation-cleanup` |
| `PORT` | Listen port (default `3001`) |
| `CORS_ORIGINS` | Comma-separated allowed origins |

## Postgres schema (target)

```sql
files (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       TEXT NOT NULL,           -- from X-Owner-ID (gateway-injected)
  name           TEXT NOT NULL,           -- original filename
  mime_type      TEXT,
  size_bytes     BIGINT,
  blob_path      TEXT NOT NULL,           -- container-relative path, e.g. "{owner_id}/{uuid}/{name}"
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | uploaded | deleted
  origin         TEXT DEFAULT 'chatbot',           -- uploader product; orphan reconcile only touches explicit chatbot (NULL = unknown, never auto-deleted)
  correlation_id TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  deleted_at     TIMESTAMPTZ              -- soft delete; never hard-delete rows
)
```

## Future expansion compatibility

The design stays **open for extension**: new consumers subscribe to existing subjects; new publishers add new subject prefixes on stream **`EVENTS`** (see event-store rule for explicit subject lists vs `events.dlq.>`).

- Additional services subscribe to `events.file.file.uploaded` / `events.file.file.deleted` via NATS — **no change** to HTTP contracts.
- Any service that needs file bytes calls `GET /files/:id/download-url` — endpoint already exists.
- `owner_id` is on every row — every consumer can scope to a user.

**Exception:** file-service implements the **conversation-deleted** cleanup consumer — **full spec:** **`platform/chatbot-file-events.md`** (not duplicated here).

---

## Out of scope — do not build until explicitly asked

### Search service (Elasticsearch + vector search)

A future `search-service` could subscribe to `file.uploaded` events, extract text, generate embeddings (Gemini `text-embedding-004`), and index into Elasticsearch for full-text + semantic search. This would also enable RAG in chatbot-service (retrieve relevant chunks before calling Gemini).

**Do not design, scaffold, or reference this in code until the user asks for it.**

The event and endpoint foundations above are sufficient preparation. No further work is needed in file-service to enable this later.

## CI (bot-review)

**In repo:** `azure-pipelines/bot-review.yml`, `.mega-linter.yml`, `.pr_agent.toml` (Vitest + MegaLinter + PR-Agent — **`file-service`** is the canonical Fastify/Vitest template). **ADO:** bot-review pipeline registered. New-repo checklist: **`ci/bot-review-pipelines.md`**.

## Repo map

- `src/routes/` — Fastify route handlers (`files.ts`)
- `src/plugins/` — auth (`X-Owner-ID`), DB (postgres), blob (Azure SDK), nats (JetStream client)
- `src/services/` — file service logic, SAS URL generation, event publishing
- `src/db/migrations/` — SQL migration files (no ORM auto-migrate on startup)
- `src/types/` — shared TypeScript types
