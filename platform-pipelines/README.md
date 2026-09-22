# platform-pipelines

Shared Azure DevOps pipeline templates for the datha platform. **Not a runnable
app and it has no pipeline of its own** — the YAML here is consumed by each
service repo's own pipeline definition.

## Why this exists

Before this repo, `azure-pipelines/bot-review.yml` was copy-pasted into 9 repos.
`event-store`'s and `notification-service`'s were **byte-identical** apart from
the service name, and the three frontends' likewise. That duplication was not
theoretical: `pragent/pr-agent:latest` was unpinned in all 9, a newer image
started publishing its own un-deduped failure comment, and one PR collected
**13 `Failed to review PR` threads** before anyone noticed (2026-09-04). One bug,
nine places to fix it.

## How a repo consumes it

The service repo **keeps its own `azure-pipelines/bot-review.yml`** at the same
path — that matters, because the `main` branch policy references the pipeline's
**definition ID**. Deleting and re-creating a pipeline yields a new ID and
silently drops that blocking check. Only the file's contents change:

```yaml
trigger: none

pr:
  branches:
    include:
      - main

pool:
  vmImage: ubuntu-latest

variables:
  - group: platform-bot-review

resources:
  repositories:
    - repository: templates
      type: git
      name: DatHa Platform/platform-pipelines
      ref: refs/tags/v1

extends:
  template: templates/stack-fastify.yml@templates
  parameters:
    service: event-store
```

The first run of each converted pipeline **pauses for a one-time authorization**
("this pipeline needs permission to access a resource") because it now reads a
second repository. Grant it once per pipeline, or pre-authorize this repo in its
security settings.

## Layout

| File | Role |
|---|---|
| `templates/stack-node-vitest.yml` | `extends` target — Node services on pnpm + vitest |
| `templates/stack-angular-karma.yml` | `extends` target — Angular apps and the shared library |
| `templates/stack-go-gotestsum.yml` | `extends` target — Go services (no knip) |
| `templates/stack-python-pytest.yml` | `extends` target — Python services (no knip) |
| `templates/steps/setup.yml` | checkout, Node, optional `npmAuthenticate` |
| `templates/steps/typecheck-tests.yml` | `pnpm typecheck:test` — tests are excluded from `tsconfig.json`, so nothing else typechecks them |
| `templates/steps/unit-tests.yml` | test run **and the PR-comment upsert** — the governance bash, once |
| `templates/steps/knip.yml` | dead-code gate (required, not advisory) |
| `templates/steps/megalinter.yml` | MegaLinter, advisory |
| `templates/steps/pr-agent.yml` | PR-Agent, advisory, **image pinned by digest** |
| `templates/steps/e2e-playwright.yml` | typecheck + Playwright + traces on failure |

## Extending without forking

Both stack templates take `preSteps` and `extraSteps` (`stepList`), so a repo or
team adds steps by passing them in:

```yaml
extends:
  template: templates/stack-node-vitest.yml@templates
  parameters:
    service: event-store
    extraSteps:
      - script: ./scripts/contract-test.sh
        displayName: Contract tests
```

Design rules, so this stays maintainable as teams diverge:

- **Parameters for values** (service name, test command, Node version).
- **Stacks are split by job SHAPE — toolchain + test runner + result format — not
  by language.** That is why there are two Node stacks: `stack-node-vitest` and
  `stack-angular-karma` share a language but nothing else. Names say the contract
  (`stack-go-gotestsum`), so a second Go repo just points at the same stack.
- **Separate templates for different shapes** — a new stack gets its own
  `stack-*.yml`, it does not become a flag on an existing one.
- **Do not leave an unconsumed stack in here.** A template nothing extends is
  dead config that has never been validated — the same rot the knip gate exists
  to catch. `stack-go-gotestsum` shipped unused for one commit and that was a
  mistake; every stack now has a real consumer.
- **`stepList` hooks for additions.** The only boolean switches are `knip`,
  `npmAuth` and `e2e`, each justified in the template. A template with twenty
  booleans is worse than duplication.
