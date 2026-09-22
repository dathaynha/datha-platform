---
name: platform-comeback
description: >-
  Re-orient after time away from datha_platform — align on workspace rules, scan
  all service repos for git state (uncommitted, unpushed, ahead/behind default
  branch), write diffs and a summary under .claude/tmp/platform-comeback/. Use
  when the user says platform comeback, come back brushup, where did I leave off,
  or wants to see what they were working on across all repos.
---

# Platform comeback — where you left off (datha_platform)

Recover context after a break: **align on workspace layout**, **scan every git repo** under `datha_platform/`, write **per-repo artifacts + summary** to a temp folder, and infer **likely intent** (clearly labeled).

This is **discovery**, not push readiness. For lint/tests and BLOCK/WARN before push, use **`prepare-push`** instead.

---

## Trigger phrases

- “platform comeback”
- “come back brushup” / “comeback brushup”
- “where did I leave off”
- “check all repos — what was I doing”
- “scan the platform for uncommitted work”

No repo names required — scan **all** repos on disk.

---

## Workflow overview

```
0. Align     → workspace layout + always-apply rules (brief)
1. Discover  → every datha_platform/* folder with .git
2. Scan      → git state per repo (parallel shell where possible)
3. Write     → .claude/tmp/platform-comeback/<run-id>/
4. Report    → show summary.md in chat; offer per-repo files
```

Execute in order. Do **not** run unit tests, lint suites, or commits unless the user asks separately.

---

## Step 0 — Align

Before git work, confirm (briefly in chat or in `summary.md` header):

- `datha_platform/` is **not** a repo — each service folder is its own ADO/git repo
- Commits/PRs are **per service repo**
- Backend `.env` is **never** read; `_local/` is out of scope
- NATS topology source of truth: **`platform-nats/`** (`pnpm reconcile`)

Load **`always-apply/workspace-layout.md`**. Mention repos listed in **`prepare-push/reference/repos.md`** that are **not cloned** locally (if any).

---

## Step 0.5 — Disk check (cheap, every time)

`df -h /System/Volumes/Data | tail -1`, plus `du -shc */.angular/cache 2>/dev/null | tail -1`.

A workspace left alone comes back with every cache it had, and a nearly-full disk turns the session's first build into an `ENOSPC` failure that reads like a broken test — on 2026-09-08 the machine was down to 423 MB free with 22 GB sitting in Angular caches. Report the numbers with the git scan; under ~10 GB free, name **`platform-disk`**.

## Step 1 — Discover repos

From workspace root `datha_platform/`:

1. List immediate child directories that contain **`.git/`**
2. **Exclude** `_local/`, `.claude/`, and any non-service folders
3. Compare against **`prepare-push/reference/repos.md`** — note expected repos missing from disk

Record discovered repo names in **`summary.md`** under **Repos scanned**.

---

## Step 2 — Git scan (per repo)

Run from each repo path (`git -C datha_platform/<repo>/ …`). Prefer parallel commands across repos.

### Collect (facts)

| Signal | Command / approach |
|--------|-------------------|
| Short status | `git status --short --branch` |
| Current branch | `git branch --show-current` |
| Default branch | `origin/HEAD` → usually `main` or `master`; fallback try `main` then `master` |
| Ahead/behind default | `git rev-list --left-right --count origin/<default>...HEAD` (if remote exists) |
| Unpushed commits | `git log origin/<default>..HEAD --oneline` (empty = none) |
| Staged files | `git diff --cached --name-status` |
| Unstaged files | `git diff --name-status` |
| Untracked files | from `git status --porcelain` (`??` lines) |
| Staged diff | `git diff --cached` |
| Unstaged diff | `git diff` |
| Combined stat | `git diff HEAD --stat` (working tree vs last commit) |

If **no `origin` remote** or default branch unknown: note in report; still capture local branch, uncommitted state, and `git log -5 --oneline`.

### Classify repo activity

