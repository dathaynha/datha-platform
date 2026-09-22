---
name: rule-doctor
description: >-
  Compare platform architecture docs (.claude/docs) against repo code — diff report and doc update suggestions.
  Use for rule doctor, check diff, check rules, check rules vs repo, domain or product
  (chatbot, shell, nats, event-store), check rules align, audit rules, sync rules —
  repo name(s) or domain profile required.
---

# Rule doctor — rules ↔ repo alignment (datha_platform)

**Goal:** Rules describe reality. This skill compares **what rules say** vs **what the repo contains**, then reports **diffs** with recommended **rule updates** (primary) or code drift (secondary).

This is **not** frontmatter/link linting. Do not run deleted mechanical doctors.

## Trigger phrases

Any phrasing that means **“do rules still match the code?”** — provide **repo name(s)** and/or a **domain profile**.

**Domain / product** (expands to many repos — see **`reference/domain-profiles.md`**)

- “rule doctor **chatbot**” / “check rules **product chatbot**”
- “check rules **domain shell**” / “**mfe** rules” / “**platform-ui**”
- “**nats** rule doctor” / “domain **jetstream**”
- “check rules **event-store** product”
- “**interview-prep** rules” / “**platform-dev**” / “check rules **workspace**”

Profiles: **`chatbot`**, **`shell`** (aliases: `mfe`, `shell-platform`), **`event-store`**, **`nats-platform`** (`nats`, `jetstream`), **`interview-prep`**, **`platform-dev`** (`all`, `workspace`).

**Direct (repo)**
- “rule doctor **&lt;repo&gt;**”
- “run rule doctor on **&lt;repo&gt;**”

**Check / diff**
- “check diff **&lt;repo&gt;**” (rules vs repo — not git diff)
- “check rules **&lt;repo&gt;**” / “check rules for **&lt;repo&gt;**”
- “check rules vs **&lt;repo&gt;**” / “check rules against **&lt;repo&gt;**”
- “check if rules match **&lt;repo&gt;**”
- “check rule diff **&lt;repo&gt;**” / “rules diff **&lt;repo&gt;**”

**Align / sync / audit**
- “check rules align with **&lt;repo&gt;**”
- “audit rules **&lt;repo&gt;**” / “audit rules vs repo **&lt;repo&gt;**”
- “sync rules with **&lt;repo&gt;**” / “update rules from **&lt;repo&gt;**”
- “are rules up to date for **&lt;repo&gt;**?”
- “rules out of sync with **&lt;repo&gt;**”

**Compare / verify**
- “compare rules to **&lt;repo&gt;**” / “compare rules and code **&lt;repo&gt;**”
- “verify rules **&lt;repo&gt;**” / “validate rules against **&lt;repo&gt;**”

**Multi-repo (manual):** same verbs with several repo names — e.g. “check rules file-service platform-nats”.

**Disambiguation:** bare **`chatbot`** → **domain** (6 repos). **`chatbot-service`** → single repo. If unclear, ask once.

**Not this skill:** git staged diff, pre-push review → **`prepare-push`**. Broken `.md` links → fix manually or future tooling.

**Input:** one of:

1. **Domain profile** — from **`reference/domain-profiles.md`**
2. **One or more repo folder names** — from **`reference/repo-rules-map.md`**
3. Both — domain + extra repos (union, dedupe)

Ask if missing.

---

## Workflow

```
1. Resolve    → domain profile and/or repo list (domain-profiles.md, repo-rules-map.md)
2. Evidence   → read repo files (alignment-checklist.md) — per repo
3. Compare    → rule claims vs evidence — per repo + product/platform cross-rules
4. Report     → .claude/tmp/rule-doctor/<run-id>/ → show summary
5. Cleanup    → delete run folder when user says ok / done
```

**Truth priority for RULE STALE vs CODE DRIFT:**

1. **Platform canonical rules** (`platform/chatbot-file-events.md`, `platform/platform-nats-architecture.md`, `platform/event-store-architecture.md`) — usually **CODE DRIFT** if repo violates them
2. **Service architecture rules** — if repo clearly evolved and platform rules agree with code → **RULE STALE**
3. **README / .env.example / topology.ts** — strong evidence for **RULE STALE** on ports, env names, routes
4. When uncertain → **UNVERIFIED** + what to inspect manually

Do **not** edit rules or code unless the user asks after seeing the report.

---

## Step 1 — Resolve scope

1. Parse user input for **domain profile** ids/aliases (`reference/domain-profiles.md`) and/or **repo** folder names.
2. **Domain mode:** expand profile → ordered repo list; note **product/platform rules** listed in that profile for `cross-rules.md` / `domain-<profile>.md`.
3. **Repo mode:** use **`reference/repo-rules-map.md`** per repo.
4. **Union** if both given (dedupe repos).
5. For each repo: resolve **`datha_platform/<repo>/`**. Missing folder → **REPO ABSENT** in reports; still audit listed rules for internal consistency where possible.
6. Skim **`always-apply/workspace-layout.md`** — commits are per repo, not workspace root.

