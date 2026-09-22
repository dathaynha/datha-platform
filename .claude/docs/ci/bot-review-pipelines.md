# Bot Review Pipelines

_Bot review pipeline setup — MegaLinter + PR-Agent decisions per service_

**Workspace / multi-repo layout:** see **`always-apply/workspace-layout.md`** (always applied).

## Setup

Each service owns its pipeline at `azure-pipelines/bot-review.yml` (repo root relative).
When registering in ADO, the YAML path is `/azure-pipelines/bot-review.yml` — no service prefix.
Register each file as a separate ADO pipeline with **PR trigger only** (`trigger: none`).

**ADO status:** all seven active repos below have **`azure-pipelines/bot-review.yml`** on **main** and a matching pipeline registered in ADO (**`file-service`**, **`event-store`**, and **`event-store-frontend`** registered 2026). Use **ADO registration (new repo)** when adding another service.

**Unit tests (backend):** run **`pytest`** (chatbot-service), **`gotestsum` + `go test`** (api-gateway), or **`pnpm exec vitest run --reporter=junit`** (**`file-service`**, **`event-store`**) as a **required** step (no `continueOnError`). MegaLinter and PR-Agent follow with `continueOnError: true` unless you tighten policy later.

## Angular frontends — canonical template: `chatbot-frontend`

**`chatbot-frontend`** is the reviewed, working bot-review setup. **`shell-frontend`** (and any new Angular repo) should **match it** — copy `azure-pipelines/bot-review.yml`, `.mega-linter.yml`, `.pr_agent.toml`, and the Karma JUnit pattern in `karma.conf.js`, then replace only:

| Replace                    | Example (`shell-frontend`)                       |
| -------------------------- | ------------------------------------------------ |
| Job / display name         | `Bot Review — shell-frontend`                    |
| Unit-test marker           | `<!-- bot-review:unit-tests:shell-frontend -->`  |
| PR-Agent marker            | `<!-- bot-review:pr-agent:shell-frontend -->`    |
| Comment titles             | `… (shell-frontend)`                             |
| `PublishTestResults` title | `Karma unit tests (shell-frontend)`              |
| Karma coverage dir         | `./coverage/shell-frontend` (in `karma.conf.js`) |

Do **not** reinvent the bash upsert logic per repo — drift breaks shared mitigations (rawfile jq, OAuth hygiene) and invites real bugs or spurious PR-Agent noise.

**Frontend unit-test step (required):** `UseNode@1` → `pnpm install --frozen-lockfile` → `pnpm exec ng test --no-watch --browsers=ChromeHeadless --no-progress` with `JUNIT_OUTPUT_DIR=$(Agent.TempDirectory)` → **`PublishTestResults@2`** on `junit.xml`.

**PR comment upsert (frontends + api-gateway):** hidden marker `<!-- bot-review:unit-tests:{service} -->` → list threads → **PATCH** or **POST**. Requires step **`env: SYSTEM_ACCESSTOKEN: $(System.AccessToken)`** (YAML OAuth enable — not the Classic Agent-job checkbox) and **`$(System.TeamProjectId)`** in REST URLs (not project name with spaces).

**Bash conventions (all upsert scripts):**

- **jq thread lookup:** `select(.content | strings | contains($m))` — not bare `contains($m)` on `.content` (null/deleted ADO comments).
- **Log/summary in comments:** write to temp files; pass to **`jq --rawfile`** (not **`--arg "$(tail …)"`** — shell expands log text before jq sees it). Markers in jq filters are **fixed strings**, not test output.
- **`grep … | tail` inside `$(...)`:** append **`|| true`** under `set -euo pipefail` when tests passed.
- **Upsert functions:** `curl` / `jq` use **`|| return 1`**; success `echo` only after write succeeds; call **`if ! upsert_…; then echo ##[warning]…; fi`** — not **`upsert_… || echo`** (`set -e` is off inside functions called from `||`).
- **Secrets in logs:** never **`echo "$SYSTEM_ACCESSTOKEN"`** or **`set -x`** on upsert steps; use **`curl -fsS`** only (not **`-v`** / **`--trace`**). Debug lines may print `set` / `missing` only (see api-gateway MegaLinter debug), never the token value.

**api-gateway** uses the same upsert/bash rules; see **api-gateway** row below for Go-specific install and JUnit from `gotestsum`.

## Fastify backends — canonical template: `file-service`

**`file-service`** is the reviewed bot-review setup for **Node.js + TypeScript + Fastify + Vitest** services. **`event-store`** (and any future Fastify repo) should **match it** — copy `azure-pipelines/bot-review.yml`, `.mega-linter.yml`, `.pr_agent.toml`, then replace only:

| Replace                    | Example (`event-store`)                      |
| -------------------------- | -------------------------------------------- |
| Job / display name         | `Bot Review — event-store`                   |
| Unit-test marker           | `<!-- bot-review:unit-tests:event-store -->` |
| PR-Agent marker            | `<!-- bot-review:pr-agent:event-store -->`   |
| Comment titles             | `… (event-store)`                            |
| `PublishTestResults` title | `Vitest unit tests (event-store)`            |

Do **not** reinvent the bash upsert logic per repo — same drift risk as Angular frontends (see **PR-Agent false positives**).

