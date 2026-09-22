# Workspace map

`datha_platform/` is a local convenience workspace — **NOT a git repo, NOT a monorepo**. Each top-level folder is its own git repo (ADO), with its own `azure-pipelines/` and PRs. "The repo" always means the service folder being edited. Cross-service changes = coordinated PRs in multiple repos; call that out in summaries.

## Repos

| Repo | Stack | Port | Run | Unit tests |
|------|-------|------|-----|------------|
| `api-gateway/` | Go 1.25, chi, JWT, reverse proxy | 8080 | `go run -mod=vendor ./cmd/gateway` | `go test ./... -count=1 -cover` |
| `accounts-service/` | Node TS, Fastify 5, users/workspaces/memberships, pg | 3006 | `pnpm dev` | `pnpm test` |
| `chatbot-service/` | Python 3.11, FastAPI, SQLAlchemy, Alembic, Redis, Gemini | 8050 | uvicorn `app.main:app` + `python -m app.worker` | `pytest` |
| `file-service/` | Node TS, Fastify 5, Azure Blob SAS, pg | 3001 | `pnpm dev` | `pnpm exec vitest run` |
| `event-store/` | Node TS, Fastify 5, JetStream ingest, pg | 3002 | `pnpm dev` | `pnpm exec vitest run` |
| `notification-service/` | Node TS, Fastify 5, JetStream projection → bell, pg | 3003 | `pnpm dev` | `pnpm exec vitest run` |
| `messenger-service/` | Node TS, Fastify 5, conversations/messages/read state, pg | 3005 | `pnpm dev` | `pnpm test` |
| `realtime-service/` | Go 1.25, chi, coder/websocket, Redis presence, core NATS | 3004 | `go run -mod=vendor ./cmd/realtime` | `go test ./... -count=1 -cover` |
| `platform-nats/` | Node TS — JetStream topology only | — | `pnpm reconcile` | none (skip) |
| `platform-pipelines/` | ADO YAML templates — shared bot-review pipeline | — | — | none (validated by expanding a consumer via the ADO preview API) |
| `platform-observability/` | Docker compose — Grafana 3000, Loki 3100, Prometheus 9090, Alloy 4317/4318 | 3000 | `docker compose up -d` | none (skip) |
| `shell-frontend/` | Angular 21, Module Federation **host** | 4000 | `pnpm start` | `pnpm test` |
| `chatbot-frontend/` | Angular 21, MF **remote** | 4001 | `pnpm start` | `pnpm test` |
| `event-store-frontend/` | Angular 21, MF **remote** (ops UI: events, DLQ replay) | 4002 | `pnpm start` | `pnpm test` |
| `messenger-frontend/` | Angular 21, MF **remote** + shell header widget | 4003 | `pnpm start` | `pnpm test` |

| `shared-frontend/` | Angular lib `@datha/platform-ui` → Azure Artifacts feed | — | `pnpm build` | `pnpm test` (karma headless; `test:watch` = interactive) |

Cross-repo PR note: `platform-pipelines` has no pipeline of its own; its templates are consumed by every other repo's `bot-review.yml`, pinned to a tag.

**Creating a new repo?** Follow `.claude/docs/ci/bot-review-pipelines.md` § New repo — ADO setup checklist. The step that is always forgotten is granting the build service **Contribute to pull requests** on the repo: without it MegaLinter and the PR-Agent failure comment both 403, while PR-Agent's own review still posts, so the PR looks half-broken for no visible reason.

