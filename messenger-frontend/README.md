# messenger-frontend

Angular 21 Module Federation remote for the platform **Messenger** product — chat, presence and WebRTC calling. Runs standalone on port **4003** or inside **shell-frontend** at `/messenger`.

Phase 0: the **Overview** page documents the stack with two interactive flow diagrams (sending a message, placing a call), the Chats feature renders its empty states, and the header widget renders its icon plus an empty popover. Conversations, presence and calling arrive with `messenger-service` and `realtime-service` — see **`products/messenger-architecture.md`**.

## Two federated modules

| Expose | Entry | Rendered by |
|---|---|---|
| `./Module` | `src/remote-entry.ts` | shell route `/messenger` |
| `./HeaderWidget` | `src/header-widget-entry.ts` | shell header slot, from `environment.headerWidgets` |

The widget is **default-exported** — that is the shell's contract, so onboarding a widget stays config-only. It is loaded outside this remote's routes, so it registers its own `MESSENGER.*` translations and must work with nothing else of this remote mounted.

Messenger carries **both** a header widget and a normal launcher tile: the slot exists for the ambient half (socket, badge, ringing on every page), the tile because `/messenger` is a real destination.

## Development

From this directory:

```bash
pnpm install
pnpm start
```

Dev server: **http://localhost:4003** (`package.json` / `angular.json`).

**Auth:** Google and Microsoft Entra via **api-gateway** token proxy (`/auth/google/token`, `/auth/entra/token`). Register OAuth redirect URIs for `http://localhost:4003`. Copy `src/environments/environment.ts` → `environment.dev.ts` and set client IDs (same pattern as the other remotes).

**API:** `environment.gateway.baseUrl` → `http://localhost:8080/api/messenger` (gateway strips `/api/messenger` before forwarding to `messenger-service`, phase 1).

**Shell:** start shell on **4000**, this remote on **4003**. The shell already carries the manifest entry `messenger` → `http://localhost:4003/remoteEntry.js` and the `headerWidgets` entry. With this remote stopped the shell logs a warning and renders no widget — that degradation is covered by the shell's own specs.

## Module layout

Feature folders per **`services/platform-frontend-conventions.md`**:

```
src/modules/
  home-page/      Overview — stack cards + message/call flow diagrams
  chats/          chats.routes.ts + pages/list/
  header-widget/  the shell header icon + popover
  shared/         authenticated-layout, unauthenticated-layout
```

## Build

```bash
pnpm build
```

Artifacts: `dist/messenger-frontend/`.

Module Federation public path override for non-local deploys:

```bash
MF_MESSENGER_PUBLIC_PATH=https://messenger.example.com/ pnpm build:prod
```

**`pnpm start` needs it too whenever the remote is reached from another
device.** It defaults to `http://localhost:4003/`, and that address is baked
into every lazy chunk request — so `remoteEntry.js` loads from wherever the
shell was told, and everything after it is fetched from *the viewer's own
machine*. On the dev machine that happens to be the dev server, so it passes;
from a phone or a second laptop nothing loads, and from an `https://` origin it
is blocked as mixed content as well. Found on 2026-09-13 by the first
two-machine test:

```bash
MF_MESSENGER_PUBLIC_PATH=https://<tunnel-host>/ pnpm start
```

## Tests

```bash
pnpm test            # Karma unit specs, headless single run (same as bot-review)
pnpm test:watch      # the interactive re-run mode
pnpm e2e             # Playwright suite (e2e/), starts/reuses the dev server
pnpm typecheck:e2e   # Playwright transpiles with esbuild and never checks types
```

E2E auth is seeded and never clicked, so no backend is needed. Shape and conventions: **`testing/e2e-testing-strategy.md`**.

## CI — bot review

PRs targeting `main`: `azure-pipelines/bot-review.yml` — Karma + Playwright (required), MegaLinter, PR-Agent. See **`ci/bot-review-pipelines.md`**.

## Architecture

- **`products/messenger-architecture.md`** — product plan, transport, phases
- **`services/shell-frontend-architecture.md`** — header widget slots and `SHELL_CONTEXT`
- **`services/platform-frontend-conventions.md`** — feature folder scaffold
