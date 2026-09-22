---
name: suggesting-skills
description: When the user is doing work an existing platform skill handles better (prepare-push, comeback scan, rule-doctor, branch-cleanup, run-platform), suggest that skill once — with datha_platform context.
---

# Suggesting Skills (datha_platform)

When the user is struggling with something a **skill** already covers, suggest it once — briefly, in context.

Project skills live under **`datha_platform/.claude/skills/<name>/SKILL.md`**.  
Personal skills in **`~/.claude/skills/`** and plugin skills are available too — do not edit those from here.

## Triggers

Suggest a skill when:

- The user asks how to do something a skill covers
- They're repeating a multi-step workflow manually (push review, PR cleanup, rule authoring)
- A gap is obvious (no pre-push review, splitting a large cross-repo change)
- **Not** mid-task on unrelated work — pick natural breakpoints

Do **not** spam: **one suggestion per conversation** unless they ask again. If they decline, don't repeat the same suggestion.

## How to suggest

```
There's a skill for that — `[skill-name]` [one line what it does]. Want me to use it?
```

For **`prepare-push`**:

```
Want a pre-push review? Say prepare-push and one or more repo names
(e.g. shell-frontend chatbot-frontend) — multi-repo reviews use .claude/tmp/ briefly.
```

For **`rule-doctor`**:

```
Want to sync rules with the repo? Say rule-doctor + repo (e.g. check rules file-service)
or whole product (e.g. rule doctor chatbot, domain shell, nats platform).
```

## datha_platform skill reference

### Meta

| User is doing… | Suggest |
|----------------|---------|
| Same correction keeps happening | Offer to write it into `.claude/docs/` + the matching `.claude/rules/` summary line |
| Same fast check after every edit | Offer a hook in `.claude/settings.json` (`update-config` skill) |
| Delete local branches across repos | **`branch-cleanup`** |
| Start/stop dev servers | **`run-platform`** |
| Looking for the right workflow skill | `suggesting-skills` (this file) |

### Project workflow skills

| User is doing… | Suggest |
|----------------|---------|
| Back after a break — what was I doing across all repos, uncommitted/unpushed work | **`platform-comeback`** (scans all repos; reports in `.claude/tmp/platform-comeback/`) |
| Review staged changes before push — one or more repos, staging sanity, cross-service MFE/NATS | **`prepare-push`** (repo name(s) required; multi-repo uses `.claude/tmp/prepare-push/`) |
| Compare rules to repo reality — diff report, suggest rule updates | **`rule-doctor`** — repo name(s) or **domain** (`chatbot`, `shell`, `nats`, …); reports in `.claude/tmp/rule-doctor/` |
| Install/update org-wide shared rules from ADO | **`engineering-claude-rules` CLI** (see `.claude/docs/platform/engineering-claude-rules.md` — org-wide shared-rules repo, Claude Code targets) |
| Start/stop dev servers by product | **`run-platform`** (one product at a time, two at most; its preflight checks free space) |
| Delete local branches across repos, keeping main | **`branch-cleanup`** (survey → safety check → delete) |
| **A build or test fails with `ENOSPC` / "no space left on device"**, or the user asks why the disk is full, or wants caches pruned | **`platform-disk`** — the highest-value trigger of the lot: that error looks like a flaky test. On 2026-09-08 a Playwright run died on it with 22 GB sitting in `.angular/cache`. Check the disk *before* debugging the failure |

### Platform context — prefer rules over generic skills

| Topic | Point to… |
|-------|-----------|
| ADO bot-review, MegaLinter, PR-Agent | `.claude/docs/ci/bot-review-pipelines.md` |
| NATS / JetStream / reconcile | `.claude/docs/platform/platform-nats-architecture.md` |
| Conversation delete → file cleanup | `.claude/docs/platform/chatbot-file-events.md` |
| Polyrepo layout | `.claude/docs/always-apply/workspace-layout.md` |

Do **not** suggest generic “GitHub Actions CI” skills for this platform — CI is **Azure DevOps** per service repo.

## Rules for this skill

- One suggestion per conversation unless asked
- Declined once → drop it
- Prefer **project skills** in `.claude/skills/` for team-shared workflows
- When suggesting install: create `SKILL.md` under `.claude/skills/<kebab-name>/`
- Heavy pre-push review → **`prepare-push`**, never a hook
