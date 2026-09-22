# Unit testing strategy

_Unit and integration test conventions — when to use, where tests live, platform NATS/event patterns (not E2E)_

Workspace-wide **test policy**. Language/framework syntax lives in **`lang/`** rules. Cross-service browser/API flows: **`testing/e2e-testing-strategy.md`**. Event envelope and choreography: **`platform/event-store-architecture.md`**, **`platform/chatbot-file-events.md`**.

## When to use which layer

| Layer | Scope | Real infra? |
|-------|--------|-------------|
| **Unit** | Pure functions, envelope builders, SQL query logic, handler branches with mocks | No NATS, Postgres, Redis, or Azure |
| **Integration** | One service + real DB or testcontainers (optional, later) | Local/test DB only — still no shared `int` |
| **E2E** | Multi-service user journeys | `int` — see **`testing/e2e-testing-strategy.md`** |

Prefer **unit tests** for platform event work first (cheap, fast, no broker). Do not duplicate E2E scenarios as unit tests.

## Where tests live (per ADO repo)

| Repo | Location | Run |
|------|----------|-----|
| **chatbot-service** | `tests/` (pytest) | `pytest` from repo root with venv active |
| **api-gateway** | `internal/<pkg>/*_test.go` | `go test ./... -count=1 -cover` |
| **file-service** | `src/**/*.test.ts` or `tests/` (when added) | project test script when wired |
| **event-store** | `src/**/*.test.ts` colocated (services, routes, lib) | `pnpm exec vitest run` |
| **Frontends** | Angular `*.spec.ts` next to source | `ng test` — product UI only; not NATS backlog |

Tests stay **inside the service repo** being changed — not under `datha_platform/` workspace root.

## Platform priorities (current backlog)

Add unit tests in this order when touching NATS/events:

1. **Envelope builders** — required fields, subjects, `type` / `service` / `entity_id` / `payload` shape (`chatbot-service/tests/test_event_envelope.py`, `api-gateway/internal/events/events_test.go` are the pattern).
2. **Orphan `file_id` SQL** (chatbot-service) — query returns only IDs not referenced in other conversations for the same `owner_id`; empty list when all files are shared.
3. **Idempotent file delete** (file-service) — consumer handler: already-deleted row → no-op + ack; wrong `owner_id` → skip; duplicate delivery safe.
4. **Query API routes** (event-store) — `app.inject` tests for list `order` and `GET /events/:id` when touching `src/routes/*.ts` (mock `queryEvents` / `queryDlqRecords`).

Specs for behavior: **`platform/chatbot-file-events.md`**. Do not assert JetStream broker state in unit tests.

## Conventions

- **Mock boundaries** — inject fakes for NATS publish, HTTP clients (file-service), and DB sessions; assert call args and return values, not side effects on a real broker.
- **No `.env` in tests** — use explicit fixtures or `monkeypatch` / env in test setup only.
- **Golden envelope snapshots** — optional JSON fixture files under `tests/fixtures/` when the same envelope is reused across tests.
- **Naming** — test names describe behavior: `test_conversation_deleted_envelope_shape`, `TestPublishAuthLoginSkipsRefresh`.
- **DLQ / outbox** — unit-test the *decision* (publish DLQ payload shape, outbox row insert); do not run `max_deliver` redelivery loops against a real server.

## CI

**bot-review** (PR gate): **`ci/bot-review-pipelines.md`**. Unit tests wired in bot-review YAML for chatbot-service (`pytest`), api-gateway (`go test ./... -count=1 -cover`), **`file-service`** / **`event-store`** (`vitest run --reporter=junit`). **Angular:** **`chatbot-frontend`** is the canonical Karma + JUnit + PR-comment template; **`shell-frontend`** and **`event-store-frontend`** mirror it. **Fastify:** **`file-service`** is the canonical Vitest template; **`event-store`** mirrors it. All seven active repos in **`ci/bot-review-pipelines.md`** (including **`event-store`**, **`event-store-frontend`**) have bot-review registered in ADO. See **`ci/bot-review-pipelines.md`** → **ADO registration (new repo)** for adding another service.

E2E on `int` remains future — **`testing/e2e-testing-strategy.md`**.

## Related rules

- **`always-apply/no-routine-unit-tests.md`** — agents run suites only on prepare-push or explicit request
- **`testing/e2e-testing-strategy.md`** — Playwright, `int`, nightly
- **`platform/event-store-architecture.md`** — standard envelope fields
- **`platform/chatbot-file-events.md`** — orphan-only delete, reconcile sentinel, consumer idempotency
- **`lang/lang-python-fastapi.md`**, **`lang/lang-go.md`**, **`lang/lang-typescript-fastify.md`** — idiomatic test style per language

## Test files are not typechecked by `tsc` (2026-09-06)

Every Fastify repo's `tsconfig.json` excludes `**/*.test.ts` so the build cannot emit tests into `dist/`. The cost is that **`tsc` never sees a test file**, and vitest transpiles with esbuild without typechecking — so a broken mock type is invisible until it happens to fail at runtime.

Each repo therefore carries **`tsconfig.test.json`** (extends the base, `noEmit`, no test exclusion) and a **`typecheck:test`** script, mirroring the frontends' `typecheck:e2e`. Introducing it found real errors in three of four repos: a metrics mock cast `as never` (which silently disables every property check), an argument-count mismatch against a plugin signature, and an unused import.

`prepare-push` runs it. The shared `stack-node-vitest` template does **not** yet — adding a step there means a new `platform-pipelines` tag plus an `ExtendsCheck` entry, which is a deliberate decision, not a drive-by.
