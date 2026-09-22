# engineering-claude-rules — architecture and design rules

_engineering-claude-rules ADO repo — distributable Claude Code rules/docs, manifests, and installer (canonical spec)_

> **Renamed 2026-08-17** from `engineering-cursor-rules`. datha_platform dropped Cursor entirely; the shared-rules repo targets **Claude Code** (`.claude/`) for every consumer.

## Purpose

**ADO repo** (not a runtime app). Single source of truth for **organization-wide Claude Code rules and architecture docs** — distributed as installable configuration, not git submodules/subtrees.

| Does | Does not |
|------|----------|
| Own `.md` rule/doc files grouped by scope (common, lang, platform, services, products, testing, ci) | Replace service source code or ADO pipelines |
| Define **manifests** (team / repo / workspace profiles) | Host secrets, PATs, or per-developer `.env` |
| Ship a small **CLI** (`install`, `update`, `doctor`) | Require developers to understand git subtree/submodule |
| Version rules and produce a **lockfile** at install target | Auto-edit running services |

**Philosophy:** same as `eslint-config-company` — package-managed standards, cross-platform (Windows / macOS / Linux), easy onboarding and updates.

## Canonical repo layout

```
engineering-claude-rules/
├── README.md
├── package.json              # monorepo root or single package (v0: single package OK)
├── .gitignore                # node_modules/, dist/
│
├── rules/                    # source .md files — never hand-edit at install targets
│   ├── common/               # always-apply: workspace-layout, env-file-safety, context-boundaries, no-running-ports
│   ├── lang/                 # lang-go, lang-angular, lang-typescript-fastify, lang-python-fastapi
│   ├── platform/             # platform-nats, event-store, chatbot-file-events, analytics, this file
│   ├── services/             # per-repo architecture (api-gateway, file-service, …)
│   ├── products/             # cross-repo product flows (chatbot, interview-prep)
│   ├── testing/              # unit-testing-strategy, e2e-testing-strategy
│   ├── ci/                   # bot-review-pipelines
│   └── manifests/            # *.json profiles
│
├── packages/
│   └── cli/                  # @company/claude-rules (later); v0 may be scripts/install.mjs
│
└── scripts/                  # optional helpers before CLI is published
```

**Seed content:** migrate from `datha_platform/.claude/docs/` — that tree is the initial catalog. Do not maintain two divergent copies after cutover.

## Install targets (polyrepo)

Two profile **kinds** — team ≠ repo:

| Kind | Example manifest | Writes to | Use when |
|------|------------------|-----------|----------|
| **Workspace** | `platform-dev.json` | `datha_platform/.claude/docs/generated/` | Local convenience workspace spanning many ADO repos |
| **Repo** | `file-service.json` | `file-service/.claude/docs/generated/` | Clone contains only one service repo |

Claude Code does **not** auto-attach docs by glob. Two mechanisms make installed content reachable:

- **Always-in-context** — the target's root `CLAUDE.md` `@`-imports a short rules summary (see `datha_platform/.claude/rules/`), which links into `.claude/docs/`.
- **On demand** — `.claude/docs/**` is read when a rule or `CLAUDE.md` instruction points at it; per-repo `CLAUDE.md` auto-loads when work happens in that repo.

There is no tool-level ignore file; **`common/context-boundaries.md`** is the only ignore mechanism, so `.claude/` stays self-contained.

### Generated vs local

```
<target>/.claude/
├── docs/
│   ├── generated/     # CLI output — do not hand-edit; commit or gitignore per team policy
│   └── local/         # optional per-machine or per-repo overrides (never overwritten by install)
```

**Policy (pick one per team, document in README):**

- **Committed `generated/`** — works offline; PRs show rule bumps; run `update` + commit when central repo releases.
- **Gitignored `generated/`** — cleaner history; require `install` in onboarding / devcontainer; CI `doctor` fails if stale.

## Manifest format (v0)

Manifests live in `rules/manifests/*.json`. They **select files**; each doc carries its own one-line description as a subtitle under the H1.

