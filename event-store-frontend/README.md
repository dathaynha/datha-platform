# event-store-frontend

Angular 21 Module Federation remote for platform event-store operations — **Overview**, **Events** (list + detail), **DLQ** (list + detail + replay). Runs standalone on port **4002** or inside **shell-frontend** at `/event-store`.

## Development

From this directory:

```bash
pnpm install
pnpm start
```

Dev server: **http://localhost:4002** (`package.json` / `angular.json`).

**Auth:** Google and Microsoft Entra via **api-gateway** token proxy (`/auth/google/token`, `/auth/entra/token`). Register OAuth redirect URIs for `http://localhost:4002`. Copy `src/environments/environment.ts` → `environment.dev.ts` and set client IDs (same pattern as chatbot-frontend).

**API:** `environment.gateway.baseUrl` → `http://localhost:8080/api/event-store` (gateway strips `/api/event-store` to event-store service).

**Backend note:** after pulling event-store route changes, run `pnpm build` in `event-store/` and restart if using `pnpm start` (stale `dist/` → e.g. `GET /events/:id` 404). Prefer `pnpm dev` (tsx watch) for local backend work.

**Shell (optional):** start shell on **4000**, this remote on **4002**, register manifest entry `event-store` → `http://localhost:4002/remoteEntry.js`.

## Module layout

Feature folders per **`services/platform-frontend-conventions.md`**:

```
src/modules/
  events/   events.routes.ts + pages/list|detail/
  dlq/      dlq.routes.ts + pages/list|detail/
  shared/   authenticated-layout, table-empty-state
```

## Build

```bash
pnpm build
```

Artifacts: `dist/event-store-frontend/`.

Module Federation public path override for non-local deploys:

```bash
MF_EVENT_STORE_PUBLIC_PATH=https://event-store.example.com/ pnpm build:prod
```

## Tests

```bash
pnpm test            # Karma unit specs, headless single run (same as bot-review)
pnpm test:watch      # the interactive re-run mode
pnpm e2e             # Playwright suite (e2e/), starts/reuses the dev server
pnpm typecheck:e2e   # Playwright transpiles with esbuild and never checks types
```

E2E auth is seeded and the gateway is route-mocked, so no backend is needed.
Shape and conventions: **`testing/e2e-testing-strategy.md`**.

## CI — bot review

PRs targeting `main`: `azure-pipelines/bot-review.yml` — Karma + Playwright (required), MegaLinter, PR-Agent. See **`ci/bot-review-pipelines.md`**.

## Cursor / architecture

- **`services/event-store-frontend-architecture.md`** — MF remote, auth, routing, features
- **`services/platform-frontend-conventions.md`** — feature folder scaffold
- **`platform/event-store-architecture.md`** — backend API this UI calls
