# Repo profiles for prepare-push

Paths are relative to **`datha_platform/`** workspace root. Each folder is its own git repo.

| Repo | Lang rule | Service / product rules | Unit test command (same as bot-review) |
|------|-----------|-------------------------|----------------------------------------|
| `api-gateway` | `lang/lang-go.md` | `services/api-gateway-architecture.md` | `gotestsum --format testname ./...` or `go test ./...` |
| `accounts-service` | `lang/lang-typescript-fastify.md` | `services/accounts-service-architecture.md`, `products/messenger-architecture.md` | `pnpm test` |
| `chatbot-service` | `lang/lang-python-fastapi.md` | `services/chatbot-service-architecture.md`, `products/chatbot-architecture.md`, `platform/chatbot-file-events.md` | `pytest` |
| `file-service` | `lang/lang-typescript-fastify.md` | `services/file-service-architecture.md`, `platform/chatbot-file-events.md`, `platform/platform-nats-architecture.md`, `platform/event-store-architecture.md` | `pnpm test` |
| `event-store` | `lang/lang-typescript-fastify.md` | `platform/event-store-architecture.md`, `platform/platform-nats-architecture.md` | `pnpm test` |
| `notification-service` | `lang/lang-typescript-fastify.md` | `platform/platform-notifications.md`, `platform/platform-nats-architecture.md`, `platform/event-store-architecture.md` | `pnpm test` |
| `chatbot-frontend` | `lang/lang-angular.md` | `services/chatbot-frontend-architecture.md`, `products/chatbot-architecture.md` | `pnpm test` |
| `shell-frontend` | `lang/lang-angular.md` | `services/shell-frontend-architecture.md` | same as chatbot-frontend |
| `event-store-frontend` | `lang/lang-angular.md` | `services/event-store-frontend-architecture.md`, `platform/event-store-architecture.md` | same as chatbot-frontend |
| `shared-frontend` | `lang/lang-angular.md` | `services/shared-frontend-architecture.md` | same as chatbot-frontend |
| `platform-nats` | `lang/lang-typescript-fastify.md` | `platform/platform-nats-architecture.md` | `pnpm reconcile` dry-check only if NATS up; no unit test suite — skip test run |
| `platform-observability` | — (yaml/alloy configs only) | `platform/platform-observability.md` | no unit tests — validate with `docker compose config -q` (needs docker up) |

**All five** Fastify repos — `accounts-service`, `event-store`, `file-service`, `notification-service` and **`messenger-service`** — also run **`pnpm typecheck:test`**. Their `tsconfig.json` excludes `**/*.test.ts` so `dist/` stays clean, which means **`tsc` never sees the tests and vitest only transpiles them** — the same blind spot the frontends fixed with `typecheck:e2e`. It found real errors in three of the four when it was introduced (2026-09-06).

⚠️ **The shared pipeline runs it now**, so skipping it here does not hide anything — it fails the PR instead. It did exactly that on !177 (2026-09-13): this list still said "four repos", `messenger-service` was not among them, so the check was not run, and a type error in two test fixtures reached the pipeline. `pnpm test` passing means nothing here — vitest transpiles without typechecking, and `tsc --noEmit` uses the *other* tsconfig. **Run all three: `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm typecheck:test`.**

All four Angular repos run karma headless through their own `test` script, byte-identical to the `stack-angular-karma` template default — so `pnpm test` is exactly what bot-review runs. `pnpm test:watch` is the interactive variant: never use it in a review, it never exits.

**Always load** (every repo): all files in `always-apply/`.

**When touched:** add `ci/bot-review-pipelines.md` if pipeline/YAML changed; add `testing/unit-testing-strategy.md` if tests changed.

**Cross-repo:** use **`reference/cross-repo-matrix.md`** when one or more repos are in scope (required for multi-repo runs).

## `platform-pipelines`

ADO YAML templates only — no app, no pipeline of its own, no unit tests. A change here is validated by expanding a **consumer** pipeline through the ADO preview API (`POST /_apis/pipelines/{id}/preview`) and diffing the expansion, then moving one repo's stub to the new tag as a canary. Never point a consumer at `main`. **Before any consumer moves to a new tag, add that tag's entries to the `ExtendsCheck` on the `platform-bot-review` variable group** — the secrets are gated on it, so a bump without it fails every pipeline (`.claude/docs/ci/bot-review-pipelines.md` § Required template check).