- **Uniform by policy, not by accident:** secret handling, the OAuth pattern, the
  comment upsert and the linters live here and are not meant to be overridden.
  A team needing something incompatible should own that as an explicit, documented
  exception rather than editing the shared bash.

## PR-Agent failure policy

A yellow run must always mean "there is something for you to do", so PR-Agent
failures are **classified** instead of blanket-swallowed:

| Class | Detection | Comment says | Run |
|---|---|---|---|
| `geo` | `User location is not supported` | requeue Bot Review | **yellow** |
| `quota` | `RESOURCE_EXHAUSTED` / 429 / quota text | wait for the window | **yellow** |
| `unavailable` | 5xx / `ServiceUnavailableError`, after 3 tries | requeue later | **yellow** |
| `actionable` | anything else (bad key, PAT failure, crash) | worth a look | **yellow** |

**Every failure goes yellow on purpose.** The pipelines tab is the monitoring
surface, so yellow is what says "PR-Agent did not review this PR". Exiting 0 on an
external outage would hide that and force someone into each PR to discover it. The
classification changes the *wording and the retry decision*, never the colour.

Only `unavailable` is retried (3 attempts, 20s then 40s). Geo is not retryable —
it is fixed for the agent's egress IP — and a quota window outlives the job.

**One thread, both outcomes.** The step keeps a single marker thread per service:
a failure writes the classified `❌` summary and reopens the thread, a success
PATCHes it to `✅ Reviewed` and marks it fixed. Without that, a PR that failed and
was then requeued green kept showing a stale `❌` — the normal recovery path for a
geo outage. A green run adds no comment where none exists: PR-Agent publishes the
review itself, so a second "it passed" beside it would duplicate the same truth.

**One comment per failure, and it is ours.** The container used to publish its own
bare `Failed to review PR` thread on every failed run — no marker, no upsert, so
requeues piled them up. `config__is_auto_command=true` turns that off at the
source (the tool gates that comment on the flag, and sets it itself in every
webhook/Action entry point; only the CLI path defaults false). The failure still
reaches the log, which is what the step greps, so the run still goes yellow.

See `.claude/rules/working-agreement.md` § PR hygiene. Related trap: `##[warning]`
is a *logging command* — emitting one marks the task `succeededWithIssues` by
itself, so it is never a neutral way to print a note.

## Versioning

Consumers pin `ref: refs/tags/vN`. **Never point a consumer at `main`** — one
edit here would otherwise change every pipeline at once with no review. That is
the same mistake as an unpinned container tag, which is what caused the bug this
repo exists to prevent.

To ship a change: land it on `main`, **add the new tag to the `ExtendsCheck` on
the `platform-bot-review` variable group**, move a repo's stub to the new tag as
a canary, confirm a green run, then bump the remaining consumers.

The check gates the secrets on template + ref, so a consumer bumped before the
check knows the tag fails every run — and the rejection reports no reason in the
timeline, the issues or the logs.

Template changes cannot be validated by the consumers' PRs, so the canary step is
the validation.

**The preview API is not that validation.** `POST /_apis/pipelines/{id}/preview`
expands YAML; it never runs a step. `v8` expanded perfectly and failed every
consumer run, because a step was ordered before the one that owns
`pnpm install`. Only a real run proves a template change — which is what the
canary is for.

**`pnpm install` lives in `steps/unit-tests.yml`**, not in `setup.yml`. Any new
step that needs `node_modules` goes after it — that is why `knip` and
`typecheck-tests` sit where they do.

## Pinned images

| Image | Pin | Refresh |
|---|---|---|
| MegaLinter | `oxsecurity/megalinter-javascript:v8` | version tag |
| PR-Agent | digest, see `steps/pr-agent.yml` | `docker buildx imagetools inspect pragent/pr-agent:latest` |

Related docs: `.claude/docs/ci/bot-review-pipelines.md` (the canonical narrative),
`.claude/docs/always-apply/workspace-layout.md` § Node version.
