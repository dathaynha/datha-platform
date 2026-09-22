# Workspace layout (read first)

_datha_platform workspace is NOT a monorepo — each service folder is its own ADO/git repo_

The folder **`datha_platform/`** on disk is a **local convenience workspace** that groups multiple products side by side. It is **not** a git monorepo and **not** an Azure DevOps repo.

## What is a repo vs what is not

| Path                                                                                                                                                                          | Git / ADO                | Notes                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| `api-gateway/`, `chatbot-service/`, `file-service/`, `chatbot-frontend/`, `shell-frontend/`, `event-store/`, `event-store-frontend/`, `shared-frontend/`, `platform-nats/`, … | **Each is its own repo** | Own `.git`, own ADO pipeline(s), own `azure-pipelines/` at **that folder’s root**                  |
| `platform-frontends-nx/`                                                                                                                                                      | **Own repo (sandbox)**   | Nx + MF experiment only — not production; see **`services/platform-frontends-nx-architecture.md`** |
| `datha_platform/` (workspace root)                                                                                                                                            | **Not a repo**           | No root `.git`, no root `azure-pipelines.yml`, no “deploy the monorepo”                            |

When the user says “the repo”, mean **the service folder you are editing** (e.g. `file-service/`), not `datha_platform/`.

## Implications for agents

- **Commits / PRs / pipelines:** scoped to **one service directory** unless the user explicitly names another repo.
- **Do not** assume a single root pipeline, root `package.json`, or shared CI for the whole workspace.
- **Do not** add deployable platform code outside an ADO service repo — e.g. JetStream topology belongs in **`platform-nats/`**, not in a personal-only folder.
- **Cross-service changes** may require coordinated PRs in multiple repos; call that out in summaries.

## Local development (each developer’s machine)

Not part of ADO repos. Each developer runs their own:

- **PostgreSQL** — app DBs (e.g. `chatbot_service`, `file_service_db`, `event_store_db` per service README / migrations).
- **Redis** — chatbot job queue (if using async chat).
- **NATS JetStream** — `NATS_URL` (e.g. `nats://localhost:4222`); then **`cd platform-nats && pnpm reconcile`** before starting consumers.

Do not assume a shared “workspace infra” folder path exists for all contributors.

### Node version (2026-09-04)

Every Node repo carries a **`.nvmrc`** and an **`engines.node`** range, and every
pipeline's `UseNode` / `NodeTool` version matches it — **Node 24 across all 8**.
`nvm use` in the repo picks the right one; pnpm prints `WARN Unsupported engine`
on a mismatch and installs anyway, so it is a signal, not a gate.

This matters beyond ergonomics: `@types/node` is pinned to the **same major as
the pipeline runtime** (see `testing/e2e-testing-strategy.md`), so a developer on
a newer Node writes against typings that CI's Node does not implement.

**History and next bump.** The first sweep (PRs 105-113) aligned everything on
Node **22**, taking the pipelines as the reference; `platform-nats` was the
outlier on Node 20, past EOL. Node 22 went maintenance-only in Oct 2025, so the
second sweep moved all 8 repos to **24** (Active LTS) plus `@types/node`
**24.13.3**. **Next: Node 26** when it becomes LTS (~Oct 2026) — 24 goes
maintenance at the same moment, so that bump is already expected; do it in one
wave the same way rather than trailing a version behind.

No dependency in any repo declares an upper Node bound — Angular 21 and
`ng-packagr` state `^20.19 || ^22.12 || >=24.0.0` explicitly, and the ADO agents
are `ubuntu-latest` (24.04, glibc 2.39 ≫ the 2.28 Node 24 needs).

Module Federation deserves its own note because a Node bump _looks_ risky there:
MF is a **build-time** webpack plugin, and NG0919 comes from host/remote shared
**dependency version** mismatch, not from the Node that ran the build — the Node
version is not in that equation. Verified anyway, end to end: both remotes emit
`remoteEntry.js` from a production build, and shell's `remotes.spec` loads each
one **hosted at runtime** through the host.

Validation for a Node bump, per repo type: prod build + karma for the frontends,
`ng-packagr` build for the lib, `vitest` for the Fastify services, and for
`platform-nats` a real `pnpm reconcile` against local NATS (exit 0, both streams,
all 5 durables, message counts intact) — **that reconcile run is the only real
check that repo has**, it has no unit tests.

## Platform-wide NATS JetStream topology

Shared streams/consumers are **not** created on app startup.

- **Source of truth:** **`platform-nats/`** ADO repo — see **`platform/platform-nats-architecture.md`** (`topology.ts`, `max-deliver.ts`, `pnpm reconcile`).
- **`max_deliver`:** broker config in platform-nats; per-durable env names for any service with app-side DLQ (see **platform/platform-nats-architecture.md**).
- **Prod:** **platform-nats** ADO pipeline runs reconcile after NATS is up, **before** event-store / file-service / chatbot rollouts.
- **Other services:** connect only; durable **name constants** in each `src/nats/streams.ts`. App-side DLQ uses **per-durable** env vars (see **platform/platform-nats-architecture.md**), not a generic `NATS_CONSUMER_MAX_DELIVER` in every repo.

## Docs layout (`.claude/docs/`)

| Folder              | Purpose                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **`always-apply/`** | Global rules, summarized in `.claude/rules/critical-behaviors.md` — workspace layout, env safety, dev-server policy, no routine unit test runs |
| **`lang/`**         | Language / framework conventions (TypeScript, Go, Python, Angular)                                                                             |
| **`platform/`**     | Shared infra — NATS topology, event-store, cross-service event choreography                                                                    |
| **`services/`**     | One deployable repo ≈ one rule (api-gateway, file-service, chatbot-service, …)                                                                 |
| **`products/`**     | Cross-repo product flows (chatbot, interview-prep)                                                                                              |
| **`testing/`**      | Test strategy — **`testing/unit-testing-strategy.md`**, **`testing/e2e-testing-strategy.md`**                                                  |
| **`ci/`**           | Pipeline / bot-review automation                                                                                                               |

## Related rules

- **`ci/bot-review-pipelines.md`** — MegaLinter / PR-Agent per service repo
- **`platform/chatbot-file-events.md`** — conversation delete → file cleanup choreography
- **`platform/event-store-architecture.md`** — envelope, `EVENTS` / `DLQ`, ingest, DLQ API
- **`platform/platform-nats-architecture.md`** — topology, reconcile, deploy order, prod NATS (future)
- **`services/shared-frontend-architecture.md`** — npm shared UI (`@datha/platform-ui`), preset + SCSS + wrappers
- **`services/platform-frontends-nx-architecture.md`** — optional Nx monorepo sandbox (non-prod)
