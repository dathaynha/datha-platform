# Introduction 
TODO: Give a short introduction of your project. Let this section explain the objectives or the motivation behind this project. 

# Getting Started
TODO: Guide users through getting your code up and running on their own system. In this section you can talk about:
1.	Installation process
2.	Software dependencies
3.	Latest releases
4.	API references

# Build and Test

From this directory: `pnpm install`, then `pnpm test` — karma headless, one run, same command bot-review uses (`pnpm test:watch` for the interactive re-run mode). Use `pnpm start` for local dev when configured in `package.json`.

End-to-end: `pnpm e2e` runs the Playwright suite in `e2e/` (`e2e:ui`, `e2e:headed` for the other modes); the config starts or reuses the dev server itself. Auth is seeded and the gateway is route-mocked, so no backend is needed. `pnpm typecheck:e2e` typechecks the specs — Playwright itself never does. Shape and conventions: **`testing/e2e-testing-strategy.md`**.

## CI — bot review (pull requests)

PRs targeting `main` can use the **Bot Review** pipeline (`azure-pipelines/bot-review.yml`):

1. **Unit tests** — Karma headless; upserts a PR comment (`<!-- bot-review:unit-tests:shell-frontend -->`) and publishes JUnit to the Tests tab (required).
2. **MegaLinter** — JavaScript flavor; config in `.mega-linter.yml` (continues on error).
3. **PR-Agent** — Gemini review via `pragent/pr-agent` (continues on error).

**Azure DevOps setup (once per repo):**

- Create a pipeline pointing at `/azure-pipelines/bot-review.yml`, **PR trigger only** (`trigger: none` in YAML).
- Bot-review OAuth for PR comments: **`env: SYSTEM_ACCESSTOKEN: $(System.AccessToken)`** on upsert/MegaLinter steps in `azure-pipelines/bot-review.yml` (YAML pattern — not the Classic Agent-job checkbox).
- Link variable group secrets: **`GEMINI_KEY`**, **`ADO_PAT`** (same as other platform repos).

`.pr_agent.toml` on the default branch aligns model settings with the pipeline; merge config changes to `main` before expecting PR-Agent to pick them up.

# Contribute
TODO: Explain how other users and developers can contribute to make your code better. 

If you want to learn more about creating good readme files then refer the following [guidelines](https://docs.microsoft.com/en-us/azure/devops/repos/git/create-a-readme?view=azure-devops). You can also seek inspiration from the below readme files:
- [ASP.NET Core](https://github.com/aspnet/Home)
- [Visual Studio Code](https://github.com/Microsoft/vscode)
- [Chakra Core](https://github.com/Microsoft/ChakraCore)