Referenced in rules but not cloned here: `platform-frontends-nx/` (Nx sandbox, non-prod) and the `interview-prep` repos (planned — `interview-prep-service` :3007, `interview-prep-frontend` :4004). **`messenger-service` (3005) and `realtime-service` (3004) are built as of 2026-09-08 (Messenger phase 1) and both are ADO repos as of that date** — Both are fully merged into `main` as of **2026-09-09** (PRs !149 and !150), with `.env` files and the build-service *Contribute to pull requests* grant done — nothing outstanding on either repo. `accounts-service` (3006) and `messenger-frontend` (4003) are built as of 2026-09-06 (Messenger phase 0); both have ADO repos, pipelines and policies (`messenger-frontend` pipeline id 14, policies 29/30). **Messenger phases 2 and 2.5 are merged** (!167-!175 on 2026-09-11, !176-!178 on 2026-09-13): 1:1 audio and video calling, screen share, call history in the thread, and image attachments. The cross-network relay criterion is closed too — see `.claude/docs/platform/platform-backlog.md`. **Phase 3 is in progress** — **slice 0 (group chat UI) merged 2026-09-14 as !179** (`messenger-frontend` only, since `messenger-service` had shipped the whole group surface in phase 1 with no caller) and **slice 1 (the call room model) merged the same day as !180** (`realtime-service` only: invited set + joined set, `call.join`/`call.participant`, targeted signalling with a validated `to`, a 4-person mesh cap, and reconnect). **Slice 2 (call history for groups) merged 2026-09-15 as !181 (`realtime-service`, producer) + !182 (`messenger-service`, consumer + migration `006_call_participants.sql`)** — `platform-nats` needed **nothing**, despite the plan table naming it. **Slice 3 (the mesh in the browser) MERGED 2026-09-15 — !183 (`realtime-service`), !184 (`messenger-service`), !185 (`messenger-frontend`).** Planned as one repo and finished as three, because using it found two structural faults: a conversation had no "one call at a time" guard (a third person pressing Call created a rival call and the browser's glare rule made whoever sorted lower *leave the call they were in*), and `calls.ended_at` could only ever be written by an event from the process most likely to have died, so a crash left a row claiming a call was live forever. Now: an atomic `call:conv:<id>` claim, instance heartbeats plus an orphan reaper, and a time bound on unfinished rows applied at read **and** by a sweep (migration `007_call_expiry.sql`). Reconnect is **click-to-join** — the thread shows the ongoing call and you press Join; the auto-rejoin built first was racy and was deleted the same day. A real **four-way** call is verified against the live stack. **Only slice 4 (docked mini chat windows) is left.** On top of the slices,
**!186 + !187 + !188 merged 2026-09-16/17**: conversations order on a dedicated
`last_activity_at` (migration `008`, tuple keyset cursor), a live call is rung
for a socket that connects late (no SDP — the stored offer is useless by then),
the call stage focuses one source with a local pin, and `MAX_GROUP_PARTICIPANTS`
is 10. **Phase 3 is complete and the messenger product is finished as of 2026-09-17.**
Slice 4 (docked mini chat windows) merged as **!189** — `messenger-frontend`
only, since a connection's open conversations were already a set server-side;
the work was making every thread derivation take a conversation id
(`modules/chats/thread-view.ts`) and refcounting the socket subscription so the
page and a window can hold the same thread. The landing page now describes the
real product (**!190**) and `platform-observability` has `messenger-red.json`,
`realtime-red.json` and `accounts-red.json` with all ten services on the
overview (**!191**).
⚠️ **`platform-observability` has no `azure-pipelines/`**, so its PRs run no
checks at all — not a broken pipeline, an absent one. Tracked in the backlog. **Slice 4 (docked mini chat
windows) is built 2026-09-17 and not yet merged** — `messenger-frontend` only,
since a connection's open conversations were already a set server-side; the work
was making every thread derivation take a conversation id
(`modules/chats/thread-view.ts`) and refcounting the socket subscription so the
page and a window can hold the same thread. See
`.claude/docs/products/messenger-architecture.md` § Phase 3.

**`@datha/platform-ui` is at `v0.6.0` (2026-09-18)** — theme and language are
chip menus rather than dropdowns, platform menus have no tail, and panels centre
on their trigger and clamp to the viewport. Published by `release.yml` on the
`v0.6.0` tag; all four frontends pin it exactly. Adoption PRs !197-!200. The
lesson worth carrying: the **public API was unchanged and nine specs still
broke**, because they drove the rendered DOM — a library bump's cost lands in
the consumers' tests, not their templates. Detail:
`.claude/docs/services/shared-frontend-architecture.md` § v0.6.0.

**Mobile container-query wave merged 2026-09-20/21 — !209-!223.**
`shared-frontend` **!209** + tag **`v0.6.1`**, the four consumers' bumps
(**!219**, **!220**, **!222**, **!223**), the `ubuntu-24.04` agent pin in all
14 repos (**!210-!218**, **!221-!223**), `event-store` **!221** and
`event-store-frontend` **!222**.

Four things worth carrying. **A viewport breakpoint cannot see the shell's
224px sidebar**, so hosted, `event-store-frontend` took a gutter one whole step
too wide across the band where the sidebar shows — and the 2026-09-17 phone
sweep passed because below `sm` the sidebar is replaced by a bottom bar, i.e.
it only looked where the bug cannot occur. All 52 viewport utilities there are
now container queries on a named `es-page` container, proven a no-op standalone
by measurement. **A remote's `PROFILE` block replaced the shell's wholesale**
(`registerRemoteTranslations` merged one level deep), so `PROFILE.SUPPORT` —
which only the shell defines — rendered as a raw key in the profile popup
whenever any remote was mounted; v0.6.1 merges the host baseline leaf by leaf.
**`_ngcontent` bit four separate times in one wave** — a rule written at a
component's top level cannot reach an element PrimeNG built, which silently
cost a sticky column, a button width and two control sizes. And **the ops
lists keep every column on a phone now and scroll sideways with the first
frozen**, reversing the 2026-09-17 decision to drop three of six after dathq
used it.

**The mobile container-query wave is COMPLETE — !224-!226 merged 2026-09-21.**
`chatbot-frontend` **!224** (64 utilities), `messenger-frontend` **!225** (52)
and `shell-frontend` **!226** (its own chrome). Branch
`feat/phone-ui-container-queries` in all three, deleted after merge.

**Zero viewport utilities remain in code** in any of the four frontends: the
greps that still match are inside explanatory comments, plus the shell's own
four `sm:flex`/`sm:hidden`, which are correctly viewport-keyed because the
shell owns the viewport and nothing sits beside it.

Container names, one per product region — named so the containers inside each
tree (the call dock declares a `size` container of its own) cannot capture a
query: `es-page` (event-store, per route), `cb-page` (chatbot, on
`.chatbot-content`), `ms-page` + `ms-chats` (messenger, on
`.messenger-content` and `.chats-root`). Declared on the **layout** rather
than the page root wherever the page's own host carries responsive layout,
because an element cannot query a container it declares.

Every declaration lives in a **component** stylesheet, so it travels with the
federated JavaScript — a host never loads a remote's global sheet.

Six defects were found by verifying the migration rather than by the
migration itself, and each is a rule in `working-agreement.md`: a follow-bottom
pin fighting the user across a 48-120px dead band; the call dock's stage
overflowing a phone because a width was set beside insets; connector labels
uppercasing `createOffer`, a NATS subject and a URL path; a chat reload losing
its thread; the notification toast hanging 45px off the left edge; and a
settings select clipped by a card's `overflow: hidden`.

**Ops-list scaling, payload filtering and file origin merged 2026-09-19/20 —
!205-!208.** `event-store` **!205** (distinct-value endpoints for the service
and sink filters; a capped `COUNT(*)` with keyset continuation past the cap;
`events` partitioned by month with retention dropping whole partitions; UTC
partition bounds; a GIN index making every payload key filterable),
`file-service` **!206** (`origin` on the file events, so the event store can
tell a chatbot attachment from a messenger one), `event-store-frontend`
**!207** (filter options fetched, cursor paging, `@use` migration, loading
announced) and **!208** (the payload filter control).

Four things worth carrying out of it. **A partitioned table's unique index must
contain the partition key**, so ingest's `ON CONFLICT` target moved to
`(id, timestamp)` and retention granularity became the month. **A `timestamptz`
partition bound is parsed in the session TimeZone**, which made the same DDL
build different partitions per caller and would have had retention drop rows
four hours early. **A control the component library builds carries no
`_ngcontent`**, so an encapsulated rule cannot reach it — three sizing defects
in one control came from that. And **`pnpm build` had been nesting the
migrations directory** since the repo was written, so `pnpm migrate` silently
skipped every new migration after the first build.

**Landscape and ops-list wave merged 2026-09-19 — !201-!204.**
`event-store-frontend` **!201**, `chatbot-frontend` **!202**,
`messenger-frontend` **!203**, `shell-frontend` **!204** (test-only).
Responsive rules that are about *room* now use **container queries**, because a
viewport breakpoint cannot see that the shell puts a 224px sidebar beside every
remote: at 667x375 hosted, event-store's table measured 0px tall below the fold,
chatbot's chat column 117px and messenger's stage 119px — all three correct
standalone. Also in the wave: the ops lists' primary/secondary column ink, which
a blanket cell rule at (0,3,2) had been flattening in *both* hosts since those
classes were written; a rebuilt paginator (PrimeNG's has no ellipsis or boundary
pages, so it was replaced by `modules/shared/ops-paginator/`); `.datha-input`
raised from 25.3px to 38px; and `WebrtcCallService.selfOwnerId` resolved from the
access token rather than only from the socket's `ready` frame, which no caller
ever delivered. Detail: `.claude/rules/working-agreement.md`.

**Mobile layout shipped for all four frontends 2026-09-17** — !192
`messenger-frontend`, !193 `chatbot-frontend`, !194 `event-store-frontend`,
!195 `shell-frontend`. The shell gains a bottom navigation bar below `sm`
(640px, the breakpoint messenger's list↔thread collapse already used) with the
sidebar hidden outright; Settings owns theme and language, which had been
disabled placeholders. chatbot swaps its two panes (chat first, history a tap
away — the assistant camp, deliberately not messenger's list-first); event-store
drops secondary table columns; messenger raises touch targets under
`pointer: coarse`.

⚠️ **A Module Federation host never loads a remote's global stylesheet** — it
pulls component styles in with the JavaScript and nothing else. So anything in
a remote's `styles/base.scss` (or what it imports) does not exist at :4000,
silently. This cost two bugs in one day: the docked chat window sized itself
from a custom property that was empty in the shell and fell back to
`width: auto`, and event-store's compact table rules were inert hosted while
passing every check standalone. Values a component's layout needs belong in a
**Sass** constant or in that component's own styles. Guards for both live in
the **shell's** suite, since a standalone remote cannot reproduce either.

**`messenger-frontend` needs `MF_MESSENGER_PUBLIC_PATH` whenever it is reached from another device** — it defaults to `http://localhost:4003/`, which is baked into every lazy chunk request, so the remote loads for the dev machine and nobody else.

Frontends pin exact versions (no `^`/`~`): Angular 21.2.x, MF 21.2.2, pnpm 10.33.2 — mismatch breaks MF DI (NG0919).

## Architecture rules — single source of truth

Canonical architecture docs live in **`.claude/docs/`** — never duplicate their content elsewhere, link instead:

- `always-apply/` — workspace layout, env safety, no dev servers, no routine tests, context boundaries, **local environment** (colima/Docker, PATH LaunchAgent, nvm — read before any machine-setup or infra task)
- `lang/` — Go, Python/FastAPI, TypeScript/Fastify, Angular conventions
- `platform/` — NATS topology, event-store envelope/streams, chatbot-file-events choreography, analytics (deferred)
- `services/` — one rule per repo (read the matching one **before editing that repo**)
- `products/` — cross-repo flows (chatbot, interview-prep)
- `testing/`, `ci/` — test strategy, ADO bot-review pipelines

Before working in repo X: read `.claude/docs/services/<X>-architecture.md` + the matching `lang/` rule. Touching NATS/events: also `platform/platform-nats-architecture.md` and `platform/event-store-architecture.md`. Conversation-delete → file cleanup story lives ONLY in `platform/chatbot-file-events.md`.

## Workflow skills

Real directories under `.claude/skills/` — edit them directly (no symlinks since 2026-08-17).

- `prepare-push` — pre-push review per repo (lint + tests + safety + cross-repo matrix)
- `platform-comeback` — "where did I leave off" git scan across all repos
- `rule-doctor` — audit rules vs repo reality
- `platform-frontend-structure` — Angular feature scaffolding conventions
- `branch-cleanup` — delete local branches across repos, keep main (survey → safety check → delete)
- `run-platform` — start/stop dev servers by product group ("run platform"=core shell+gateway+notification-service, "run chatbot", "run event store", "run all", "stop all")
- `platform-disk` — report and reclaim disk (Angular caches, dist, Docker); called by `run-platform`'s preflight/stop and on any `ENOSPC`

- `suggesting-skills` — propose an existing skill when a workflow is being done by hand (not user-invocable)

Retired with Cursor (kept in `.claude/_retired/`): `suggesting-cursor-rules`, `suggesting-cursor-hooks`.

Cross-repo PR order (from prepare-push matrix): platform-nats → backends/event-store → api-gateway → remotes → shell-frontend last.
