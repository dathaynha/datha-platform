# No routine unit test runs (agents)

_Do not run unit test suites after routine edits — only prepare-push or explicit request (all ADO repos)_

Applies to **every service repo** in this workspace (`api-gateway/`, `chatbot-service/`, `*-frontend/`, `event-store/`, …).

## Do not run after normal edits

Do **not** run full unit test suites at the end of implementation tasks:

- Angular: `ng test`
- Node: `vitest run`, `pnpm test`
- Python: `pytest`
- Go: `go test ./...`

Adding or fixing a `*.spec.ts` / `*_test.go` / `test_*.py` file does **not** by itself require running the suite.

## When to run tests

Run the repo’s unit test command **only** when:

1. The user asks for **prepare-push** / pre-push review — use the **`prepare-push`** skill (lint + tests per **`prepare-push/reference/repos.md`**).
2. The user **explicitly** asks to run tests (e.g. “run pytest”, “fix failing tests”).

## Not affected

- **CI / bot-review** on PR still runs tests — see **`ci/bot-review-pipelines.md`**.
- **Writing** tests when requested or when they add meaningful coverage is fine; just don’t auto-run the full suite unless one of the triggers above applies.