**Domain vs single repo**

| Mode | Repos | Extra files |
|------|-------|-------------|
| Single repo | 1 | optional `cross-rules.md` if NATS/MFE touched in findings |
| Multi-repo (manual) | 2+ user-named | **`cross-rules.md`** required |
| **Domain profile** | profile’s full list | **`domain-<profile>.md`** + **`cross-rules.md`** required |

---

## Step 2 — Gather evidence

Follow **`reference/alignment-checklist.md`**. For each repo, build an **Evidence** section:

- Stack & versions (with file paths)
- Routes / modules / key packages
- NATS constants (quote exact strings from code)
- Env vars from `.env.example` only
- CI files present vs rule claims
- Frontend: port, MF remote name, federation config snippets

Quote short snippets or line references — not full file dumps.

---

## Step 3 — Compare

For **each rule file** loaded, walk major sections (Purpose, boundaries, routes, events, env table, repo map, CI).

Record every mismatch using categories:

| Category | Report action |
|----------|----------------|
| **ALIGNED** | Brief confirmation |
| **RULE STALE** | **Suggest concrete rule edit** (section + old → new wording) |
| **RULE AHEAD** | Note planned; no rule delete |
| **CODE DRIFT** | Cite rule + code path; suggest code fix only if user cares |
| **UNVERIFIED** | Missing file or needs runtime |

Cross-repo / domain: compare **product** and **platform** rules against evidence from **all repos in scope** — durable names across `platform-nats` + services, MFE manifest across shell + remotes, `chatbot-file-events` publisher + consumer paths. Record in **`cross-rules.md`**. Domain runs also rollup in **`domain-<profile>.md`**.

---

## Step 4 — Report (temp files)

**Always** write under **`.claude/tmp/rule-doctor/<run-id>/`** (`run-id` = ISO timestamp or short uuid).

### Single repo

```
.claude/tmp/rule-doctor/<run-id>/
├── evidence-<repo>.md    # facts from repo only
├── diffs-<repo>.md       # rule-by-rule comparison
└── summary.md            # counts + prioritized rule updates
```

### Domain profile (product / platform)

```
.claude/tmp/rule-doctor/<run-id>/
├── domain-<profile>.md   # scope, absent repos, product-rule rollup
├── evidence-<repo>.md    # each repo in profile
├── diffs-<repo>.md       # each repo in profile
├── cross-rules.md        # required — product + platform rules across repos
└── summary.md
```

### Multiple repos (manual list, no profile)

Same as domain but omit `domain-<profile>.md` unless user named a profile too.

Show **`summary.md`** in chat. User can open detail files.

### `diffs-<repo>.md` template

```markdown
# Rule doctor — `<repo>`

## Rules reviewed
- services/foo-architecture.md
- ...

## ALIGNED
- [rule §section] — evidence: `path:line` or README

## RULE STALE (update rule)
| Rule | Claim | Repo evidence | Suggested rule change |
|------|-------|---------------|------------------------|
| `services/foo.md` §Key env vars | `SAS_TTL` | `.env.example` has `SAS_DOWNLOAD_TTL_SECONDS` | Rename in rule table to match `.env.example` |

## RULE AHEAD
- ...

## CODE DRIFT
- ...

## UNVERIFIED
- ...
```

### `summary.md` template

```markdown
# Rule doctor summary

**Scope:** domain `chatbot` | repos: chatbot-service, file-service, …
**Run:** .claude/tmp/rule-doctor/<run-id>/
**Absent repos:** (if any)

| Metric | Count |
|--------|-------|
| ALIGNED | n |
| RULE STALE | n |
| RULE AHEAD | n |
| CODE DRIFT | n |
| UNVERIFIED | n |

## Priority rule updates (do these first)
1. ...

## Optional code fixes
- ...

## Cross-repo notes
- ...
```

---

## Step 5 — Cleanup

Delete **`.claude/tmp/rule-doctor/<run-id>/`** when user confirms ok / done / clear, or when starting a new rule-doctor run.

---

## After the report

If user says **“update the rules”**:

- Edit only **RULE STALE** items unless they ask otherwise
- One concern per edit; link to canonical platform rules — do not duplicate narratives
- Mention if change belongs in **`engineering-claude-rules`** later (`rules/platform/engineering-claude-rules.md`)

If user says **“fix the code”** → separate task; rule doctor default is **rule sync**.

---

## Rules for this skill

- **Repo name(s) and/or domain profile** required — resolve via **`domain-profiles.md`**
- Never read backend `.env`
- Prefer **`.env.example`**, README, source, topology over guessing
- **RULE STALE** suggestions must be specific (table row, route path, durable name, port)
- Do not conflate with **`prepare-push`** (pre-push review of staged diffs)
- Repos not cloned → **REPO ABSENT**, not silent skip
- **Domain `chatbot`** is not the same as repo **`chatbot-service`** — disambiguate when ambiguous
