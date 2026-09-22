# Repo → rules map (rule-doctor)

Paths relative to **`datha_platform/`**. Load **all** listed rules for the repo, plus **`always-apply/`** when checking global constraints (env, workspace layout).

| Repo | Rules to compare against repo |
|------|--------------------------------|
| `api-gateway` | `services/api-gateway-architecture.md`, `lang/lang-go.md` |
| `chatbot-service` | `services/chatbot-service-architecture.md`, `products/chatbot-architecture.md`, `platform/chatbot-file-events.md`, `lang/lang-python-fastapi.md` |
| `file-service` | `services/file-service-architecture.md`, `platform/chatbot-file-events.md`, `platform/platform-nats-architecture.md`, `platform/event-store-architecture.md`, `lang/lang-typescript-fastify.md` |
| `event-store` | `platform/event-store-architecture.md`, `platform/platform-nats-architecture.md`, `lang/lang-typescript-fastify.md` |
| `chatbot-frontend` | `services/chatbot-frontend-architecture.md`, `products/chatbot-architecture.md`, `lang/lang-angular.md` |
| `shell-frontend` | `services/shell-frontend-architecture.md`, `lang/lang-angular.md` |
| `event-store-frontend` | `services/event-store-frontend-architecture.md`, `platform/event-store-architecture.md`, `lang/lang-angular.md` |
| `platform-nats` | `platform/platform-nats-architecture.md`, `lang/lang-typescript-fastify.md` |

**Also compare when relevant:**

| Trigger | Add rule |
|---------|----------|
| `azure-pipelines/bot-review.yml` exists | `ci/bot-review-pipelines.md` |
| `**/test/**`, `*.test.*`, `*_test.go`, `pytest` | `testing/unit-testing-strategy.md` |
| `e2e/`, Playwright config | `testing/e2e-testing-strategy.md` |
| User names product flow | `products/interview-prep-architecture.md`, etc. |

If repo folder **missing** on disk → report **RULE AHEAD** / **REPO ABSENT**; still audit rule internal consistency.

**Planned repos:** `interview-prep-service` (API + worker in one repo, two processes) and `interview-prep-frontend` use `services/interview-prep-service-architecture.md`, `services/interview-prep-frontend-architecture.md` + `products/interview-prep-architecture.md` (not separate rows until repos exist in workspace).

**Domain (whole product):** **`domain-profiles.md`** — expands to many repos + `cross-rules.md`.

**Cross-repo matrix:** align with **`prepare-push/reference/cross-repo-matrix.md`** for NATS/MFE/gateway checks during domain runs.