| Status | Meaning |
|--------|---------|
| **Active** | Any staged/unstaged/untracked **or** unpushed commits on current branch |
| **Branch drift** | Clean working tree but **ahead/behind** default branch (even with zero unpushed commits) — note in report |
| **Clean** | No uncommitted changes, no unpushed commits, in sync with default (or no remote) |

**Active** repos get a full **`<repo>.md`** + **`<repo>.patch`**.  
**Clean** repos go in **`clean-repos.md`** only (one line each).  
**Branch drift** on an otherwise clean repo: include in **`clean-repos.md`** with ahead/behind counts.

### Safety (scan only)

While listing changed paths, **flag** (do not read contents of):

- Backend `.env` / `.env.*` in service dirs → warn in `<repo>.md`
- `_local/`, credentials, obvious secrets in untracked paths → warn

Do **not** block the comeback report — user is orienting, not pushing.

---

## Step 3 — Temp folder

Ephemeral output under **`.claude/tmp/platform-comeback/<run-id>/`**  
(`run-id` = ISO timestamp UTC, e.g. `20260701T120000Z`, or short uuid).

```
.claude/tmp/platform-comeback/<run-id>/
├── summary.md           # read this first — overall story + next steps
├── cross-links.md       # clean repos still relevant to active work
├── clean-repos.md       # repos with no local activity signal
├── <repo>.md            # one per active repo
├── <repo>.patch         # full diff: staged + unstaged (git diff HEAD)
└── missing-clones.md    # optional — expected repos not on disk
```

### Create

1. `mkdir -p .claude/tmp/platform-comeback/<run-id>/`
2. For each **active** repo: write **`<repo>.md`** (template below) and **`<repo>.patch`**:
   - Patch body: `git diff HEAD` from that repo (includes staged + unstaged; untracked files listed in `.md` only, not in patch)
   - If only unpushed commits (clean tree): patch file may be empty — put commit messages and `git show` summaries in `.md`
3. Write **`clean-repos.md`** for all **clean** / **branch drift** repos
4. Write **`cross-links.md`** using **`prepare-push/reference/cross-repo-matrix.md`**:
   - For each **active** repo, list matrix rows triggered by changed paths or commit subjects
   - For **clean** siblings that the matrix says should coordinate → “still relevant even though clean”
   - Suggested **PR order** if multiple active repos touch one flow
5. Write **`summary.md`** (template below) — synthesize the platform-wide story
6. Show user **`summary.md`** in chat; mention run folder path; offer to open active repo files

### Cleanup

Delete **`.claude/tmp/platform-comeback/<run-id>/`** when the user confirms:

- “done” / “got it” / “clear comeback” / “ok thanks”
- They explicitly ask to delete temp files
- They start a **new** platform-comeback run (new `run-id`; delete previous run folder first)

Do **not** commit `.claude/tmp/`. Do not leave old run folders indefinitely.

---

## Step 4 — Interpretation rules

Separate **facts** from **inference** in every narrative section.

**Facts:** branch name, file paths, diff stats, commit hashes/messages, ahead/behind counts.

**Likely intent (inference):** one short paragraph per active repo — what the change cluster *probably* aims at. Prefix with **“Likely intent:”**. Ground in:

- Changed paths and symbols (routes, NATS durables, webpack federation, migrations)
- Recent unpushed commit messages
- Loaded repo rules from **`prepare-push/reference/repos.md`** (service/platform/product rules)

If unclear, say **“Unclear — WIP or mixed concerns”** and list open questions.

Do **not** present inference as certainty.

---

## Per-repo template (`<repo>.md`)

```markdown
## `<repo>` (`<branch>`)

**Activity:** ACTIVE | BRANCH_DRIFT | CLEAN
**Default branch:** main | master | unknown
**Ahead/behind origin/<default>:** +N / -M (or no remote)
**Unpushed commits:** N — <one-line list or “none”>

### Changed paths (facts)
| Kind | Paths |
|------|-------|
| Staged | … |
| Unstaged | … |
| Untracked | … |

### Unpushed commits (facts)
- `<hash>` — <subject>
  - …

### Diff stat (facts)
\`\`\`
<git diff HEAD --stat output>
\`\`\`

### Safety flags
- … (or “none”)

### Likely intent (inference)
…

### Suggested next steps
- …

**Full diff:** `<repo>.patch`
```

