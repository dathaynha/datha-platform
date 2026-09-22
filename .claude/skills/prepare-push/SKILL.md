---
name: prepare-push
description: >-
  Pre-push code review for one or more ADO repos. Use when the user says review
  code before push, prepare push, or similar — repo name(s) required (e.g.
  file-service or shell-frontend chatbot-frontend api-gateway).
---

# Prepare push — code review (datha_platform)

Review **staged and unstaged** changes before push. Supports **one or many** service repos plus **cross-service** checks (MFE, gateway, NATS, product flows).

Inspired by [reviewing-code](https://github.com/spencerpauly/awesome-cursor-skills/blob/main/resources/reviewing-code/SKILL.md).

## Trigger phrases

- “review code I'm about to push”
- “prepare push **&lt;repo&gt;**” / “prepare push **&lt;repo1&gt; &lt;repo2&gt; …**”
- “review staged changes in **&lt;repo&gt;**”

**Input:** one or more repo folder names (e.g. `file-service`, or `shell-frontend chatbot-frontend api-gateway`). Ask if missing. Do not use `datha_platform` as a repo name.

---

## Single repo vs multi-repo

| Repos given | Temp files | Cross-service file |
|-------------|------------|-------------------|
| **1** | Optional — may report inline in chat | Skip unless diff clearly touches cross-cutting areas (then short WARN in chat) |
| **2+** | **Required** — see below | **Required** |

---

## Temp file workflow (multi-repo)

Ephemeral output under **`.claude/tmp/prepare-push/<run-id>/`** (`run-id` = ISO timestamp or short uuid).

```
.claude/tmp/prepare-push/20260527T143022Z/
├── shell-frontend.md      # per-repo review
├── chatbot-frontend.md
├── api-gateway.md
├── cross-service.md       # MFE, gateway, NATS, sibling git scan, PR order
└── summary.md             # merged verdict
```

### Create

1. `mkdir -p .claude/tmp/prepare-push/<run-id>/`
2. For **each** named repo, run Steps 1–4 below; write full per-repo report to **`<repo>.md`** using the per-repo template.
3. Write **`cross-service.md`** using **`reference/cross-repo-matrix.md`**:
   - Matrix rows triggered by **all** staged diffs across named repos
   - Sibling repos with local changes not in the user’s list
   - MFE / gateway / NATS / product-flow mismatches
   - Suggested **PR order** when multiple ADO PRs needed
4. Write **`summary.md`** — merged **BLOCK/WARN**, per-repo verdicts, single overall **OK TO PUSH | FIX THEN PUSH | DO NOT PUSH**.
5. Show user **`summary.md`** in chat (and offer to open per-repo files).

### Cleanup

Delete **`.claude/tmp/prepare-push/<run-id>/`** (entire run folder) when the user confirms any of:

- “ok to push” / “looks good” / “done” / “clear review”
- They explicitly ask to delete temp files
- They start a **new** prepare-push run (delete previous run folder first, or use a new `run-id`)

Do **not** commit `.claude/tmp/`. Do not leave old run folders indefinitely.

---

## Workflow per repo (Steps 1–4)

Repeat for each repo in the user’s list (and `cd` into each for git/tests).

```
1. Scope     → git state, staging sanity
2. Safety    → secrets / forbidden paths
3. Mechanical → lint + unit tests when staged changes exist (see **`always-apply/no-routine-unit-tests.md`** — this is the primary time agents run suites)
4. Quality   → conventions, rules, security, performance, tests notice
```

Execute in order. Do not skip staging sanity or safety.

### Step 1 — Scope and git state

1. Resolve **`datha_platform/<repo>/`** — must contain `.git`. If not found, list **`reference/repos.md`** and stop for that repo.
2. Collect (from that repo):
   - `git status` (short), branch, staged/unstaged/untracked file lists
3. Load profile from **`reference/repos.md`**.

**Staging sanity** — same checks as before (incomplete feature, unrelated mix, mistaken stage, orphan unstaged). List concrete paths.

### Step 2 — Safety

Apply **`always-apply/env-file-safety.md`** and **`always-apply/context-boundaries.md`**. **BLOCK** on backend `.env`, secrets, `_local/`.

### Step 3 — Mechanical checks

Run unit test command from **`reference/repos.md`** when staged changes exist; fast lint if obvious. Test failures → **BLOCK** for that repo.

⚠️ **Run the linter CI runs, not a proxy for it.** On 2026-09-15 a Go PR passed
`go build`, `go vet` and `gofmt -l` here and then failed MegaLinter on
`gocritic: exitAfterDefer`. `go vet` does not include gocritic, and neither does
a bare `golangci-lint run` — the repo has no `.golangci.yml`, so MegaLinter's
own defaults enable more than the local defaults do. For a Go repo run
`golangci-lint run --enable gocritic ./...`; for a TS repo run
`prettier --check` over exactly the globs `.mega-linter.yml` enables. Check that
file first: it decides what actually gates the PR, in both directions — it is
also what proved an unformatted `.scss` was *not* a blocker, because no SCSS
linter is enabled.

### Step 4 — Code quality

Read **staged diff** (`git diff --cached`). Load `always-apply/`, repo rules, **`rules/lang/`**, relevant **`services/`** / **`platform/`** / **`products/`**.

Review: correctness, conventions, security, performance, type safety, tests (**notice only** — never BLOCK push solely for missing tests).

---

## Cross-service step (multi-repo or triggered single-repo)

Load **`reference/cross-repo-matrix.md`**. Document in **`cross-service.md`** (or inline for single-repo WARN):

- Federation: shell ↔ remotes, ports, manifest, `shelled` routes, MF version pin
- Gateway ↔ backend path/auth alignment
- NATS topology, envelopes, consumers, DLQ
- Chatbot ↔ file delete choreography
- Sibling repos with uncommitted work not in user’s list
- Recommended PR sequence

Cross-service **BLOCK** only for clear breakages (e.g. shell references remote name that no longer exists in remote’s webpack exposes). Coordination gaps are usually **WARN**.

---

## Per-repo report template (`<repo>.md`)

```markdown
## Prepare push — `<repo>` (`<branch>`)

**Staging:** OK | WARN | BLOCK — <one line>
**Safety:** PASS | BLOCK
**Tests:** PASS | FAIL | SKIPPED — <command>
**Lint:** PASS | FAIL | SKIPPED

### Staging notes
- ...

### Must fix (BLOCK)
- ...

### Should fix
- ...

### Nit
- ...

### Missing tests (optional)
- ...

### What's good
- ...

## Repo verdict: **OK** | **FIX** | **DO NOT PUSH**
```

---

## Summary template (`summary.md`)

```markdown
## Prepare push — summary

**Repos reviewed:** repo1, repo2, …
**Run folder:** .claude/tmp/prepare-push/<run-id>/ (ephemeral)

### Cross-service
- (from cross-service.md — top BLOCK/WARN items)

### Per repo
| Repo | Staging | Safety | Tests | Verdict |
|------|---------|--------|-------|---------|
| … | … | … | … | … |

### Must fix (any repo or cross-service)
- ...

### PR coordination
- Suggested ADO PR order: …

## Overall: **OK TO PUSH** | **FIX THEN PUSH** | **DO NOT PUSH**
```

Overall verdict = worst per-repo or cross-service severity.

---

## Rules for this skill

- **At least one repo name** required
- Prefer **staged** diff as push scope per repo
- **Polyrepo:** one ADO PR per service repo (`always-apply/workspace-layout.md`)
- Do not **push** unless user explicitly asks after review
- Do not read backend `.env` files
- Multi-repo: always write temp files under **`.claude/tmp/prepare-push/<run-id>/`**
- Delete temp folder when user is satisfied or starts a new run
- Fixing issues after review is a separate task
