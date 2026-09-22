# Domain profiles (rule-doctor)

A **domain** (product / platform area) expands to a **fixed repo list**. Use when the user says **domain**, **product**, or a profile name instead of listing repos.

Resolve in **`reference/domain-profiles.md`** first. If the token matches a profile here, run **all repos** in that profile (same per-repo workflow as multi-repo mode). Always write **`cross-rules.md`** and a **`domain-<name>.md`** summary for domain runs.

Aliases are case-insensitive; normalize to the profile **`id`** below.

---

## `chatbot`

End-to-end **chatbot product** — UI, API, files, gateway, events, NATS choreography.

| Repos (in suggested review order) |
|-----------------------------------|
| `platform-nats` |
| `chatbot-service` |
| `file-service` |
| `event-store` |
| `api-gateway` |
| `chatbot-frontend` |

**Product / platform rules to cross-check once in `cross-rules.md`** (in addition to per-repo maps):

- `products/chatbot-architecture.md`
- `platform/chatbot-file-events.md` — **canonical** delete → orphan files narrative
- `platform/event-store-architecture.md` — ingest envelope (when event repos in scope)
- `platform/platform-nats-architecture.md` — durables/subjects vs each service `streams.ts`

**Cross-domain checks:** conversation delete outbox + consumer durable names; gateway chatbot/file routes; frontend attachments via gateway; SSE `stream_token`; event subjects ingested by event-store.

---

## `shell` / `mfe`

**Module Federation host + remotes** (platform chrome, not chatbot backend).

| Repos |
|-------|
| `shell-frontend` |
| `chatbot-frontend` |
| `event-store-frontend` |
| `api-gateway` (CORS, auth token proxy URLs in frontends) |

**Cross-check:** ports **4000 / 4001 / 4002**; shell manifest vs remote `webpack` exposes; `route.data.shelled`; MF version pin; gateway URL in each `environment.*.ts`.

Aliases: **`mfe`**, **`shell-platform`**, **`platform-ui`**

---

## `event-store`

**Ops event ledger + DLQ UI remote** (not full chatbot product).

| Repos |
|-------|
| `platform-nats` |
| `event-store` |
| `event-store-frontend` |
| `api-gateway` |

**Cross-check:** ingest subjects vs publishers; gateway `/api/event-store/*` strip; DLQ API vs frontend remote routes; admin-role notes (RULE AHEAD ok).

Aliases: **`event-store-product`**

---

## `nats-platform`

**JetStream topology + all major publishers/consumers** in this workspace.

| Repos |
|-------|
| `platform-nats` |
| `event-store` |
| `file-service` |
| `chatbot-service` |
| `api-gateway` |

**Cross-check:** `topology.ts` durable names ↔ each repo’s NATS constants; per-durable `max_deliver` env keys; **`platform/platform-nats-architecture.md`** vs **`platform/chatbot-file-events.md`** (no duplicate subject stories).

Aliases: **`nats`**, **`jetstream`**, **`platform-nats`**

---

## `interview-prep`

**Interview-prep product** (repos not built yet — documented ahead of build).

| Repos |
|-------|
| `interview-prep-service` |
| `interview-prep-frontend` |

**Rules:** `products/interview-prep-architecture.md`, `services/interview-prep-service-architecture.md`, `services/interview-prep-frontend-architecture.md`, `lang/lang-python-fastapi.md`, `lang/lang-angular.md`

Report **REPO ABSENT** for missing folders; still diff rules against each other for internal consistency.

Aliases: **`interview-prep-product`**, **`profile-match`** (the product it absorbed, 2026-09-21)

---

## `platform-dev`

**Full local workspace** — all ADO repos present under `datha_platform/` (heavy; use sparingly).

| Repos |
|-------|
| All rows in **`reference/repo-rules-map.md`** |

Skip repos not on disk with **REPO ABSENT**. Expect a large `cross-rules.md`.

Aliases: **`workspace`**, **`all`**, **`full-platform`**

---

## Input resolution

| User says | Action |
|-----------|--------|
| `rule doctor chatbot` | Profile **`chatbot`** → 6 repos + cross-rules |
| `check rules domain chatbot` | Same |
| `check rules chatbot-service` | Single **repo** (not profile) — only if `chatbot-service` is not ambiguous |
| `chatbot-service` alone | **Repo** mode (one repo) |

**Disambiguation:** if a token matches **both** a profile id and a repo folder name, prefer **repo** when user says “repo” or the exact folder name with `-service` / `-frontend` suffix; prefer **profile** when user says **domain**, **product**, or bare **`chatbot`** / **`shell`** / **`nats`**.

When unclear, ask: “Whole **chatbot** product (6 repos) or just **chatbot-service**?”

---

## Report layout (domain run)

```
.claude/tmp/rule-doctor/<run-id>/
├── domain-<profile>.md     # profile scope, repos present/absent, product-rule rollup
├── evidence-<repo>.md      # each repo in profile
├── diffs-<repo>.md         # each repo in profile
├── cross-rules.md          # required — MFE, NATS, product rules across repos
└── summary.md
```

**`domain-<profile>.md`** — which product/platform rules were reviewed holistically, top cross-repo RULE STALE items, repos skipped (absent).