---

## Clean repos template (`clean-repos.md`)

```markdown
# Clean repos (no uncommitted / unpushed signal)

| Repo | Branch | vs default | Note |
|------|--------|------------|------|
| platform-nats | main | in sync | — |

Repos listed here were likely **not touched** recently — see **`cross-links.md`** if an active sibling implies they may still matter for the same feature.
```

---

## Cross-links template (`cross-links.md`)

```markdown
# Cross-repo links

## Triggered by active work
| Active repo | Related repo | Why it matters | Related repo status |
|-------------|--------------|----------------|---------------------|
| file-service | platform-nats | durable / topology | clean — reconcile may be needed |

## Suggested PR order (if multiple active repos)
1. …

## Open coordination questions
- …
```

---

## Summary template (`summary.md`)

```markdown
# Platform comeback — summary

**Run:** `.claude/tmp/platform-comeback/<run-id>/`
**Scanned at:** <ISO timestamp>
**Repos on disk:** N — <list>
**Missing clones (expected):** … or none

## TL;DR — where you left off
<2–5 sentences: platform-wide story, main theme(s), what looks finished vs in-progress>

## Active repos (need attention)
| Repo | Branch | Signal | Likely intent (one line) |
|------|--------|--------|--------------------------|
| … | … | uncommitted + 2 unpushed | … |

## Clean repos
See **`clean-repos.md`** (<count> repos).

## Cross-repo picture
<top items from cross-links.md — flows, deploy order, siblings to include>

## Suggested next actions
1. …
2. …

## When ready to push
Use **`prepare-push <repo …>`** for lint/tests and BLOCK/WARN review — not part of this skill.

## Workspace reminders
- Polyrepo: one ADO PR per service repo
- NATS: `cd platform-nats && pnpm reconcile` before consumers after topology changes
- Never commit `.claude/tmp/`
```

---

## Rules for this skill

- Scan **all** repos with `.git` under `datha_platform/` — do not require repo names from the user
- Include **uncommitted** (staged, unstaged, untracked), **unpushed commits**, and **ahead/behind default branch**
- Always write temp files under **`.claude/tmp/platform-comeback/<run-id>/`**
- Label **inference** separately from **facts**
- Clean repos: short entry only — business relevance lives in **`cross-links.md`**
- Do **not** run unit tests or lint (use **`prepare-push`** for that)
- Do **not** commit or push unless the user explicitly asks afterward
- Do **not** read backend `.env` files
- Repo profiles and test commands: **`prepare-push/reference/repos.md`**
- Cross-repo matrix: **`prepare-push/reference/cross-repo-matrix.md`**
- **Follow-ups about the comeback:** read **`.claude/tmp/platform-comeback/<run-id>/`** — do not re-scan all repos with git unless user asks to refresh

---

## Follow-up questions (same session or later)

When the user asks about **what they were doing**, **what changed**, or **themes in the comeback** — and a run folder already exists under **`.claude/tmp/platform-comeback/`**:

1. **Read the temp artifacts first** — `summary.md`, `cross-links.md`, `<repo>.md`, `<repo>.patch`, `clean-repos.md`
2. **Do not re-run** full git scans or `git diff` across repos unless:
   - There is **no** prior run folder, or
   - The user explicitly asks to **refresh** / **re-scan**, or
   - You need to **verify** something changed since the run (say so briefly, then minimal targeted git only)

Prefer the **latest** run folder (highest timestamp under `.claude/tmp/platform-comeback/`). Mention the run path when citing.

---

## After comeback

If the user wants to continue implementation → normal agent mode in the relevant repo(s).

If they want push readiness → **`prepare-push <repo …>`**.

If rules feel stale vs code → **`rule-doctor`**.
