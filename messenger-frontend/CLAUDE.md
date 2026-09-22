# AI context — `messenger-frontend`

Messenger product UI — chat, presence and (later) WebRTC calling. Module Federation remote for **shell-frontend**, exposing two modules: the routed product at `/messenger` and the **header widget** the shell renders in its top bar.

**Rules (workspace `.claude/docs/`):**

- **`products/messenger-architecture.md`** — product shape, transport, phases, security rules
- **`services/shell-frontend-architecture.md`** — header widget slots, `SHELL_CONTEXT`, host manifest
- **`services/realtime-service-architecture.md`** — the WebSocket this UI will hold (phase 1)
- **`lang/lang-angular.md`** — Angular conventions
