# DataAnalysis

This project was generated with [Angular CLI](https://github.com/angular/angular-cli) version 16.1.5.

## Development server

From this directory: `pnpm install`, then `pnpm start` (or `pnpm exec ng serve`). Port **4001** is set in `package.json`. If you use **Corepack** with Node, you can run `corepack enable` once so the version in `packageManager` matches CI; otherwise any recent **pnpm** on your PATH is fine. The dev server reloads when you change source files.

## Code scaffolding

Run `ng generate component component-name` to generate a new component. You can also use `ng generate directive|pipe|service|class|guard|interface|enum|module`.

## Build

Run `ng build` to build the project. The build artifacts will be stored in the `dist/` directory.

## Running unit tests

Run `pnpm test` to execute the unit tests via [Karma](https://karma-runner.github.io) — headless, one run, the same command bot-review uses. `pnpm test:watch` is the interactive re-run mode.

## CI — bot review (pull requests)

PRs targeting `main` can use the **Bot Review** pipeline (`azure-pipelines/bot-review.yml`):

1. **Unit tests** — Karma headless; upserts a PR comment (`<!-- bot-review:unit-tests:chatbot-frontend -->`) and publishes JUnit to the Tests tab (required).
2. **MegaLinter** — JavaScript flavor; config in `.mega-linter.yml` (continues on error).
3. **PR-Agent** — Gemini review via `pragent/pr-agent` (continues on error).

**Azure DevOps setup (once per repo):**

- Create a pipeline pointing at `/azure-pipelines/bot-review.yml`, **PR trigger only** (`trigger: none` in YAML).
- Bot-review OAuth for PR comments: **`env: SYSTEM_ACCESSTOKEN: $(System.AccessToken)`** on upsert/MegaLinter steps in `azure-pipelines/bot-review.yml` (YAML pattern — not the Classic Agent-job checkbox).
- Link variable group secrets: **`GEMINI_KEY`**, **`ADO_PAT`** (same as other platform repos).

`.pr_agent.toml` on the default branch aligns model settings with the pipeline; merge config changes to `main` before expecting PR-Agent to pick them up.

## Running end-to-end tests

Playwright, in `e2e/`. `pnpm e2e` runs the suite headless (`e2e:ui` for UI mode,
`e2e:headed` for a visible browser); the config starts or reuses the dev server
itself. Auth is seeded and the gateway is route-mocked, so no backend is needed.
`pnpm typecheck:e2e` typechecks the specs — Playwright itself never does.

Shape and conventions: `.claude/docs/testing/e2e-testing-strategy.md`.

## Further help

To get more help on the Angular CLI use `ng help` or go check out the [Angular CLI Overview and Command Reference](https://angular.io/cli) page.