```json
{
  "name": "chatbot-team",
  "version": "1.0.0",
  "extends": ["common", "lang"],
  "includes": [
    "products/chatbot-architecture.md",
    "platform/chatbot-file-events.md",
    "services/chatbot-service-architecture.md",
    "services/chatbot-frontend-architecture.md",
    "services/api-gateway-architecture.md",
    "services/file-service-architecture.md",
    "platform/event-store-architecture.md",
    "platform/platform-nats-architecture.md",
    "testing/unit-testing-strategy.md"
  ]
}
```

```json
{
  "name": "file-service",
  "version": "1.0.0",
  "extends": ["common"],
  "includes": [
    "lang/lang-typescript-fastify.md",
    "services/file-service-architecture.md",
    "platform/chatbot-file-events.md",
    "platform/platform-nats-architecture.md",
    "platform/event-store-architecture.md",
    "ci/bot-review-pipelines.md",
    "testing/unit-testing-strategy.md"
  ]
}
```

**`extends`:** named bundles defined in `rules/manifests/bundles/*.json` (e.g. `common.json` lists all `rules/common/*.md`).

**`includes`:** explicit paths relative to `rules/`.

**Lockfile** at install target: `.claude/docs/.claude-rules.lock.json` — manifest name, rules repo git tag/sha, file list + hashes. `doctor` compares lock to central repo.

## CLI commands (target interface)

| Command | Behavior |
|---------|----------|
| `install <profile>` | Resolve manifest → copy into `<target>/.claude/docs/generated/` → write lockfile |
| `install <profile>@1.2.0` | Pin to tagged release of this repo |
| `update` | Re-run install from lockfile profile at latest allowed version |
| `doctor` | Verify generated/ matches lock; warn on stale or hand-edited files |

**v0 before npm publish:** run from cloned repo, e.g. `node scripts/install.mjs chatbot-team --target ../datha_platform`.

**v1 publish:** private ADO/npm feed → `npx @company/claude-rules install chatbot-team`.

## Rule authoring rules

1. **One concern per file** — match existing `datha_platform/.claude/docs/` style.
2. **Plain Markdown** — H1 title, one italic description line under it. No tool-specific frontmatter; Claude Code ignores `alwaysApply`/`globs`, so scope is expressed by which manifest includes the file, and by the summary lines in the target's `.claude/rules/`.
3. **Always-apply content is summarized, not duplicated** — a one-line hard rule in `.claude/rules/critical-behaviors.md` linking to the full doc under `common/`.
4. **No secrets** — never commit real credentials; reference `.env.example` only (see `common/env-file-safety.md`).
5. **Cross-repo narratives** — one canonical file (e.g. `platform/chatbot-file-events.md`); others link, do not copy paragraphs.
6. **Changes** — PR to `engineering-claude-rules`; bump manifest or bundle version when behavior changes; consumers run `update`.

## Bundles (recommended starters)

| Bundle | Contents |
|--------|----------|
| `common` | All `rules/common/*.md` |
| `lang` | All `rules/lang/*.md` |
| `platform` | All `rules/platform/*.md` except this meta file unless maintainers want it |
| `testing` | All `rules/testing/*.md` |
| `ci` | All `rules/ci/*.md` |

Example manifests to ship first: `common`, `platform-dev`, `chatbot-team`, `file-service`, `api-gateway`, `shell-frontend`.

## Migration checklist (datha_platform → central repo)

1. Create ADO repo `engineering-claude-rules`; copy `datha_platform/.claude/docs/**` → `rules/**` (preserve paths).
2. Add `manifests/` + bundle JSON; add `scripts/install.mjs` (or `packages/cli`).
3. Run `install platform-dev --target datha_platform`; diff against current docs.
4. Stop hand-editing `generated/`; use `local/` for personal overrides only.
5. Document in each service README: which profile to install and where `.claude/` lives.

## Out of scope (until explicitly requested)

- Distributing **skills** (`.claude/skills/`) or **hooks** (`.claude/settings.json`) — same installer pattern later; rules first.
- Submodule/subtree wiring between service repos and this repo.
- Storing `_local/`, developer PATs, or backend `.env` files.