**Fastify unit-test step (required):** `UseNode@1` (24.x) → `corepack prepare pnpm@10.33.2 --activate` → `pnpm install --frozen-lockfile` → `pnpm exec vitest run --reporter=default --reporter=junit --outputFile=$(Agent.TempDirectory)/junit.xml` ( **`default`** keeps stdout summary lines; **`junit`** alone only prints `JUNIT report written to …`) → **`PublishTestResults@2`**. PR comment summary greps Vitest lines (`Test Files`, `Tests`, `passed`, `Duration`).

**api-gateway Go install:** `GoTool@0` input is **`version`** with an exact semver (currently `1.25` — match **`go.mod`**, **not** `1.25.x` or `versionSpec`). Wrong/missing key falls back to Go **1.10** → `go: unknown subcommand "mod"`. **`.mega-linter.yml`:** disable `REPOSITORY_GRYPE` / `REPOSITORY_TRIVY` / `COPYPASTE_JSCPD` / **`GO_REVIVE`** (golangci-lint is the Go gate; revive `enableAllRules` is too noisy). Do **not** put invalid linter names in `DISABLE_LINTERS`.

**OAuth in YAML:** each step that calls the PR REST API or MegaLinter’s Azure reporter maps **`SYSTEM_ACCESSTOKEN: $(System.AccessToken)`** in **`env:`** — that is how YAML pipelines expose the job token ([Microsoft docs](https://learn.microsoft.com/en-us/azure/devops/pipelines/build/variables?view=azure-devops)). The Classic **“Allow scripts to access the OAuth token”** checkbox applies to **designer/classic Agent jobs**, not this pattern. Ensure **Project Collection Build Service** can contribute on the repo (PR threads) and keep project **Limit job authorization scope** / **Protect access to repositories in YAML pipelines** enabled.

## Tiered approach

Active bot-review repos (both MegaLinter + PR-Agent in `azure-pipelines/bot-review.yml`):

| Service                | MegaLinter | PR-Agent (AI) | Notes                                                               |
| ---------------------- | ---------- | ------------- | ------------------------------------------------------------------- |
| `api-gateway`          | ✅         | ✅            |                                                                     |
| `chatbot-service`      | ✅         | ✅            | Python: black + isort (`pyproject.toml`)                            |
| `chatbot-frontend`     | ✅         | ✅            | **Canonical** Angular bot-review template                           |
| `shell-frontend`       | ✅         | ✅            | Mirror **`chatbot-frontend`** (markers/titles only)                 |
| `file-service`         | ✅         | ✅            | **Canonical** Fastify/Vitest template; ADO registered               |
| `event-store`          | ✅         | ✅            | Mirror **`file-service`** (markers/titles only); ADO registered     |
| `event-store-frontend` | ✅         | ✅            | Mirror **`chatbot-frontend`** (markers/titles only); ADO registered |

## ADO registration (new repo)

Everything a freshly created repo needs before its first PR behaves like the others. Steps 1-4 are scriptable; **step 5 is the one that gets skipped, and it is UI-only.**

1. **Repo + first push.** `az repos create --name <repo>`, then push `main` (it becomes `refs/heads/main`, which the policies below bind to). The stub `azure-pipelines/bot-review.yml` must be in that first push.
2. **Pipeline.** `az pipelines create --name '<repo> — Bot Review' --repository <repo> --repository-type tfsgit --branch main --yml-path azure-pipelines/bot-review.yml --skip-first-run true`. The `<repo> — Bot Review` name is what the policies and the pipelines tab expect.
3. **Variable group.** Authorize the new pipeline on `platform-bot-review`: PATCH `pipelinePermissions` (`resourceType=variablegroup`, `resourceId=1`) with `{"pipelines":[{"id":<pipelineId>,"authorized":true}]}`. Without it the Key Vault secrets never download. Secrets come from the Key Vault-linked group (vault **`dathq-platform-kv`** via service connection **`azure-dathq-platform`**); YAML declares `variables: - group: platform-bot-review` and maps env from `$(bot-review-gemini-key)` / `$(bot-review-ado-pat)`. Never paste secret values as pipeline UI variables — that pattern was fully retired 2026-07-27.
4. **Branch policies on `main`.** Clone a sibling's configuration rather than hand-building it: `az repos policy list --repository-id <sibling> --branch main`, swap `repositoryId` and `buildDefinitionId`, then `az repos policy create --policy-configuration <file>`. Two policies — **Build** (blocking, `queueOnSourceUpdateOnly: false`, `validDuration: 0`; that pair is what gives the free auto-requeue of a non-green run) and **Required reviewers** (blocking, `minimumApproverCount: 1`, `creatorVoteCounts: true`).
5. **Grant the build service `Contribute to pull requests` on the repo.** *Repository settings → Security → `<Project> Build Service (<org>)` → Contribute to pull requests = Allow.*

   Skipped on `accounts-service` (2026-09-06) and the first PR failed with `TF401027: You need the Git 'PullRequestContribute' permission … identity 'Build\<projectId>'`. It takes out **MegaLinter** (its Azure comment reporter writes with `SYSTEM_ACCESSTOKEN`) and the **PR-Agent failure-comment upsert** (`curl: (22) 403` → `##[warning]Failed to upsert PR-Agent failure PR comment`). PR-Agent's own review still posts, because it authenticates with `ADO_PAT` — so the PR looks half-working and the comments alone do not point at permissions.

   **`az devops security permission list` is not an oracle for this.** It reports `allow 0` for repos where the permission demonstrably works, because it lists explicit ACEs without resolving inheritance. Do not conclude anything from it in either direction — a real PR run is the only proof.

Needing no action: the **service connection** (`azure-dathq-platform` is `allPipelines.authorized`), the **template repo** (same-project resources are auto-authorized — there is no "grant permission" prompt, despite the folklore), and the **`ExtendsCheck`** on the variable group (it gates on template + ref, not on pipeline identity, so a new consumer extending an already-approved tag passes untouched).

Verify with a manual run on `main`: secrets and PR-Agent are correctly **skipped** there because it is not a PR, so that run proves the toolchain but not the comment path. Only the first real PR proves step 5.

**Worked example — `messenger-frontend`, 2026-09-06** (all five steps done the same day): repo id `17e33439-f063-499d-b06d-dfd22bb05751`, pipeline **id 14** (`messenger-frontend — Bot Review`), variable-group authorisation PATCHed for pipeline 14, branch policies **29** (Build) and **30** (Required reviewers) cloned from `event-store-frontend`, and dathq granted *Contribute to pull requests* himself. Two details that cost time: `az devops invoke` needs `--api-version 7.1-preview` (with `7.1-preview.1` az dies on `could not convert string to float: '7.1.1'`), and the scaffold went to `main` **without `src/`** so the first PR carries the application code and bot review actually has something to review.

**Worked example — `messenger-service` + `realtime-service`, 2026-09-08** (steps 1-4 scripted in one pass; step 5 left to dathq): repo ids `3998d35d-bc1a-46c9-a1e1-2d8a87f21741` and `2ff104d5-51a2-4285-8889-cbbe196ecd72`, pipelines **15** and **16**, variable-group authorisation PATCHed for both, branch policies **31/32** and **33/34** cloned from `file-service` (policies 5 + 11). Three things worth reusing:

- **`az devops` authenticates off `az login` here** — `az devops project list` worked with no PAT and no `AZURE_DEVOPS_EXT_PAT`, so the whole checklist is scriptable without going near a token.
- **The variable-group PATCH is additive.** Send only the new pipeline ids; existing authorisations survive. Verify with a `GET` of the same route afterwards, because the PATCH returns nothing useful.
- **Do not do the "manual run on `main`" verification when `main` is scaffold-only.** Both these repos followed the `messenger-frontend` pattern (scaffold on `main`, application code on `feat/…` so bot review has something to review), and a scaffold-only `main` has no test files — the template's *required* unit-test step would fail, painting a red run in the pipelines tab for no reason. The first PR is the verification.

Also: for a Go repo, `vendor/` stays **untracked** (matching `api-gateway`); the pipeline restores it, and `go mod vendor` regenerates it locally. And commit with the repo's own identity — a `git -c user.name=…` override on the first commit produced an author that matched no other repo and had to be `--amend --reset-author`ed before the push.

**`az repos pr update` does not accept `--project`** — it takes `--id` and `--org` only, and passing the project fails with an unhelpful `unrecognized arguments`. It is also fine to pass a whole markdown file to `--description "$(cat file)"`, despite the help text describing one value per line.

Cross-refs: **`services/file-service-architecture.md`**, **`platform/event-store-architecture.md`**, **`platform/platform-nats-architecture.md`**.

## The agent image is pinned, and why (2026-09-20)

Every pipeline pins **`vmImage: ubuntu-24.04`**. It used to say `ubuntu-latest`,
which on 2026-09-20 began emitting:

```
##[warning]Remote machine provider issue: "The ubuntu-latest label will migrate
to Ubuntu 26 beginning October 19, 2026."
```

That warning yellows a run, which on the pipelines tab is the signal that a
check did not do its job — so it costs a trip into the PR to discover it is
nothing. `ubuntu-latest` already resolved to 24.04, so the pin is a
**zero-behaviour-change edit today**; what it buys is that the migration
happens on a date someone chooses rather than on 19 October, three and a half
weeks after dathq stops working from the machine this was all set up on.

**Where it lives: the consuming repo, always.** `platform-pipelines`'
templates declare **no pool at all** — each repo's own `bot-review.yml` (and
`shared-frontend/release.yml`, `platform-nats/jetstream-reconcile.yml`) owns
`pool: vmImage:`. So this took **15 one-line edits across 14 repos and no
template change, no new tag and no `ExtendsCheck` entry**. Same shape as the
`testCommand` override that fixed !188: check whether the knob is already a
consumer-side one before reaching for a template change.

**What the image actually has to supply is small**, which is why the pin is
low-risk: Node comes from `UseNode@1`, Python from `UsePythonVersion@0`, Go
from `GoTool@0`, and MegaLinter and PR-Agent both run in Docker.

⚠️ **The exception, and the reason not to let the label drift:**
`stack-angular-karma.yml` runs `--browsers=ChromeHeadless` with **no
`CHROME_BIN` and no puppeteer install**, so karma uses whatever Chrome the
image happens to ship. Five repos rest on that — `shell-frontend`,
`chatbot-frontend`, `event-store-frontend`, `messenger-frontend`,
`shared-frontend`. An image migration that moves or drops Chrome fails those as
a **red**, not a warning, and it would have done so unattended. Declaring the
browser explicitly is the real fix and is **not done** — it touches
`platform-pipelines`, so it needs a new tag plus an `ExtendsCheck` entry. Worth
doing before 24.04 itself retires.

**This pin has an expiry.** It buys a chosen date, not immunity: when 24.04 is
retired the same warning returns wearing a different number. The durable fix is
the Chrome declaration above, after which the label can float again.

## Shared pipeline templates — `platform-pipelines` (2026-09-04)

The job body of every `bot-review.yml` lives in the **`platform-pipelines`** ADO
repo. Consumers keep their own `azure-pipelines/bot-review.yml` as a ~20-line
stub that carries the triggers and parameters and `extends` a stack template.

**Why:** the pipeline was copy-pasted into 9 repos and several were _byte-identical_
apart from the service name (~2,700 duplicated lines). That is what let
`pragent/pr-agent:latest` sit unpinned in **all nine** until a newer image began
publishing its own un-deduped failure comment — one PR collected **13**
`Failed to review PR` threads. One bug, nine places to fix it.

**Two rules that are not negotiable:**

1. **Keep the stub at the same path.** `main`'s build-validation policy references
   the pipeline's **definition ID**; deleting and re-creating a pipeline mints a
   new ID and silently drops that blocking check. Only the file contents change —
   never the registration.
2. **Pin `ref: refs/tags/vN`**, never the template repo's `main`. Otherwise one
   template edit changes every pipeline at once with no review — the same mistake
   as a floating container tag.

**Stacks are split by job shape — toolchain + test runner + result format — not
by language**, which is why two Node stacks exist: `stack-node-vitest` and
`stack-angular-karma` share a language and nothing else. Names state the
contract, so a second Go or Node repo points at the right stack without
guessing:

| Stack                 | Consumers                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `stack-node-vitest`   | `event-store`, `file-service`, `notification-service`                                          |
| `stack-angular-karma` | `shell-frontend`, `chatbot-frontend`, `event-store-frontend`, `shared-frontend` (`e2e: false`) |
| `stack-python-pytest` | `chatbot-service`                                                                              |
| `stack-go-gotestsum`  | `api-gateway`                                                                                  |

Extension is via `preSteps` / `extraSteps` (`stepList`) plus two general hooks —
`summaryExtraShell` (append a footer to the test summary, e.g. Go coverage) and
`extraDockerEnv` (extra `docker run` flags for MegaLinter, e.g.
`GOTOOLCHAIN=auto`). Rule: parameters for values, separate templates for shapes,
step hooks for additions — never twenty booleans. **Never leave a stack with no
consumer**: an unextended template is dead config that has never been validated,
the same rot the knip gate exists to catch.

**PR-Agent failure policy** (v4): **every** failure exits non-zero, so the run
goes yellow. That is deliberate — the pipelines tab is the monitoring surface and
yellow is what says "this PR was not reviewed"; a green run on an external outage
would hide it and force a trip into each PR (`.claude/rules/working-agreement.md`
§ PR hygiene). The classification (geo / quota / 5xx / actionable) shapes the PR
comment's wording and decides what gets retried — 5xx retries 3x with backoff,
geo and quota do not, since geo is fixed for the agent's egress IP and a quota
window outlives the job. Note `##[warning]` is a logging command: emitting one
marks the task `succeededWithIssues` by itself.

**How to verify a template change** — consumers' PRs cannot validate it, so:
expand old and new through `POST /_apis/pipelines/{id}/preview?api-version=7.1`
with a `yamlOverride`, then compare step counts, script-block counts and the
script bodies, and run `bash -n` over each extracted block. That diff caught
three regressions in the first draft (a dropped `junit.xml` summary fallback, a
shortened PR-Agent log tail, a lost MegaLinter explainer) and the four
`api-gateway` behaviours that made it a deferral rather than a conversion.

### The PR comment contract (settled 2026-09-05, `v6` + `v7`)

**One marker thread per check, both outcomes written to it.** `unit-tests.yml`
always worked this way; the PR-Agent step now does too:

| Outcome | Marker thread |
| --- | --- |
| fails | classified `❌` + reason + log tail, thread reopened (`active`) |
| passes | PATCHed to `✅ Reviewed`, thread `fixed` |
| passes, no thread yet | nothing posted — PR-Agent publishes the review itself |

Two defects got it here, both fixed and both verified on live runs:

**1. The tool's own un-deduped comment (`v6`).** The container published a bare
`Failed to review PR` thread per failed run — no marker, no upsert, 13 on one PR.
Fixed with `-e config__is_auto_command=true`, which is the tool's own switch:
`pr_reviewer.py` publishes that comment only when the flag is false, and every
automated entry point it ships (Action runner, all webhook servers) sets it true.
Only the CLI path — the one a pipeline uses — defaults false. It suppresses
nothing else here (the `Preparing review...` comment it also gates is already off
via `publish_output_progress`; `enable_ai_metadata` defaults false), and the
failure still reaches the **log**, which is what the step greps, so a failure is
still classified and still yellow. `config.publish_output=false` is *not* the
lever — that kills the successful review too.

**2. The stale `❌` (`v7`).** The marker was written only on failure, so a PR that
failed and was requeued green kept showing `❌` beside a green run — the normal
recovery path for a geo outage, and the only thing left saying "failed" once the
tool's comment was gone.

Result across the 9 rollout PRs: **zero** new `Failed to review PR` threads, and
every fail → requeue → green cycle flipped its marker to `✅` + `fixed`.

### Required template check on the secrets (2026-09-05)

The `platform-bot-review` variable group is a **protected resource** with an
`ExtendsCheck`: a pipeline gets the Gemini key and ADO PAT only if it extends one
of the four approved stacks in `platform-pipelines` at the pinned tag.

```json
{ "repositoryType": "git",
  "repositoryName": "DatHa Platform/platform-pipelines",
  "repositoryRef": "refs/tags/v7",
  "templatePath": "templates/stack-node-vitest.yml" }
```

One entry per stack, four in total. Notes that cost real time:

- **`repositoryType` is `"git"`.** Not `azureRepo`, not `azureReposGit`. A wrong
  value fails every run at `Checkpoint.ExtendsCheck` with **no reason** in the
  timeline, issues or logs — there is nothing to debug from, so copy the shape.
- Create it with `POST /_apis/pipelines/checks/configurations?api-version=7.1-preview`.
  `PATCH`/`PUT` are not routable through `az devops invoke`; to change it, DELETE
  the configuration and POST a new one.
- **Order matters on a tag bump:** add the new tag's entries to the check *before*
  moving any consumer to it, or every pipeline fails the moment it is bumped.

### A failed build re-queues itself (2026-09-05)

The `Build` branch policy in every service repo is `queueOnSourceUpdateOnly:
false`, `validDuration: 0`, blocking — so a run that does not satisfy the policy
is automatically retried on the same merge commit, ~5 min later, with nobody
pressing anything. Observed repeatedly on the rollout: yellow runs re-queued,
green ones did not, and four PRs recovered from geo failures unattended.

That is the automatic geo requeue that seemed impossible on 2026-09-04 — it
already exists. Cost: retries share the single free-tier parallel job, so a wave
of PRs drains serially, and a PR accumulates runs while an outage lasts.

## Dead-code scan — knip (2026-09-04)

`knip` ^6.34.0 + a `knip.jsonc` in **all 8 Node repos**, `pnpm knip`, and a
**required** step `Dead code scan (knip)` in the 7 repos that have
a `bot-review.yml` (frontends: before _Typecheck E2E specs_; Fastify + lib:
after the unit-test publish). **`platform-nats` has no PR pipeline** — only
`jetstream-reconcile.yml`, which triggers on merge to `main` — so there it is a
local script only.

**Why it exists:** nothing else in the platform can see cross-file dead code.
ESLint's `no-unused-vars` is file-scoped, so an `export` nothing imports is
invisible to it; MegaLinter gates formatting on `.ts`/`.json`; and `prepare-push`
reviews the **staged diff**, so anything that never changes is never reviewed.
Found 2026-09-04: three files from `feat: init` (2026-05-14) that had sat unused
for four months in `shell-frontend`, and the same scaffold in both remotes.
The Angular build _did_ warn (`is part of the TypeScript compilation but it's
unused`) on every build — a warning nobody reads and the pipeline does not fail on.

**Entry points are the whole game.** A file is "unused" to knip when nothing
imports it, which is the _normal_ state for several things here — declare them as
`entry` or it reports false positives:

| Repo type         | Must be `entry`                          | Why nothing imports it                                                                                                  |
| ----------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| all 3 frontends   | `src/environments/environment*.ts`       | `angular.json` `fileReplacements` targets                                                                               |
| all 3 frontends   | `e2e/**/*.ts`                            | Playwright's own entry                                                                                                  |
| the 2 remotes     | `src/remote-entry.ts`                    | the MF `"./Module"` expose — loaded at runtime by the shell                                                             |
| the 2 remotes     | `webpack.config.js`                      | where `@angular-architects/module-federation` is required (the _host_ imports it in `src/main.ts`, a remote never does) |
| `shared-frontend` | `projects/platform-ui/src/public-api.ts` | published entry of `@datha/platform-ui`; consumers are other repos                                                      |
| Fastify services  | `src/db/migrate.ts`, `src/retain.ts`     | separate CLI entries (`pnpm migrate` / `retain`)                                                                        |
| `file-service`    | `src/nats/streams.ts`                    | its exports are the cross-repo durable/subject sync surface                                                             |
| `platform-nats`   | `topology.ts`, `max-deliver.ts`          | this repo **owns** the topology; every service mirrors these names                                                      |

Two unavoidable `ignoreDependencies`, both documented in the `knip.jsonc` that
needs them: **`primeicons`** (loaded via `angular.json` `styles`, and knip's
Angular plugin does not read the `@angular-builders/custom-webpack` builder) and
**`pino-opentelemetry-transport`** (named as a pino `target` _string_).

**A finding is a question, not a verdict** — it can be a missing entry point, or
an export that is used only inside its own file. `"ignoreExportsUsedInFile": true`
is set everywhere for the second case: a model file legitimately exports the
members of an exported union (`MessageStreamEvent`) or the element type of an
exported interface's property, and **deleting those would break the union while
un-exporting them only hurts consumers**. So **verify before deleting**: `grep`
the symbol, read the file, and for a dependency check config files and
string-referenced targets, not just imports.

**Required (not `continueOnError`) since all 8 repos read clean, 2026-09-04.**
An advisory step accumulates findings — which is precisely how 34 dead scaffold
files survived four months. When a legitimate new entry point trips it, the fix
is one line in `knip.jsonc`, and that line is the documentation.

## MegaLinter

Use the `javascript` flavor (`oxsecurity/megalinter-javascript:v8`) for Angular/TypeScript frontends and for **`file-service`** / **`event-store`** (Fastify + TypeScript).
Use **`oxsecurity/megalinter-python:v8`** for **`chatbot-service`**.
Use **`oxsecurity/megalinter-go:v8`** for **`api-gateway`**.

Always include a `.mega-linter.yml` at the repo root — this is the proper way to configure exclusions and linter selection. Do NOT cram these as inline env vars in the pipeline.

```yaml
# .mega-linter.yml
FILTER_REGEX_EXCLUDE: "(pnpm-lock\\.yaml|package-lock\\.json|yarn\\.lock|azure-pipelines/|dist/|node_modules/|coverage/)"
YAML_YAMLLINT_FILTER_REGEX_EXCLUDE: "(pnpm-lock\\.yaml|azure-pipelines/)"
DISABLE_LINTERS:
  - TYPESCRIPT_ES # no ESLint config in Angular frontends
  - TYPESCRIPT_STANDARD
  - SPELL_CSPELL
ENABLE_LINTERS:
  - TYPESCRIPT_PRETTIER
  - JSON_PRETTIER
  - YAML_YAMLLINT
FLAVOR_SUGGESTIONS: false
```

In the pipeline, pass all ADO variables through the `env:` block and reference with `$VAR` in the script — never use `$(ADO.Variable)` inline in bash, it breaks when the variable is undefined (e.g. manual runs) and when values contain spaces.

Guard the PR comment reporter so manual runs don't crash:

```bash
if [[ "$PR_ID" =~ ^[0-9]+$ ]]; then COMMENT_REPORTER=true; else COMMENT_REPORTER=false; fi
```

Mount the repo root, not a subfolder (each service is its own repo):

```yaml
-v "$BUILD_SOURCESDIRECTORY":/tmp/lint
```

### Running the same linters locally (2026-08-28)

MegaLinter runs with **`continueOnError: true`** in every bot-review pipeline — advisory,
never blocking — and by default lints only the files a PR touches. Local parity is about
seeing findings before the PR comment does.

| Repo(s)                                   | Enabled linters                                             | Local command                                                                               |
| ----------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `chatbot-service`                         | `PYTHON_BLACK`, `PYTHON_ISORT` (config in `pyproject.toml`) | `.venv/bin/black --check app tests` · `isort --check-only` — both in `requirements-dev.txt` |
| `api-gateway`                             | Go defaults minus `GO_REVIVE`                               | `gofmt -l` (toolchain) · `golangci-lint run` (brew)                                         |
| 7 TS repos                                | `TYPESCRIPT_PRETTIER`, `JSON_PRETTIER`, `YAML_YAMLLINT`     | `pnpm format:check` · `yamllint` (brew) — real parity since the config landed, see below     |
| `platform-nats`, `platform-observability` | —                                                           | no `.mega-linter.yml` at all                                                                |

**yamllint baseline (2026-09-08).** All **13 repos that run MegaLinter** now commit a byte-identical `.yamllint.yml`, for the same reason they commit an explicit `.prettierrc`: without one, yamllint uses **its own defaults locally** and **whatever the container bundles** in CI, so the local parity command above was reporting 2-12 findings per repo of unknown status. Now `yamllint` reports **zero** across every YAML file in all 13.

- Two rules differ from `extends: default`, both commented in the file: `document-start: disable` (these configs start straight at the keys) and `line-length: max 140`. The length rule is not laziness — **`FILTER_REGEX_EXCLUDE` is a single regex, and YAML folding inserts spaces into a folded value, which would silently corrupt the pattern.** Those lines genuinely cannot be wrapped.
- The sweep also stripped a stray trailing blank line from `azure-pipelines/bot-review.yml` in 8 repos (whitespace only; `git diff --ignore-all-space` empty).
- **`platform-nats`, `platform-observability` and `platform-pipelines` are excluded on purpose** — no `.mega-linter.yml` and no bot-review pipeline of their own, so the config would be inert. `platform-pipelines` shows 31 local yamllint findings and has no linter that reads them; left alone deliberately.
- The two Go repos have **no** `YAML_YAMLLINT_FILTER_REGEX_EXCLUDE`, so unlike the TS repos their `azure-pipelines/` YAML *is* in CI scope. Worth remembering before editing those files.

**MegaLinter lints only the files a PR touches**, so a pre-existing finding stays invisible until someone edits that file — and a **new repo's first PR lints everything at once**. That is why `realtime-service`'s first run surfaced two Go findings on day one, and why `api-gateway` had carried two `errcheck` findings unnoticed. Run the local linters on the whole repo before a first PR.

**Prettier baseline (2026-08-28).** Every TS repo now commits an explicit `.prettierrc`
(prettier defaults written out), a `.prettierignore`, `prettier ^3.8.1` in
`devDependencies`, and `format` / `format:check` scripts.

- **Defaults won, not `shared-frontend`'s old config.** That repo declared
  `printWidth: 100` + `singleQuote: true` while 54 of its 54 import lines used double
  quotes and 20 of 21 files failed its own config — nobody had ever run it. Against
  defaults only 3 files differed. The config was the outlier, so it was replaced.
- **Explicit values, not implicit defaults**: prettier changes defaults across majors
  (v3 flipped `trailingComma` to `all`), and the MegaLinter container's version is not
  the local one.
- **Scope is `.ts` + `.json` — the gate's scope.** `*.html` is in `.prettierignore`:
  reformatting Tailwind-heavy Angular templates is a large change with zero CI benefit
  (`chat-page.component.html` alone reflows 738 lines).
- `chatbot-frontend` is the one repo still unformatted — it had the retry feature in
  flight, and mixing a mass reformat into that diff would make it unreviewable. Run
  `pnpm format` there once the feature commit lands, as its own `style:` commit.

## PR-Agent (AI review — all services)

- Docker image namespace: **`pragent/pr-agent`** (current releases). Legacy `codiumai/pr-agent` is frozen archive.
- Uses PR-Agent Dynaconf env vars (`__` nests keys). **`azure_devops.org` reads `azure_devops__org`**, **`azure_devops.pat`** → `azure_devops__pat`. Do **not** use `azure_devops.ORG_URL` / `ORG_URL`; the provider code calls `azure_devops.get("org")` and will silently fail authentication.
- **Google AI Studio (Gemini)**: pass **`GOOGLE_AI_STUDIO__GEMINI_API_KEY`** (ADO secret **`GEMINI_KEY`**). Use **`gemini/gemini-flash-latest`** as primary and **`gemini/gemini-flash-lite-latest`** (or comma-separated extras) as fallbacks — **`-latest`** aliases track current API names; bare **`gemini-1.5-flash`** often **404**. **Custom / alias model strings are not** in PR-Agent **`MAX_TOKENS`** → set **`config__custom_model_max_tokens`** (**`> 0`**, e.g. **`262144`**) next to **`config__model`** (actual send size is still capped by **`config.max_model_tokens`**). Bundled defaults use **`gpt-*`** — keep **`config__model`**, **`config__fallback_models`**, **`config__custom_reasoning_model=true`** in the pipeline so CI never hits **`dummy_key`**. **`.pr_agent.toml`** is read from the **default branch** only (ADO `get_item_content`, no PR ref).
- Prefer **`ORG_URL`** from `$(System.CollectionUri)` trimmed of trailing slashes, then **`PR_URL`** = `${ORG_URL}/{project}/_git/${REPO}/pullrequest/${PR_ID}`. Projects with spaces in their name (**e.g. `DatHa Platform`) must use **`$(System.TeamProjectId)` (GUID)\*\* in the URL segment, not `%20`/encoding — PR-Agent passes that path segment to the REST API as-is without decoding `%20`, which yields `Failed to get git provider`.
- **PR labels**: setting review labels fails with **`requires user authentication`** if the PAT has no **Pull Request (write)** / label scope. Prefer disabling label publishing in CI: **`pr_reviewer__enable_review_labels_effort=false`** and **`pr_reviewer__enable_review_labels_security=false`** — content review still posts.
- Secret sources: Key Vault-linked group `platform-bot-review` → `$(bot-review-gemini-key)` / `$(bot-review-ado-pat)`, mapped into `GEMINI_KEY` / `ADO_PAT` env names for Docker (script internals unchanged).
- On failure PR-Agent CLI often prints **`usage`/help**: that happens when **`handle_request` returns `False`** (exceptions caught) or **`pr_url` is empty**. Check the preceding log lines, not only the bottom “help”.
- **`config__publish_output_progress=false`**: disables PR-Agent’s temporary Azure comment (“Preparing review…”). Without it, a failed Gemini/geo run leaves that placeholder forever.
- **Gemini geo (`User location is not supported`)**: Google **AI Studio** keys are rejected when the **pipeline agent egress IP** is in an unsupported region — common on **Microsoft-hosted** `ubuntu-latest` agents, independent of where developers run locally. Mitigations: **self-hosted agent** in a [supported region](https://ai.google.dev/gemini-api/docs/available-regions), **Vertex AI** Gemini (service account + `VERTEXAI_*` via LiteLLM, not `GOOGLE_AI_STUDIO__*`), or another provider if the org allows it.
- **PR-Agent failure PR comment**: upsert `<!-- bot-review:pr-agent:{service} -->` when `docker` exits non-zero **or** the log contains `Failed to review PR` / `Failed to generate prediction with any model` (PR-Agent often exits **0** after those errors). Requires OAuth token (same as unit-test comment).
- **Gemini geo — operational default:** treat PR-Agent as **best-effort** on `ubuntu-latest`; requeue Bot Review if you want another agent region; do not block merge on geo alone when unit tests + MegaLinter are acceptable.
- **Never propose a paid fix for it.** dathq's standing position: the Gemini free-tier geo block is known and accepted, PR-Agent is advisory, and requeueing Bot Review is the whole remedy. Do not suggest paid Gemini/Vertex tiers, another paid provider, or a self-hosted agent as a purchase — mention self-hosting only if he raises infrastructure himself.
- Only run **`review`** to minimize tokens. Skip **`improve`** / **`describe`** unless needed.
- **Its findings are worth verifying, in both directions.** 2026-09-05 it reported a SQL bug in `accounts-service` that was a false positive (`$4` was used in the `ON CONFLICT` clause). 2026-09-06 it reported that `auth.interceptor.ts` re-attached the API bearer on the 401 refresh-retry without the targeting check — **that one was real**, in all four frontends, and reproduced with a spec that fails against the old code (`Expected 'Bearer app-access-token' to be null`). Read the code before accepting or dismissing; neither "it's an AI, ignore it" nor "it's a finding, patch it" is a policy.
- **Gemini free-tier quota is exhaustible**, separately from the geo block: dathq burned the day's tokens on 2026-09-06. Same remedy as geo — requeue Bot Review later (next day for the daily quota). Not a reason to change providers or pay.

## PR-Agent false positives on `bot-review.yml`

PR-Agent often flags the shared bot-review pipeline. Dismiss only when the reasoning below applies and the YAML includes our mitigations (job-header comment + `--rawfile` upsert + log/token hygiene). **Do not dismiss** if those controls are missing — fix the pipeline instead.

### OAuth / `SYSTEM_ACCESSTOKEN` in `env:` or MegaLinter `docker -e`

**Why this is a false positive:** `$(System.AccessToken)` in step `env:` is [Microsoft’s documented pattern](https://learn.microsoft.com/en-us/azure/devops/pipelines/build/variables?view=azure-devops) for YAML pipelines calling the Git/PR REST API. **YAML enables the token by mapping it in `env:`** — not via the Classic **“Allow scripts to access the OAuth token”** Agent-job checkbox (designer pipelines only). The token is **job-scoped** (not a standing PAT), **masked in ADO job logs**, and lives only on an **ephemeral agent** for that job. MegaLinter’s `AZURE_COMMENT_REPORTER` **requires** `-e SYSTEM_ACCESSTOKEN`; PR-Agent uses a separate **`ADO_PAT`**.

**Why “use a file / build-arg / avoid env” is not a real fix:** the process that posts comments must still receive the credential on the same agent; moving it to a file or build-arg does not reduce exposure there. Env via ADO OAuth is the supported integration path.

**Controls we enforce:** step **`env: SYSTEM_ACCESSTOKEN: $(System.AccessToken)`** on upsert/MegaLinter steps; never `echo "$SYSTEM_ACCESSTOKEN"` (debug: `set` / `missing` only); `curl -fsS` only (no `-v` / `--trace`). Each `bot-review.yml` documents this in the job-header YAML comment.

### jq / “command injection” in PR comment upsert

**Why this is a false positive:** untrusted text (test logs, summaries) is written to temp files and passed with **`jq --rawfile`**. Comment markers in jq filters are **fixed strings**. The ADO payload is built in **one jq invocation** — not `$(build_comment_json | jq …)` where log bytes round-trip through shell command substitution.

**When it is NOT a false positive:** summaries or logs passed as **`--arg "$(tail …)"`**, nested **`$(…)`** around jq output, or **`curl -v`** / **`set -x`** on upsert steps — treat as a real bug and fix.

## Creating a PR with `az repos pr create` (2026-09-14)

**A PR description is capped at 4000 characters** and ADO rejects the whole call
past it — `ERROR: Invalid argument value. Parameter name: A description for a
pull request must not be longer than 4000 characters.` Write the body to a file,
check `wc -c` **before** calling, and pass it as `--description "$(cat file)"`.

A long `--description` given inline can also fail with a bare non-zero exit and
no JSON, which reads like an auth or network problem and is not one. If a create
fails that way, **check `az repos pr list --source-branch <branch>` before
retrying** — on 2026-09-14 the first attempt looked like a clean failure while a
probe had in fact created PR !180, and a blind retry would have opened a
duplicate. Recovering is `az repos pr update --id <n> --title … --description …`,
which takes the same 4000-character cap.

## Path filters

Since each service is its own repo, no `paths` filter is needed — every PR in that repo is relevant. Keep it simple:

```yaml
pr:
  branches:
    include:
      - main
```

## Typecheck step, and what validates a template change (2026-09-06, v8 → v9)

`stack-node-vitest` now runs **`pnpm typecheck:test`** (`steps/typecheck-tests.yml`) between the suite and knip. Test files are excluded from each repo's `tsconfig.json` so the build cannot emit them into `dist/`, which also means `tsc` never sees them and vitest only transpiles — the gate found real errors in three of four Node services on introduction. Rule: **`testing/unit-testing-strategy.md`**.

Two lessons cost a broken tag:

1. **`pnpm install` lives in `steps/unit-tests.yml`, not `setup.yml`.** Any step needing `node_modules` goes after it — which is why knip sits there. `v8` put the typecheck first; with no dependency tree `tsc` resolved to the agent image's own TypeScript and every run died on `TS5108` about a `moduleResolution` the repos are entitled to use.
2. **The preview API does not validate a template change.** `POST /_apis/pipelines/{id}/preview` expands YAML and never runs a step: `v8` expanded perfectly and failed every consumer. Only a **canary run** proves it. `v9` was rolled to one repo first, confirmed green on a real run, then to the rest.

`v8` was pulled from the `ExtendsCheck` allow-list when `v9` was added — a known-broken tag should not stay approved. Also corrected: **`az devops invoke` does support PATCH** on `pipelineschecks/configurations` when the route carries `id=<check>` (area `pipelineschecks`, api-version `7.1-preview`). The earlier delete-and-recreate dance is unnecessary, so the check is never briefly absent.
