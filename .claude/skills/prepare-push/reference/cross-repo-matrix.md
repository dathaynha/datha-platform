# Cross-repo dependency matrix (prepare-push)

Use when **two or more repos** are in scope, or when a single-repo diff touches cross-cutting concerns. Full MFE detail: **`services/shell-frontend-architecture.md`**, **`services/chatbot-frontend-architecture.md`**, **`services/event-store-frontend-architecture.md`**.

## Module Federation (MFE)

| If changed… | Also check… | What to verify |
|-------------|-------------|----------------|
| `shell-frontend` — routes, `webpack.config.js`, federation manifest, remote URLs, sidebar apps | `chatbot-frontend`, `event-store-frontend` | Remote names/paths match; dev ports **4000 / 4001 / 4002**; `@angular-architects/module-federation` **same pinned version**; remote exposes `remote-entry`; shell loads correct remote module |
| `chatbot-frontend` or `event-store-frontend` — `webpack.config.js`, exposes, `remote-entry`, shelled routes | `shell-frontend` | Shell route prefix (`/chatbot`, `/event-store`); manifest entry; `route.data.shelled === true`; WDS `liveReload: false` on remotes |
| Any frontend — `environment.*.ts` API/gateway URL | Other frontends + `api-gateway` | Same gateway base URL across shell/remotes for the environment |

## API gateway ↔ backends

| If changed… | Also check… | What to verify |
|-------------|-------------|----------------|
| `api-gateway` — routes, path strip, CORS, auth handlers, `stream_token` | Target service (`chatbot-service`, `file-service`, `event-store`) | Upstream URL env vars; strip prefix matches service’s own routes; identity headers injected/stripped |
| Backend — new/changed HTTP route or auth expectation | `api-gateway` | Route proxied; not exposed bypassing gateway in prod SPA paths |
| `chatbot-service` — SSE/stream paths | `api-gateway`, `chatbot-frontend` | `stream_token` flow; EventSource cannot set Bearer |

## NATS / events

| If changed… | Also check… | What to verify |
|-------------|-------------|----------------|
| `platform-nats` — `topology.ts`, durables, subjects, `max_deliver` | Every consumer/publisher service | Durable names match `src/nats/streams.ts`; `.env.example` per-durable keys; **`pnpm reconcile`**; deploy order (platform-nats before consumers) |
| Publisher — new/changed event type or payload | `event-store`, consumers on subject | Standard envelope; ingest subject list; **`platform/chatbot-file-events.md`** for conversation delete |
| Consumer — handler, ack, DLQ | `platform-nats`, owning service `.env.example` | Pull durable exists; app DLQ env matches reconcile; idempotent handler |

## Product flows (chatbot + files)

| If changed… | Also check… | What to verify |
|-------------|-------------|----------------|
| `chatbot-service` — conversation delete, `message_files`, outbox | `file-service`, `platform-nats`, `event-store` | Orphan-only `file_ids`; publish after commit; consumer + DLQ |
| `file-service` — upload/confirm/delete, conversation consumer | `chatbot-service`, `api-gateway` | SAS flow; internal routes not on gateway; ownership on every query |
| `chatbot-frontend` — attachments, file APIs | `file-service`, `api-gateway`, `chatbot-service` | Browser uses gateway `/api/files`; messages carry `file_id` only |

## Workspace git scan (multi-repo runs)

For each **sibling** repo in the matrix row (not only repos the user named):

- `git -C datha_platform/<sibling> status --short`
- If sibling has **staged/unstaged** changes but was **not** in the user’s repo list → **WARN**: “related repo `<sibling>` has local changes — include in review or confirm intentional single-repo PR”
- If user named repo A but matrix says B is required and B is **clean** → **WARN**: “coordinate PR in `<B>` before or with this push”

## Suggested PR order (when multiple repos needed)

1. `platform-nats` (topology)
2. Backend contract / events (`chatbot-service`, `file-service`, `event-store`)
3. `api-gateway` (routing/auth)
4. Remotes (`chatbot-frontend`, `event-store-frontend`)
5. `shell-frontend` (manifest/routes last if remotes must exist first)

Adjust if change is frontend-only or gateway-only.
