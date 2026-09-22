# Platform backlog (parked items)

_Parked platform work items — explicitly deferred by dathq; do not start unasked_

## Messenger phase 1 — MERGED (2026-09-09)

All **15 PRs merged** (!148-!162), local branches deleted, every repo on `main` and clean. Nothing from phase 1 is in flight.

A follow-up wave the same day added **!163-!166** — logout is now local-only in all four frontends, so it no longer ends the identity provider's own session. Merged and cleaned up too; rationale and the live evidence are in `services/shell-frontend-architecture.md` § Logout is local only. **19 PRs merged on 2026-09-09 in total.**

Phase 1 shipped: `messenger-service` (:3005) and `realtime-service` (:3004) as new ADO repos, the gateway's `/api/messenger/*` + `/api/realtime/{token,ws}` routes, the whole chat UI with attachments, the shell's header widget and launcher tile, and the `events.messenger.>` subject on `EVENTS`. Two platform-wide fixes rode along: the quiet-errors header (an `HttpContextToken` does not cross a Module Federation boundary) and the throttled `otel.SetErrorHandler` in both Go services. A cleanup sweep gave all 11 prettier-using repos an accurate `.prettierignore` comment and all 13 MegaLinter repos an explicit `.yamllint.yml`.

## Messenger phase 2 — MERGED (!167-!175, 2026-09-11)

**All nine PRs merged on 2026-09-11**, local branches deleted, every repo on
`main` and clean. The wave that had been held uncommitted since 2026-09-09 is
shipped: platform-nats **!167**, realtime-service **!168**, messenger-service
**!169**, notification-service **!170**, api-gateway **!171**,
messenger-frontend **!172**, chatbot-frontend **!173**,
event-store-frontend **!174**, shell-frontend **!175**.

One PR needed a second push. MegaLinter's **gitleaks** step failed !168 on a
golden test vector in `internal/turn/turn_test.go` — `base64(HMAC-SHA1(
"test-secret", …))`, entropy 4.38. The value had to stay, because it was
computed outside Go precisely so the test proves coturn interop rather than
agreeing with our own implementation. Fixed with an inline `// gitleaks:allow`,
which had to be **amended into the original commit and force-pushed**: gitleaks
scans git history, so a follow-up commit still reported the leak. Both gotchas
are written into `rules/working-agreement.md`.

### Phase 2, as raised (2026-09-11)

The nine-repo wave was held uncommitted from 2026-09-09 and **raised as nine PRs
on 2026-09-11**, one per repo, in the workspace's usual order:
platform-nats **!167** → realtime-service **!168**, messenger-service **!169**,
notification-service **!170** → api-gateway **!171** → messenger-frontend
**!172**, chatbot-frontend **!173**, event-store-frontend **!174** →
shell-frontend **!175**. The last two are UI-only and independent of phase 2.

**Ordering that actually matters:** !169 binds to the durable !167 creates, and
!172 is inert without !168 and !171. The rest is convention.

Every suite was green at push time: api-gateway 7 packages, realtime-service 8,
messenger-service 65 tests, notification-service 52, messenger-frontend 88,
shell-frontend 36, chatbot-frontend 34, event-store-frontend 24.

One known yellow: event-store-frontend's production build emits a **Sass
`@import` deprecation warning**, pre-existing on `main` and shared by six files
in that repo. Called out in !174 rather than fixed, because migrating it is its
own change.

### The original hold (2026-09-09, extended 2026-09-10)

**Every slice is written and verified; nothing is committed.** dathq's call: "I dont want to push the BE because there might be bugs happen and i dont want to create a branch and pr to fix it. Let the wave go together." **Nine** repos now sit dirty on `main` — seven from phase 2, plus two that joined on 2026-09-10 for UI alignment only (`chatbot-frontend`, `event-store-frontend`); those two are unrelated to phase 2 and want their own branches:

| Repo | What is in it |
|---|---|
| `realtime-service` | signalling relay, live call state, `call.*` JetStream events, `/turn-credentials`, per-connection rate limiter, `internal/kv` extraction — **102 Go tests** |
| `messenger-service` | `003_calls.sql`, the repo's **first** JetStream consumer, two history routes — **65 specs** |
| `api-gateway` | one route: `GET /api/realtime/turn-credentials` |
| `platform-nats` | the `messenger-service-calls` durable (reconciled) |
| `notification-service` | `call.missed` → bell mapping |
| `messenger-frontend` | `WebrtcCallService`, `RingAudioService`, the call dock, the `calls` nightly Playwright project, composer spacing fix, dialog-reset fix — **77 karma + 22 Playwright** |
| `shell-frontend` | `AccountSyncService` (see below), `CALL_MISSED` i18n, declared CommonJS deps — **36 specs** |

| `chatbot-frontend` | **2026-09-10, unrelated to phase 2** — inset-panel layout aligned with messenger, theme tokens split into `chat-page.theme.scss` (SCSS budget), gutter regression spec — **34 karma + 55 Playwright** |
| `event-store-frontend` | **2026-09-10, unrelated to phase 2** — theme tokens split out of the DLQ and events list sheets (SCSS budget) — **24 karma + 39 Playwright** |

Plus `_local/docker-compose.yml` gained coturn (unversioned — `_local/` is not a repo).

**Verified:** coturn relays for real (Chrome, forced relay, 17 KB each way); a forged credential gets zero allocations; call events land in `EVENTS` with correct envelopes and replay into 3 rows from 10 projections; a missed call puts a bell row on the **callee**. Guards proven to fail without their code in every repo.

**Not verified: a real two-party browser call.** The `calls` Playwright project exists and refuses to run without api-gateway's real `JWT_SECRET`, which is dathq's to supply — agents never read a backend `.env`. Also unverified: the cross-network relay exit criterion (needs `TURN_EXTERNAL_IP` + a router port-forward), and UDP relay is **impossible locally** because colima does not forward published UDP ports (TCP relay works; detail in `always-apply/local-environment.md`).

**A phase-0 gap surfaced and was fixed:** nothing had ever called `POST /users/me/sync`, so the user directory was empty and nobody could find anyone to chat with. See `services/shell-frontend-architecture.md` § Account provisioning.

Explicitly deferred work. Do **not** start any of these without the user asking; do reference them when related work makes one cheap to fold in.

| Item                                             | Deferred to / trigger                                                                                                       | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **✅ `.claude/` is backed up — DONE, verified 2026-09-21** | was: hard deadline 2026-09-23 | The minimal option in this row was taken and had simply never been written back here. The workspace root is the ADO repo `datha-platform-workspace-local`, tracking `CLAUDE.md`, `.claude/` and `_local/` and ignoring the 16 service repos. Verified rather than assumed: `git ls-files .claude` returns **58** files — 41 `docs/`, 3 `rules/`, 13 `skills/`, `settings.local.json` — `.gitignore:26` covers `.claude/tmp/`, and no `.log` or `tmp/` file is tracked. Pushed. **What is left is not durability but ergonomics:** on a new machine the restore is `git clone` into the workspace path, which `docs/always-apply/the setup notes` covers. The richer `engineering-claude-rules` repo (rules catalogue + manifests + `install`/`update`/`doctor` CLI + lockfile, specced in `platform/engineering-claude-rules.md`) stays a real project for later, not a pre-deadline task. |
| **Messenger — chat + WebRTC calling** | **PHASE 1 MERGED 2026-09-09** (15 PRs, !148-!162; phase 0 was !143-!147) — phase 0 merged (!143/!144/!145/!146/!147, branches deleted). `messenger-service` (:3005) is **built and verified live**: conversations, messages, idempotent sends, read watermark, derived unread, both publish paths, **40 specs** — spec in `services/messenger-service-architecture.md`. `platform-nats` gained `events.messenger.>` on `EVENTS` (reconciled and committed, PR **!148** — merge first). **`realtime-service` (:3004) is built too** — sockets, presence, typing, owner fanout, **53 Go tests** — with the gateway's `/api/messenger/*`, `/api/realtime/token` and `/api/realtime/ws` routes, and the frontend's `RealtimeService` driving a live unread badge (covered by the counts below). **The chat UI is built** (list, thread, composer, optimistic send, presence, typing, receipts, badge, popover — **53 karma specs and 20 Playwright cases** in `messenger-frontend`, **31 + 31** in `shell-frontend`). **Attachments are built too** — brokered by messenger-service, since file-service is owner-scoped and cannot serve a recipient. **ADO repos, pipelines, policies, `.env` files and the build-service grant are all done (2026-09-08)** — pipelines 15/16, policies 31/32 and 33/34. All 15 PRs merged 2026-09-09 and local branches deleted. Next: phase 2 (WebRTC), starting with coturn in `_local` | Messenger-style product: chat, presence, attachments, and **1:1 audio/video over raw WebRTC** (the point is practising WebRTC, so phase 2 hand-builds `RTCPeerConnection`, perfect negotiation and trickle ICE rather than adopting an SFU). Four new repos — `accounts-service` (3006), `realtime-service` (Go, 3004), `messenger-service` (3005), `messenger-frontend` (4003) — plus coturn in `_local`. It carries **both** a header widget (a second federated module from the remote, rendered into a config-driven slot) **and** a launcher tile for `/messenger` — dathq reversed the original "ambient products are not app tiles" rule on 2026-09-06. Full plan, phases and exit criteria: **`products/messenger-architecture.md`**; socket service: **`services/realtime-service-architecture.md`**; slot contract: **`services/shell-frontend-architecture.md`** § Header widget slots. **Done so far:** `accounts-service` (12th… now 13th repo) live on **:3006** with `POST /users/me/sync`, `GET /users/me`, directory search and batch lookup, one shared `datha-platform` workspace, pipeline + policies + build-service PR permission all set. `api-gateway` routes `/api/accounts/*` and forwards the JWT `picture` claim as `X-User-Picture` (merged, !136), which accounts-service stores — so the avatar now flows end to end. **Next:** wire `SHELL_CONTEXT` (hard prerequisite), the shell header-slot registry, then the `messenger-frontend` remote at :4003. Plan: **`products/messenger-architecture.md`**. **New repo live:** `messenger-frontend` exists in ADO (pipeline id 14, policies 29/30, build-service PR grant done 2026-09-06) with `main` holding the scaffold and the app code arriving via !143. Phase 0 also swept the frontends: token logging removed, dead sessions now redirect to `/login`, the pre-federation `MicroFrontendsService` postMessage bridge deleted (a 27-line `ThemeService` kept the one live path), and the API bearer no longer leaks onto IdP/token-proxy 401 retries. | **Phase 0 closed 2026-09-06:** the shell's header-widget registry (`environment.headerWidgets` → `HeaderWidgetHostComponent`, silent degradation when a remote is down) and `messenger-frontend` on **:4003**, exposing `./Module` (Overview + `/messenger/chats`) and `./HeaderWidget` (default export). It is both a header widget **and** a launcher tile — dathq's call 2026-09-06, since the Overview page makes it a real destination. `SHELL_CONTEXT` needed no work — the shell already provided it at root. `registerFloatingView` is **deferred to phase 2** with the call dock, since it lives in `@datha/platform-ui` and would cost a lib release plus a bump in every consumer for something nothing renders yet.
| **DONE 2026-09-10 — SCSS budget warnings** | Split, not bumped — nothing outstanding | Theme tokens moved into `*.theme.scss` beside each component sheet (`chatbot-frontend/chat-page`, `event-store-frontend` DLQ + events lists), which is a real separation of concerns *and* puts each sheet under Angular's 10 kB `anyComponentStyle` budget. All four frontends now cold-build `build:prod` with 0 warnings. |
| **Mobile UI is unstyled, all four frontends** | **TRIGGER FIRED** — messenger finished 2026-09-17, so the "after messenger" condition is met. **Survey measured 2026-09-17 — see § Mobile UI survey.** Design and fixes still need dathq's go. | Seen first-hand on 2026-09-13, when a phone on 5G joined a call through a Cloudflare tunnel: the app **works** on a phone — it loaded, signed in, rendered the thread, negotiated a video call and carried relay media — it just looks wrong doing it. Nothing here is a functional defect, which is why it is parked rather than fixed. **Scope is all four frontends, not messenger alone:** `shell-frontend`'s toolbar and launcher are the first thing a phone sees, and `chatbot-frontend` / `event-store-frontend` have never been opened on one at all. **What is already known:** the chat thread and conversation list do reflow at ~400px and the composer stays clear of the viewport edge (both asserted by Playwright at that width), and image bubbles are capped so nothing overflows horizontally. So the bones are responsive; what is missing is a **design** for small screens — touch target sizes, the list↔thread transition, the call dock on a phone, and the shell chrome. **What is NOT known:** nobody has looked at the call dock, the launcher or either ops UI on a phone. Do not assume the messenger findings generalise. **When it starts:** measure before designing — drive each frontend at 390x844 and 360x800 in headed Chrome, screenshot every route, and write the list from what is on screen rather than from taste. The call UI cost ~8 rounds of reported bugs on 2026-09-11 precisely because it was reasoned about instead of looked at (`rules/working-agreement.md` § Build UI, then LOOK at it). |
| **Gateway admin role**                           | Before any prod story for event-store ops                                                                                   | See `services/api-gateway-architecture.md` / `platform/platform-nats-architecture.md` future tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Observability phase 3**                        | On ask                                                                                                                      | Tempo + OTel traces (`trace_id` ↔ `correlation_id`); Grafana alert rules — needs a contact point first: notification-service webhook ingest route (or Grafana→NATS bridge), it is event-driven only today. First alert: `up{job="chatbot-worker"} == 0` (dead worker = silent SSE hang, caught client-side by stream watchdog 2026-07-30) — plan in `platform/platform-observability.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Native mobile app**                            | Far future, on ask                                                                                                          | dathq's call 2026-08-03: mobile (incl. iOS notifications) will be a native app, NOT a PWA — do not build manifest/install/iOS-web-push paths. Web Push stays desktop+Android browser scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Backups / DR + prod readiness**                | Prod story (far off — long before any deploy)                                                                               | No backup for Postgres volumes or JetStream data (colima local only). Before prod: pg_dump/WAL strategy, JetStream file-store snapshot, secret manager (replace local `.env`), domain + Cloudflare front (notes 2026-07-29 conversation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **ADO settings as code (Terraform)**             | On ask — before starting: crawl existing repo policies/settings across all ADO repos, present inventory + plan, WAIT for go | `microsoft/azuredevops` provider in new `platform-ado/` repo: `azuredevops_git_repository` + `azuredevops_branch_policy_auto_reviewers`/`_min_reviewers`/`_build_validation` per repo via shared module; one-time `terraform import` of 9 existing repos + policies. Interim: policies clicked manually (platform-observability got auto-reviewer dathaynha@gmail.com by hand, 2026-07-29). Shape of the policy applied by hand, for the `terraform import` baseline: required-reviewers policy type `fd2167ab-b0be-447a-8ec8-39368250530e`, `isBlocking: true`, `isEnabled: true`, `minimumApproverCount: 1`, `creatorVoteCounts: true`, one entry in `requiredReviewerIds`, scope `matchKind: DefaultBranch` with null `repositoryId`/`refName` (i.e. project-wide default branch)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Server-synced UI preferences**                 | With accounts-service build                                                                                                 | Language, theme, sidebar-collapsed synced across machines — belongs to accounts-service (user profile concern), NOT notification-service. Shell settings hub already shows Appearance / Language & Region as "coming soon" cards; noti `locale` stays in notification_preferences (needed at render time), mirrors the synced language                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **DONE 2026-09-06 — test files are typechecked** | PRs !137 accounts-service, !138 event-store, !139 file-service, !140 notification-service all merged; template `v9` | `tsconfig.test.json` + `typecheck:test` in all four Fastify repos, and `stack-node-vitest` runs it in CI between the suite and knip. Found real errors in three of four repos — metrics mocks cast `as never` (which silently disables every property check), an argument-count mismatch, an unused import. Two lessons cost a broken tag `v8`: `pnpm install` lives in `steps/unit-tests.yml` so any step needing `node_modules` goes after it, and the ADO preview API expands YAML without running a step so only a **canary run** validates a template change. Detail: `ci/bot-review-pipelines.md`. |
| **DONE 2026-09-05 — Angular `pnpm test` scripts** | PRs !132 shell, !133 chatbot, !134 event-store, !135 shared — all merged 2026-09-06 | `shared-frontend`'s `test` was `ng test platform-ui` with **no `--no-watch`**, so it sat in karma watch mode forever (killed during the 2026-09-04 prepare-push). The other three Angular repos had the same bare `ng test` and only dodged it because `reference/repos.md` spelled the flags out by hand. All four `test` scripts are now byte-identical to the `stack-angular-karma` default `testCommand` (`--no-watch --browsers=ChromeHeadless --no-progress`), so `pnpm test` is exactly what bot-review runs; the interactive mode moved to a new `test:watch` script, matching the existing `e2e`/`e2e:ui` variant pattern. Verified all four: 18/26/16/32 specs, every one exits (7-17s). `reference/repos.md` and `rules/workspace-map.md` now say `pnpm test`. |
| **`packtech` as a platform product**             | When a recruitment/ATS-shaped product comes up — on ask                                                                     | `packtech` is an **external** recruitment app in its own folder outside `datha_platform/`, not part of the platform and not one of its repos. dathq's intent (recorded 2026-08) is to reuse it as **prototype/inspiration** for a future platform product rather than to import it — so treat it as a reference design, and do not wire it into the platform's repos, pipelines or NATS topology unasked. Its containers (`pr*`) and volumes (`packtech_recruitment_*`) are managed from that folder, never from `_local/` — see `always-apply/local-environment.md`. **Its source was deleted 2026-09-08**, so the inspiration is now whatever is in dathq's head plus the remote repo; the two Postgres/Redis volumes survive but have no compose to start them. **Partly closed 2026-09-21:** packtech's two flagship AI features were the AI interview and AI job recommendation, and dathq extracted them to `_local/legacy/AI-INTERVIEW-PRACTICE-SPEC.md` before the source went. Both now live in the platform as `interview-prep` — the interview as the product itself, job recommendation as the JD-library ranking at step 9. The ATS around them is deliberately not reused: it assumed recruiters and candidates, and this product has one user who is both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **DONE 2026-09-05 — shared pipeline template rollout** | Merged; nothing outstanding | All 9 PRs (!123-!131) merged and their branches deleted. Every repo's `main` extends `platform-pipelines` at **`refs/tags/v7`** — node/vitest (`event-store`, `file-service`, `notification-service`), angular/karma (`shell-frontend`, `chatbot-frontend`, `event-store-frontend`, `shared-frontend`), python/pytest (`chatbot-service`), go/gotestsum (`api-gateway`). **~2,500 duplicated lines removed.** The PR-comment story landed inside those PRs (`v6` + `v7`): no duplicate `Failed to review PR` threads, and a green run clears the `❌` a failed one left — both verified on live runs. `v7` is now consumed, so it is immutable; a future template edit takes a new tag, and its entries must be added to the `ExtendsCheck` first. |
| **DONE 2026-09-05 — Required Template check on `platform-bot-review`** | Live, check id 6, verified | The Key Vault-linked variable group carrying the bot-review secrets now has an **`ExtendsCheck`**: a pipeline may consume those secrets only if it extends one of the four approved stacks at `refs/tags/v7`. Verified with manual runs of two different stacks — `event-store` (node/vitest, 377) and `api-gateway` (go, 378), both green. **The gotcha that cost three failed probes: `repositoryType` must be `"git"`** — not `azureRepo`, not `azureReposGit`, and the check reports no reason anywhere when it rejects. `repositoryName` is `DatHa Platform/platform-pipelines` (project prefix included). See `ci/bot-review-pipelines.md` § Required template check for the payload and the tag-bump order. |
| **DONE 2026-09-05 — `platform-pipelines` guarded** | Set by dathq after the rollout went green | `main` has **Required reviewers, blocking, `minimumApproverCount: 1`, `creatorVoteCounts: true`** (he is the only reviewer, so requestors must be able to approve their own changes; `blockLastPusherVote` stays off for the same reason). `resetOnSourcePush` is not enabled — optional. No Build policy is possible: that repo has no pipeline of its own. **Tags: nothing to set.** Read back from the ACL, *Force push (rewrite history, delete branches and tags)* is `Not set` for both **Contributors** and **Project Administrators** on `repoV2/<proj>/<platform-pipelines>`, so no ordinary member can move or delete a consumed tag. Only the collection owner can — proven by this session deleting and re-pushing `v6`/`v7` — and that right cannot meaningfully be revoked from himself. The tag-pinning convention plus this ACL is the whole control. |
| **Node 26 bump**                                 | ~Oct 2026, when Node 26 goes LTS — dathq's standing decision, not a question to re-ask                                      | All 8 Node repos are on **Node 24** (2026-09-04). Node 24 drops to maintenance the moment 26 becomes Active LTS, so this is expected, not optional. Scope is mechanical and known: `.nvmrc`, `engines.node` (`">=26 <27"`), `@types/node` (exact in the 3 frontends + `platform-nats`, caret in the Fastify services), and the **9 pipeline files** (7 `bot-review.yml` + `shared-frontend/release.yml` + `platform-nats/jetstream-reconcile.yml`). Verify per repo type exactly as the 24 bump was verified — prod build + karma for frontends, `ng-packagr` for the lib, `vitest` for the services, and a live `pnpm reconcile` for `platform-nats` (its only real check); confirm the lockfile **package-set** is unchanged apart from `@types/node`/`undici-types`, since raw line count is misleading (peer suffixes). **Check corepack before assuming the pipelines still work:** every `bot-review.yml` and `release.yml` runs `corepack enable` + `corepack prepare pnpm@10.33.2 --activate`; corepack is bundled today (0.35.0 under Node 24.18.0) but Node has stated an intent to unbundle it, so if a future major drops it every pipeline loses pnpm at once — verify on the new image first and install pnpm explicitly if it is gone. Sweep the non-obvious pins too: the two frontend `Dockerfile_Local` builder images and README prerequisite lines (both were missed by the 24 bump until an audit caught them). Recipe and MF reasoning: `always-apply/workspace-layout.md` § Node version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **`int` environment + E2E API-hitting specs**    | On ask — `int` is the prerequisite, the specs are the payoff                                                                | The deferred **integration tier**, `int` (defined in `testing/e2e-testing-strategy.md`). Nothing is deployed anywhere today — colima local only, and every repo has just `bot-review.yml`, no deploy pipeline. **Already scaffolded:** all 3 frontends carry `src/environments/environment.int.ts` + an `integration` build config in `angular.json`, with placeholder hosts (`https://api-int.example.com`, `shell-int`/`chatbot-int`/`event-store-int.example.com`) and placeholder `YOUR_ENTRA_CLIENT_ID` / `YOUR_GOOGLE_CLIENT_ID` — so the frontend side is wiring, not design. **The Dockerfiles are dormant, not proven.** `chatbot-frontend`, `event-store-frontend` (`Dockerfile` + `Dockerfile_Local`), `api-gateway` and `chatbot-service` carry Dockerfiles, but **no pipeline runs `docker build`** and nothing is deployed anywhere — so they are unverified config that drifts silently. Proof: the 2026-09-04 Node 24 audit found `node:22-alpine` builder images, an unpinned `nginx:latest` runtime stage, and `api-gateway` pinned to `golang:1.22-alpine` while its `go.mod` requires **1.25.0**. All fixed and the gateway image now builds, but treat every Dockerfile as suspect until a pipeline builds it, and note the 3 Fastify services and `shell-frontend` have **no** Dockerfile at all. **Still needed:** a host for 5 backends + 3 static frontends; its own Postgres/Redis/NATS (never point `int` at prod data); OIDC app registrations whose redirect URIs match the `int` hosts; secrets via the existing Key Vault variable group pattern (`ci/bot-review-pipelines.md`); `platform-nats` reconcile run against the `int` cluster to create topology before any service starts; deploy pipelines per repo. **Then the specs:** `E2E_JWT_SECRET` from Key Vault (gateway accepts minted tokens) or `E2E_AUTH_MODE=refresh` via the gateway token proxy; cross-service flows (delete-chat → NATS → file cleanup, ingest → DLQ → replay) in a **nightly** `e2e.yml` against `int`, **never a PR gate** — `testing/e2e-testing-strategy.md`. This is the rehearsal for the prod row below: same pipelines, cheaper tier, and it is where mock drift in the PR suite gets caught. |

Done recently (context): **event-store-frontend E2E suite + e2e typecheck + Node pin sweep — shipped 2026-09-04** (PRs 105 `chatbot-frontend`, 106 `event-store-frontend`, 107 `shell-frontend`, 108 `event-store`, 109 `file-service`, 110 `notification-service`, 111 `shared-frontend`, 112 `platform-nats`, then 113 `platform-nats` aligning its pipeline Node 20 -> 22 — all merged) — 39 Playwright specs (auth/sub-header 8, events list 9, events detail 5, DLQ list 6, DLQ detail 11) against standalone :4002, route-mocked gateway with a URL-dispatcher stub, request recorder and unmocked-request tripwire; CI step after unit tests. Closes the last frontend without a suite — the v0.5.0 sub-header there had only ever been checked by hand. Found and removed a dead `DLQ_PAGE.TABLE.ORIGINAL_SUBJECT` key. Shell suite backported the same patterns: shared `notification-api-mock.ts`, tripwire, `workers: 1` locally, and the stale pre-v0.5.0 workaround selectors replaced with real accessible names. All 3 frontends gained `tsconfig.e2e.json` + `typecheck:e2e` (Playwright transpiles with esbuild and never typechecks) and `@types/node` pinned to the pipeline's Node major; all 8 Node repos gained `.nvmrc` + `engines.node`, and `platform-nats` moved off Node 20 (EOL April 2026; its own `@types/node` already targeted 22) so every pipeline, `.nvmrc` and `engines` now agree on **Node 22** — validated by a `pnpm reconcile` run under Node 22.19.0 against local NATS, which is that repo's only real check. Detail: `testing/e2e-testing-strategy.md`, `always-apply/workspace-layout.md` § Node version. **Lib chrome extraction v0.5.0 + app-descriptor i18n — shipped 2026-09-03** (`shared-frontend` PR 101 → tag `v0.5.0` published to `platform-npm` by release run 251; adoption PRs 102 `chatbot-frontend`, 103 `event-store-frontend`, 104 `shell-frontend`, all merged, consumer pins on the published 0.5.0) — `datha-sub-header` (router-anchor tabs, projected actions), `--datha-chrome-*` tokens, `styles/chrome` mixins (`ambient`, `content-surface`), the two lib a11y nits (profile trigger `[ariaLabel]`, `DIALOG.*` footer keys so the footer no longer shares "Close" with the panel X) and shell `environment.apps` reduced to routing config with `APPS.<REMOTE>.NAME/DESCRIPTION` keys. Fixed two latent bugs on the way: chatbot's tabs used non-existent `'Overview'`/`'Chat'` keys (English-only in German), and a remote `NAV.*` namespace hid the shell's `NAV.HOME` (remotes now own `SUBNAV.*`). Net **-693/+375** across the four repos: the two remotes' layout SCSS was byte-identical apart from the class prefix and each shed ~200 lines. Detail: `services/shared-frontend-architecture.md` § v0.5.0. **Prettier baseline + local linter parity 2026-08-28** — explicit `.prettierrc` (defaults), `.prettierignore`, `prettier ^3.8.1` and `format`/`format:check` in all 7 clean TS repos (`shared-frontend`'s divergent config replaced); `black`/`isort` in chatbot-service `requirements-dev.txt`; `golangci-lint` + `yamllint` installed. Scope is `.ts`/`.json` only — that is what MegaLinter gates. All 8 TS repos done (chatbot-frontend included). Detail: `ci/bot-review-pipelines.md`. **Chatbot generation retry + model pin shipped 2026-08-27** (merged 2026-08-28 in the PR 91–100 wave) — layer 1 (worker retries 429/500/502/503/504 + transport errors, only before the first chunk, `retrying` frame, `retried`/`retry_exhausted` metrics), layer 2 (`POST /conversations/{id}/retry-last` + gateway `retryLastHandler` + "Try again" on the newest error bubble) and the explicit model pins `gemini-3.6-flash` / `gemini-3.5-flash-lite`. Verified live: a retry job took 503 → 503 → 200. See `products/chatbot-architecture.md` § Generation retry. **Chatbot stream re-attach shipped 2026-08-27** — written 2026-08-17, verified live against real Gemini, merged as PRs 88 (chatbot-service `active-job` endpoint + `conv_active_job` key), 89 (gateway token injection shared with POST /messages) and 90 (frontend re-attach, per-frame chunk batching, jump-to-latest button, 48-spec Playwright suite); see `products/chatbot-architecture.md` § Stream re-attach. **Playwright E2E suite shipped** — shell PR 44 (15 specs, seeded auth, CI step; found+fixed the canLoad deep-link bug); lib v0.3.3 dialog seam fix (mask carries the blur — PR 43) + all 3 frontends bumped (PRs 44–46); lib v0.3.2 + full adoption wave (PRs 39–42, 2026-07-29); bot-review Key Vault rollout complete.

### 2026-09-10 — a full day of reported UI/UX defects, all fixed

Everything below was found by dathq using the running app, fixed, and proven to
fail against the old code first. Detail lives in
`products/messenger-architecture.md`; this is the index.

| Reported | Root cause |
|---|---|
| Panes touching, one flat sheet | Sidebar and stage met on a hard `border-r`. Now inset panels with a gutter; **chatbot aligned the same way** |
| Nobody in the directory | (2026-09-09) nothing had ever called `POST /users/me/sync` |
| Wrong name on a direct chat; own typing echoed back | **`id_token.sub` is the raw provider subject; the `owner_id` is only in the gateway-minted access token.** Fails silently — the id matches nothing, so "which of these two is me?" answers "neither" and the UI picks the first participant for everyone. Also meant own messages rendered as the other person's |
| "X is typing…" never cleared | No `typing.stop` on an emptied box, and nothing ever expired an entry |
| Read state only on send | `document.hasFocus()` was checked once on arrival with no listener to re-check; `resyncUnread()` was documented as running on tab focus and had no subscriber |
| Conversation created on picking a person | Now a draft at `/chats/new/:ownerId`; the row is created by the first message |
| Name + time in every bubble | Bubble holds content only. Read state is one marker at the foot of the thread, and only while our message is the newest |
| Ugly read tick in the bubble | Surveyed WhatsApp/Telegram/iMessage/Messenger/Slack/Discord: read state is a property of the **conversation**. Now reader avatars |
| Dead strip down the right | The trailing slot reserved the hidden timestamp's width (63px). Now anchored absolutely to the bubble |
| Empty pane flash on reload | The stage waited for the conversation **detail** though the id was known; and `loadingThread` covered only the *messages* fetch, so a loading thread fell through to "No messages yet". Skeleton now |
| Call modal in the header corner | **`backdrop-filter` on the shell toolbar creates a containing block for `position: fixed`.** Dock re-parented to `body`; incoming call is a centred modal |
| Muted mic icon blank | **`pi-microphone-slash` does not exist in PrimeIcons 7** (nor `pi-phone-slash`). A missing icon class renders nothing, silently |
| Call flow "still kinda ugly" | Dock is one row with equal-size circular controls; no mute while dialling |

**Two product bugs found by chasing "flaky" specs** (neither was flakiness):
a local send, and an inbound `message.new`, were both **dropped** when they
raced the first page fetch — the response cannot contain a message that did not
exist when it was requested. Fixed in `appendToThread` (`local` or active
conversation seeds the thread) and `setThread` (merges instead of overwriting).
Both pinned by deterministic unit specs.

**Test-infrastructure defects fixed the same day:** an unbounded
`waitForEvent`, `expect.poll`'s 5s default against a loaded machine, and a
single-sample read racing the reflow it measured. See
`testing/e2e-testing-strategy.md` § Timeouts that are not the test timeout.

**Suite counts at end of day:** messenger-frontend **88 karma / 35 Playwright**
(5 consecutive clean full runs), shell-frontend **36 / 32**, chatbot-frontend
**34 / 55**, event-store-frontend **24 / 39**. All four frontends cold-build
`build:prod` with **0 warnings** — the SCSS budget rows below are now done.

### ✅ A real two-party call is VERIFIED (2026-09-10)

dathq handed over the local `JWT_SECRET`, so the `calls` project finally ran.
**Both specs pass, four consecutive runs.** Real WebRTC between two browser
contexts through the live stack: ICE connects, the duration ticks, the call
**survives leaving Messenger**, hangs up cleanly, and a declined call tells the
caller it was declined. That closes the phase 2 exit criterion.

Running it needs the secret, which agents never read from `.env`:

```
cd messenger-frontend && E2E_JWT_SECRET="$(grep '^JWT_SECRET=' ../api-gateway/.env | cut -d= -f2-)" pnpm exec playwright test --project=calls
```

**The suite itself had three defects that had kept it from ever passing** — it
had never been run before today, so none of them were product bugs:

1. **`page.goto("/chatbot")` for the navigation criterion.** A `goto` is a full
   document load: it tears down the SPA, the header widget and the
   `RTCPeerConnection` with it. No web app survives that, so the assertion
   could never pass. Now it **clicks the shell's own link** (client-side
   routing), which is what the criterion actually means.
2. **It navigated to `/chatbot`, which mounts a remote.** With :4001 stopped
   the shell shows "App Unavailable" and stays put. Now it goes to **Home**,
   which is shell-owned chrome — so the suite needs only the messenger group.
3. **It never waited for the callee's socket.** The call button is only enabled
   while `connected()`; asserting it on the caller alone let the invite fan out
   to an owner subject nobody was listening on, so the callee never rang. Both
   sides are awaited now. It also used one module-level identity pair for both
   tests, which meant a shared conversation and leftover call state.

**Prerequisite for anyone re-running it:** the messenger group must be up
(`run messenger` — shell :4000, gateway :8080, realtime :3004,
messenger-service :3005, messenger-frontend :4003, plus Postgres/NATS/coturn).

⚠️ **Rotate that secret.** It was pasted into a session transcript on
2026-09-10. Change `JWT_SECRET` in `api-gateway/.env` and restart the gateway;
nothing else reads it, and every existing browser session simply re-logs in.

## Phase 2 is CLOSED (2026-09-11) — one criterion carried forward

dathq tested calling live on 2026-09-11, confirmed it works in both directions
and called phase 2 done. The phase table in
`products/messenger-architecture.md` is marked ✅ accordingly.

**The tunnel run found a real bug that no same-machine test could.**
`messenger-frontend/webpack.config.js` defaults the Module Federation
`publicPath` to `http://localhost:4003/`. `remoteEntry.js` loaded fine on the
phone — it comes from the URL the shell was told — but every **lazy chunk it
then requested** was addressed to `localhost:4003`, which on a phone is the
phone. Two failures at once: nothing listening, and `http://` from an `https://`
page is blocked as mixed content anyway. It passes on the dev machine for the
worst possible reason: there, `localhost:4003` really is the dev server. The
variable already existed (`MF_MESSENGER_PUBLIC_PATH`) but its README documents
it for `build:prod` only — a remote served from anywhere other than localhost
needs it **in dev too**.

**The cross-network relay criterion is SATISFIED, 2026-09-13.** A video call
between this laptop (home FTTH behind CGNAT) and a phone on **5G** connected
**through a TURN relay** and carried live audio and video:

| Measured on the laptop, from `getStats()` | |
|---|---|
| nominated pair | `prflx 116.96.44.46` ↔ **`relay 172.104.172.212`**, UDP |
| pair state | `succeeded`, RTT **121 ms** |
| received | 9.6 MB — audio 1,633 packets / **0 lost**, video 8,252 packets / **0 lost**, 973 frames decoded |

Setup: three Cloudflare quick tunnels (shell :4000, gateway :8080, messenger
remote :4003), both people signed in with real Google accounts, the phone on
5G with wifi **off**. `JWT_SECRET` was rotated before the first tunnel run, as
the warning below required.

**The assumption this row used to carry was wrong, and it cost two failed
calls.** It said both peers "reach coturn *outbound*, so nothing has to be
reachable from outside". Outbound reachability is not the issue: a TURN server
has to be at an address the *other* peer can send to, and `TURN_URLS` pointed
at `127.0.0.1:3478`. The relay candidate the laptop allocated was a loopback
address, useless to the phone, and the phone could not reach the server at all.
Both calls ended `ice_failed` after being answered — signalling was never the
problem.

**Port-forwarding is not available on this connection.** The router's WAN is
`10.138.78.140` — a private address, so VNPT runs CGNAT and the public
`116.96.44.46` is shared. No port forward can reach this machine, whatever the
router is configured to do. Checked directly in the router's WAN status page.

**What actually worked: a hosted relay.** `realtime-service` could only speak
coturn's `use-auth-secret` HMAC scheme, so no hosted provider could be used at
all; it now also accepts a fixed `TURN_USERNAME`/`TURN_PASSWORD` pair, which is
what every hosted relay hands out. See `services/realtime-service-architecture.md`
§ TURN credential schemes.

**Relays probed from this network** (browser, `iceTransportPolicy: "relay"`,
watching for candidates — the only way to tell "refused" from "unreachable"):

| Host | Result |
|---|---|
| `global.relay.metered.ca:80` | **works** with a free Metered account credential |
| `openrelay.metered.ca:80` | reachable, `400` — its old public credential pair is retired |
| `staticauth.openrelay.metered.ca` | **silent** — no candidates, no errors, unreachable from VNPT |
| `freeturn.net` / `freeturn.tel` | dead (DNS and connect failures) |

`400 TURN allocate error` means reachable-but-refused; **silence means
unreachable**. Distinguishing the two is what stopped this from being guesswork.

⚠️ A tunnel publishes :8080 to the internet while it runs. `JWT_SECRET` was
rotated on 2026-09-13 before the first run; rotate it again after any future
tunnel session, and stop the tunnels when finished (`pkill -f "cloudflared
tunnel --url"`, then confirm the hostnames return 530).

## Phase 3 — ✅ COMPLETE (slices 0-4 MERGED — !179-!185, !189)

**The messenger product is finished as of 2026-09-17.** Every slice is merged,
the landing page describes what actually ships (!190), and both services have
Grafana dashboards (!191). Nothing in the phase-3 plan is outstanding.

What is deliberately *not* built, and is a later phase rather than a gap: an
SFU (a mesh holds about four, and the room model an SFU needs already exists),
and the two-machine test pass from phase 2.5 slice 5.

### Slice 4 — docked mini chat windows — **MERGED !189** (2026-09-17, `messenger-frontend`)

Merged. 266 unit specs, 68
mocked e2e (five of them new and standalone at :4003), `tsc` and `build:prod`
clean, prettier clean apart from `home-page.component.scss`, which was already
unformatted on `main`. Design and the two screenshot-only defects are in
`.claude/docs/products/messenger-architecture.md` § Slice 4.

### Call UX + conversation activity — MERGED 2026-09-16/17 (!186, !187, !188)

Not a slice: a day of using the product, reported bug by bug. `realtime-service`
**!186**, `messenger-service` **!187** (migration `008_conversation_activity.sql`),
`messenger-frontend` **!188**. All merged, branches deleted, three repos on
`main`.

- **A call is activity.** `last_activity_at` is its own column, advanced
  forward-only by the message transaction *and* the call projection; the list
  orders and keyset-pages on `(last_activity_at, id)`. Two latent bugs died with
  it: a timestamp-only cursor **drops** rows sharing the boundary instant, and
  the old nullable cursor could not page past a conversation with no messages.
- **A live call is discoverable by a socket that connects late** — `call:owner:`
  index plus a connect-time ring carrying **no SDP**, because the stored offer's
  candidates went to a dropped subject and answering it connects nothing.
  Leaving or declining is recorded so a reload does not re-ring.
- **The call stage gives one source the room**, with a local-only pin of a
  *source*, a people view, a speaking ring and per-screen sharer labels.
- **Group cap 50 → 10** (`MAX_GROUP_PARTICIPANTS`), a product cap while the
  platform is unpaid, deliberately not aligned with the call cap of 4.

⚠️ **`!188` failed CI once** on five layout specs that pass locally: the shared
Angular template hardcodes `--browsers=ChromeHeadless` and the wide launcher was
only wired into `package.json`. Fixed by overriding the template's `testCommand`
**parameter** in the repo's own `bot-review.yml`. Rule written down in
`.claude/rules/working-agreement.md`.

### Still owed before Messenger is "finished" (raised by dathq 2026-09-16)

Neither is a slice; both are the work that makes the product *look* finished.

Both were **built 2026-09-17**, in the same wave as slice 4 — nothing actually
blocked them, and the one real reason to wait (don't write the landing copy
twice) was satisfied the moment slice 4 was built rather than merged.

| # | What | Repo | State |
|---|------|------|-------|
| 1 | ~~**Messenger landing page is out of date.**~~ **PR !190, 2026-09-17** — hero rewritten to the finished product, the five stale "Planned — phase 1/2" chips removed along with the now-dead `statusKey` field, `STATUS_PHASE_*` keys and `.landing-card-status` rule, and two cards added (the peer-to-peer mesh, the call room). en + de. Original text kept below for the record.<br><br>**Messenger landing page is out of date.** `LANDING.HERO_DESC` still says "**1:1** audio/video calling" — groups have shipped. `LANDING.HERO_STATUS` still says "**Phase 0** is what you see … calling lands in phases 1 and 2", which describes the product as a stub while phases 1, 2, 2.5 and slices 0-3 are all merged. The hero copy is **wrong**, not merely thin; the richer rework (group calls, the mesh diagram, pin) describes a finished product and should wait for slice 4 rather than be written twice | `messenger-frontend` | **MERGED !190** |
| 2 | ~~**No Grafana dashboards for messenger or realtime.**~~ **PR !191, 2026-09-17** — `messenger-red.json` (11 panels) and `realtime-red.json` (10), both provisioned and verified against a live Prometheus; both services added to the overview's UP stats, and messenger to its RPS / 5xx / p95 lines. `realtime-service` deliberately gets no RPS line — it has no HTTP surface. Original text below.<br><br>**No Grafana dashboards for messenger or realtime.** Prometheus already scrapes **both** (`host.docker.internal:3005` and `:3004`, live and exposing metrics), and both services already push OTLP logs to Alloy — so the instrumentation half is **done**. What is missing is the dashboards: every other service has a `*-red.json` and these two have none. Worth having `realtime_service_calls_reaped_total` (a rising line means instances are dying mid-call), call setup by outcome, and ICE failures (a TURN gap) on a panel | `platform-observability` | **MERGED !191** |

### `platform-observability` has no pipeline — NOT STARTED

Found while pushing **!191** (2026-09-17). The repo has **no `azure-pipelines/`
directory at all**: no `bot-review.yml`, so no MegaLinter, no PR-Agent, no unit
test summary. Its PRs show **zero checks**, which on the pipelines tab reads
like a broken run rather than an absent one. `.claude/rules/workspace-map.md`
claimed platform-pipelines' templates are "consumed by every other repo's
`bot-review.yml`" — that was never true of this repo.

Wiring it up is `ci/bot-review-pipelines.md` § New repo, and the step that is
always forgotten is granting the build service **Contribute to pull requests**,
which is UI-only. So it is dathq's call, not something to do unasked.

**Asked directly whether it needs one (2026-09-17), the honest answer is "worth
having, low priority, and not for the obvious reason."** What it buys: gitleaks
on `main..HEAD`, which matters here because the repo is config sitting next to a
`.env` (already gitignored on line 1 and untracked, so the risk is a future
mis-add rather than a present leak); and yamllint/JSON syntax, where a malformed
`prometheus.yml` otherwise announces itself as an empty graph. What it does not
buy: PR-Agent reviewing 400-line dashboard JSON is noise, and the shared
template is built for services with a test suite — here it would run lint and
nothing else.

⚠️ **The decisive point: a bot review would not have caught anything that
actually went wrong in this repo.** The failure mode is semantic — a PromQL
expression naming a metric that does not exist evaluates fine and returns
nothing — and no MegaLinter linter checks that. The step with real teeth is
`promtool check config prometheus/prometheus.yml` plus a smoke query against a
running Prometheus, and neither is in the shared template. **If this pipeline is
ever built, add promtool**, or it produces a green check that proves the YAML is
well-formed and says nothing about whether the stack works.

Related and smaller: all 11 dashboard JSONs fail `prettier --check`, the seven
pre-existing ones included. Nothing gates it today. Formatting them is ~6,600
lines of churn and belongs in its own PR, never mixed with a content change.

⚠️ Both are **separate PRs in their own repos** — the landing page is
`messenger-frontend` (a disjoint file set from slice 4, so its own branch) and
the dashboards are `platform-observability`. **Ordering matters once:** the
landing hero now names docked chat windows, so it must not merge before slice 4.

✅ **The rest of the gap is closed too (2026-09-17, dathq: "do it now").**
`notification-service` and `accounts-service` now have UP stats and RPS / 5xx /
p95 lines on `platform-overview.json`, and `accounts-red.json` is new — HTTP RED
plus user syncs by outcome, which is the one that fails silently and surfaces
days later as a person missing from directory search. **All ten services are on
the overview**, and every service with an HTTP surface now has its own
dashboard. 65 expressions across the four touched dashboards were run against
their real engines — PromQL against Prometheus, LogQL against Loki.



**Slice 3 (the mesh in the browser) is MERGED 2026-09-15** and ended up spanning
**three repos**, not the one it was planned as — using it is what found the two
structural faults below. 212 unit specs, 63 mocked e2e and 4 live call tests all green,
`tsc` and `build:prod` clean, prettier clean apart from
`home-page.component.scss`, which was already unformatted on `main`.

**The auto-rejoin is gone and click-to-join replaced it** (same day). The thread
renders an ongoing-call banner with a Join button; `WebrtcCallService.joinOngoing`
sends the `call.join` that slice 1 has been waiting for. No server change was
needed — an ongoing call is already a row in the history the thread loads.
`sessionStorage`-backed rejoin, `restoreCall`, `abandonRestore` and their nine
specs are deleted, and a spec pins that a bare `ready` frame produces no join so
it cannot creep back. Why, in full: `products/messenger-architecture.md`
§ Rejoining an ongoing call.

**Two defects found by dathq while using it, both fixed the same day
(2026-09-15) — and this makes slice 3 a *two-repo* change:**

- **The banner outlived the call.** Three people in, one leaves, the call ends,
  and the last person was still offered Join — which then hit a call that no
  longer existed. Two causes: the history row is projected asynchronously, so it
  still read `ended_at: null`; and the refetch waited for the row to be
  *present*, which it had been since the call started, so it stopped on the
  first fetch and kept the open row. The banner now clears on the `call.ended`
  frame and the refetch waits for `"ended"`. A second bug fell out of it: capture
  opened after a join that then failed left the **microphone running with no
  call**, because `teardown` cannot stop a track it never saw.
- **A third person pressing Call started a rival call.** No per-conversation
  guard existed, so a second call was created, everyone was rung again, and the
  browser's glare rule made whoever sorted lower hang up the call they were in
  to take it — one press could empty a room. Fixed in **`realtime-service`**
  (atomic `call:conv:<id>` claim in `Create`, `call_exists` carrying the live
  call's id) and in **`messenger-frontend`** (Call button hidden while a call is
  on, `call_exists` routed into the join, glare narrowed to outgoing+ringing).
  Detail in `services/realtime-service-architecture.md` § One call per
  conversation.

**Stale call state — the class of bug, not an instance (2026-09-15).** dathq:
*"I see this issue occur a lot actually, the data is wrong when there's a bug
happen."* Root cause: `calls.ended_at` is written only by projecting
`call.ended`, published by realtime-service — the process most likely to be the
thing that died. A killed instance published nothing, its Redis record expired
in silence (**expiry publishes nothing**), and the row claimed a call was live
forever. Fixed in two independent layers, either of which is sufficient:

- **`realtime-service`** — instance heartbeats (`rt:instance:<id>`) stamped on
  every member, plus a reaper at boot and on an interval that properly ends
  calls whose every member belongs to a dead instance. `Registry.End` became an
  atomic **claim**, so concurrent closers announce `call.ended` once.
- **`messenger-service`** — a time bound on an unfinished row, applied at read
  time *and* by a sweep, sharing one rule. New end reason `expired` (migration
  **`007_call_expiry.sql`**, applied to the dev database) and two env vars.

⚠️ **`.env` needs mirroring** in both services — see each `.env.example`. And
`realtime-service` must be **restarted** to pick any of this up; Go does not
hot-reload.

**Audit findings (2026-09-15, both fixed, both mine):** `messenger-frontend`'s
`CallEndReason` could not represent `expired`, which `messenger-service` had
just started returning — a type quietly lying, the same shape as `calleeOwnerId`
before it; and `expiryOf` was exported with no caller outside its own file. The
sweep's SQL was also **executed against the real database** rather than trusted
to the TypeScript unit tests, which never run it: seeded a ten-hour-old
unfinished row in a transaction, swept it, confirmed `end_reason = expired` and
`ended_at = started_at + 6h` against the new CHECK, rolled back.

✅ **Verified by dathq in his own configuration** (2026-09-15): click-to-join
after a reload, the ongoing-call banner clearing when a call ends, and a third
person pressing Call during a live call. Slice 3 is **MERGED 2026-09-15** as **!183** (`realtime-service`), **!184**
(`messenger-service`) and **!185** (`messenger-frontend`). All three repos are
on `main` and clean; the local feature branches still exist and are safe to
delete (`branch-cleanup`). Migration `007_call_expiry.sql` is applied to the dev
database. **Only slice 4 (docked mini chat windows) is left in phase 3.**

Closed out at the end: the reaper gained
`realtime_service_calls_reaped_total` (a rising line means instances are dying
mid-call), and an `expired` call renders as "Call ended" rather than
"Video call · 0:00", which would have read as a call that connected and lasted
no time. ⚠️ That template branch is **verified by rendering it, not pinned by a
test** — `ThreadComponent` has no spec file at all, which is the gap to close if
the thread gains more conditional chrome.

Also open from the same session: **`Dev Third` (a headless participant) sits at
"Connecting…" forever** on its own side while every other participant sees it
connected and the server has it in the members hash — its ICE never nominates a
pair. Unexplained, reproducible, and not yet chased. `WebrtcCallService` became `Map<ownerId, PeerLink>`,
the dock renders N tiles, a group can be called, and the per-tab `session_id`
slice 1 has been waiting for is now on the wire. A real **four-way** call — the
phase exit criterion and the mesh's cap — runs across four browser contexts
against the live stack, with every tile measured for frames and for staying
inside the stage. Only **slice 4 (docked mini chat windows)** is left in the
phase.

**Slice 2 (call history for groups) is MERGED** — **!181** (`realtime-service`,
producer) and **!182** (`messenger-service`, consumer + migration), 2026-09-15.
Branches deleted, both repos on `main`. Two findings worth keeping:

- **`platform-nats` needed nothing.** The plan table listed it; the EVENTS
  stream already carries `events.messenger.>` and the durable already filters
  `events.messenger.call.>`. Read the topology rather than inherit the entry.
- **`realtime-service` did need a change**, which the table did not list: the
  invited set cannot say who missed a call, so an append-only "ever joined" set
  now rides the event as `joined_ids`. And a group's missed call is published
  **once per person who did not answer** — before that it carried an empty
  `owner_id`, which notification-service skips, so nobody's bell rang at all.

**Migrated and verified live (2026-09-14/15).** `006_call_participants.sql` is
applied to `messenger_service_db`; row counts were identical either side
(5 conversations / 14 messages / 53 calls / 10 participants) and all 53 existing
calls kept their callee, so `DROP NOT NULL` touched no data.

The cross-repo path was then proven end to end by publishing one synthetic
**group** call envelope — realtime-service's exact payload shape, with no
`callee_id` — onto `events.messenger.call.ended`. It projected into a `calls`
row with a NULL callee plus three `call_participants` rows with the right
`joined` flags, and `GET /calls` returned it to a participant who was **neither
caller nor callee**. Before this slice that same event was dropped on the floor.
The probe row was deleted afterwards and the database left exactly as found.

**Slice 1 (the call room model) is MERGED** — PR **!180**, `realtime-service`
only, branch deleted, repo on `main`. A call was a pair with a derived peer; it
is now a room. What shipped:

- **Invited set vs joined set.** The invited set is fixed from conversation
  membership at creation and never widened — the whole authorisation surface.
  The joined set is a Redis hash keyed by owner id, so a join or leave is one
  atomic field write; a read-modify-write of a participant list would lose one
  of two joins landing in the same tick.
- **Targeted signalling.** `call.ice` / `call.renegotiate` carry a `to`,
  validated against the invited set and refused when it names the sender.
  Absent `to` is still derived, but only for a two-person call — which is what
  left every pre-mesh client working untouched.
- **`call.join` / `call.participant`**, a 4-person mesh cap, and leaving that is
  not hanging up (a group call ends only when fewer than two remain).
- **Reconnect**, folded in on dathq's word — *"we should have done it right"* —
  rather than deferred: a closing socket releases its place conditionally on
  still holding it, and a session may take its own place back. The pair closes
  the reload race in both orderings and **neither half works alone**. It also
  closed two phase-2 limitations (a caller closing the tab while ringing, and a
  dropped socket mid-call).

Three things worth keeping from how it was verified:

1. **Eight regression tests proven red** against the wrong code first. Trusting
   the client's `to` made the outsider case relay silently; broadcasting to the
   room leaked one pair's candidates to a third party.
2. **The Lua scripts were run against real Redis**, because the unit fakes
   mirror them rather than execute them — see the rule in
   `.claude/rules/working-agreement.md`.
3. **A bug of mine caught by an old test**: the rewritten `Peer()` returned "the
   participant who is not you", handing an *outsider* the first member of the
   list. Unreachable past the membership check, but the property has to hold on
   its own.

Still open for slice 2: group calls write **no history row** (events carry
`participant_ids` and omit `callee_id`, which the consumer ignores rather than
DLQs), and `MessageKind`'s `"system"` still has no producer.

**Slice 0 (group chat UI) is MERGED** — PR **!179**, `messenger-frontend` only,
branch deleted, repo on `main`. dathq verified it in the running app before the
PR went up, including creating a real group between his two Google accounts and
renaming it. No backend change was needed, which was the point.

**The prerequisite nobody had noticed:** `messenger-service` shipped the entire
group surface in phase 1 — create with a title, rename, add participants, leave,
`MAX_GROUP_PARTICIPANTS=50`, admin-vs-member authz — and **nothing called it**.
`messenger-frontend`'s only create path hard-coded `{ type: "direct" }`, so a
group conversation could not be created at all, which makes a group *call*
impossible to even test. Four live, tested endpoints were unreachable.

**Media path: mesh first, SFU later — dathq's call.** The phase's own exit
criterion is a **4-way** call and `products/messenger-architecture.md`
§ Media topology has always said mesh is tolerable at 3-4, so the SFU was never
forced. Mesh reuses the hand-built `RTCPeerConnection` stack that is the point
of this product; LiveKit would replace the browser half with its SDK. The room
model mesh needs is also what an SFU would need, so deferring costs nothing.
Full comparison and the remaining slices: **`products/messenger-architecture.md`
§ Phase 3**.

### Slice 0 — what shipped (!179)

27 files: the compose dialog's group mode (required name, removable chips), the
group details dialog (members, admin badges, rename, add, leave), and two new
shared components — `messenger-avatar-stack` (the composited group picture) and
`messenger-person-chips` (shared by both places that pick people).

Six defects were found and fixed along the way, each proven to fail against the
unfixed code first:

1. **PrimeNG's `focusOnShow` silently beat the dialog's own focus** once a row
   was inserted above the search box.
2. **One `distinctUntilChanged` shared by two search boxes** dropped the second
   identical query — no request, no error, empty list.
3. **Both dialogs painted under the app header.** `.messenger-content` sets
   `position: relative; z-index: 1`, a stacking context, so the mask's own
   `z-index: 1101` counted for nothing. Fixed with `appendTo="body"`; the test
   hit-tests the pixel, since a z-index assertion passes throughout.
4. **No height cap** — measured: the Create button 2668px down a 700px viewport.
5. **The group picture was viewer-relative**, showing everyone-but-you.
6. **Neither inline error notice ever reset**, so one failure left the banner up
   for the session (`attachmentError` predated this slice).

### Slice 0 — verification

- `pnpm test` **175 pass** (6 new store specs, 3 new `sender-tone` specs).
- `--project=chromium` **62 pass**, including a new **24-case `group.spec.ts`**.
- `--project=calls` **2 pass** against the live stack, so the thread-header
  rework did not break calling.
- `pnpm build:prod` clean, no budget warnings. `knip` clean. `format:check` clean.
- Driven headed and screenshotted at 1280x700, 1280x800 and 400x640, light and
  dark; the dark palette was **measured** (`#b9a6f5` / `#7fd4ec`) rather than
  eyeballed.
- Orthogonal audit: i18n parity (272 keys each, zero gaps either way), explicit
  `tsc` against `tsconfig.app.json` **and** `tsconfig.spec.json`, no dependency
  change to diff. Found and removed three classes carrying no styles and one
  store method left with no callers; 7 unused translation keys predating this
  slice were reported rather than deleted, since the `CALL.*` ones may be
  staged deliberately.

A second pass applied the big-app conventions dathq asked for: a tappable
header, colour-coded participant names, the speaker named in the list preview,
count-aware typing wording, and a leave confirmation with a real Cancel. The
group rule went through all three positions in one sitting and landed on
**named, one other minimum** (WhatsApp/Telegram/Signal) — dathq tried both
coherent models in the running app and preferred being made to name a group in
exchange for being able to make a two-person one. The survey behind each — including where the
field *disagrees* — is in `products/messenger-architecture.md` § Slice 0.

**Local data cleaned 2026-09-14, with dathq's approval.** `call.spec.ts` minted
a **timestamped** identity pair per run and provisioned both into
accounts-service, which has no delete — so every run leaked two people into the
directory permanently. By the time it was noticed the New-message picker was a
wall of "E2E Callee" and real people could not be found. The spec now uses ids
stable per test label (4 rows, forever), verified by two consecutive green runs.
Removed: **160 synthetic users** (98 `@datha.local`, 62 `@d.local` from scripts
no longer in any repo) and **98 synthetic conversations**, keeping dathq's two
real accounts and three real threads. Both databases were dumped first.

⚠️ **`MessageKind` has carried `"system"` since phase 1 and nothing emits it.**
"X added Y" / "X left" / "X named the group" is what makes a group's history
readable, and it is missing on both sides. Backend work; do it in slice 2 while
`messenger-service` is already open. Also missing: an admin cannot remove
another member — the service has `DELETE /participants/me` only.

Two defects were found by looking at it rather than by a green suite, and both
are now rules in `.claude/rules/working-agreement.md`: PrimeNG's `focusOnShow`
silently beating the dialog's own focus once a row was inserted above the search
box, and one `distinctUntilChanged` stream shared by two search boxes dropping
the second identical query. The title-handling specs and the repeated-query spec
were each proven to fail against the unfixed code first — `Expected $.title = ''
to equal null` and `Expected: 3, Received: 0`.

**Next up:** slice 1 (room model in `realtime-service`, including the new
targeted-signaling authorization surface), slice 2 (`call_participants`
projection), slice 3 (mesh + N-tile grid), slice 4 (docked mini chat windows).

## Phase 2.5 — MERGED (!176-!178, 2026-09-13)

**All three PRs merged**, local branches deleted, every repo on `main` and
clean: `realtime-service` **!176**, `messenger-service` **!177**,
`messenger-frontend` **!178**. `platform-nats` needed nothing — `EVENTS`
already carried `events.messenger.>`.

Shipped: 1:1 video calling, screen share as a **second** video track, call rows
in the thread attributed to the caller, a shared `person-avatar` replacing seven
drifting copies, image attachments rendered as pictures from a client-made
thumbnail, and the `media`/`hasVideo` split that stopped a screen share
renaming a voice call. Plus hosted TURN credential support, which is what
closed phase 2's last criterion.

**!177 failed its pipeline first, on `typecheck:test`.** Two row fixtures had
gone stale against their own types. Neither local gate could see it:
`tsconfig.json` excludes test files and vitest only transpiles them. The cause
was procedural — `prepare-push`'s reference listed that check for four Fastify
repos and omitted `messenger-service`, which has always had the script. The
reference now says five, records that the pipeline runs it, and names all three
commands. Filling the fixture also exposed an assertion that had only been
passing *because* the fixture was incomplete.

**Slices 1-4 done, slice 0 answered, slice 5 outstanding.** 152 frontend specs
(from 88), 2 call e2e passing against the live stack, Go suites green,
production build 0 warnings, both i18n catalogues symmetric.

### What the calling UI actually is now

- **A screen share is a SECOND video track**, never a replacement for the
  camera. This was the root cause behind most of the day's UI complaints: with
  one track each way a tile could hold a face *or* a screen, so once both
  people shared, neither could see the other. Four tiles are impossible with
  two sources.
- `call.renegotiate` carries **`screen_stream_id`** so the peer can tell a
  second video track from a camera. Relayed opaquely by `realtime-service`,
  which understands "screen" no more than it understands SDP. The id and the
  track arrive in either order, so both paths re-file what is known.
- The stage is **presentations + people**: screens side by side, people in a
  column down the right above 60rem, a strip below it under that. A call that
  has carried video keeps the stage and falls back to avatars — collapsing to
  the audio dock when a share ended pulled the panel out from under both people.
- Controls are **inline SVG**, solid white with a dark hairline, red for off
  states. PrimeIcons ships no slashed mic or camera, and the CSS slash drawn
  over the plain glyph looked exactly as bolted-on as it was.
- Avatars use the **real Google picture** in the call tiles, the chat list and
  the thread header — it had only ever been wired into message bubbles.

### ⚠️ Retrospective: too many rounds (dathq, 2026-09-11)

dathq's words: *"way too many bugs babe"*, and he is right. Roughly a dozen
defects in the call UI were found **by him**, not by me, over eight or nine
rounds. The pattern behind nearly all of them is one habit:

**I wrote UI, ran the unit suite, and reported it done without ever looking at
it.** Every one of these passed a green suite — the unbound `srcObject`, the
expanded stage rendering at compact width, the black ring tile, the vanishing
avatar, the letterboxed camera column. Class and `data-testid` assertions
cannot see any of them.

What actually worked, and should have been the first move rather than the
eighth: **drive it headed with Playwright and look at the screenshot**, and
**measure the element** (`getBoundingClientRect`, `videoWidth`, `srcObject`,
computed styles) rather than asserting that a class is present. Every later
round found its bug in one step that way.

Second contributor: **three separate debugging rounds lost to a stale Go
binary**, because `go run` does not hot-reload and `ng serve` had trained the
opposite reflex. → `rules/working-agreement.md`

### Still open

**Nothing.** Slice 5 ran on 2026-09-13 and closed the cross-network criterion —
evidence in the phase 2 section above. Slice 0 was already answered.

The video path is verified for real now: the call that closed slice 5 was a
**video** call from a phone, so the camera half no longer rests on fake devices.

One idea never used and no longer needed: a synthetic peer minted with the JWT
secret running a fake microphone, to remove the two-tabs-one-mic contention.
Two real devices did the job instead.

**Slices 1-4 are written and green; nothing is committed.** Three repos dirty on
`main`: `realtime-service`, `messenger-service`, `messenger-frontend`.
`platform-nats` needed nothing, as the plan predicted.

Suites: realtime-service 10 packages, messenger-service 69 specs (was 65),
messenger-frontend 117 (was 88). Production build clean, knip clean, both i18n
catalogues symmetric. The `calls.media` migration was applied to the local
database and verified there — column `NOT NULL DEFAULT 'audio'`, the CHECK
rejects an unknown kind, and the 48 existing rows backfilled.

### ✅ Slice 0 — ANSWERED (2026-09-11)

dathq measured both ends of a live call and the numbers are decisive: the
**receiver transmitted `audioLevel` of exact `0`** for eight consecutive
samples while `packetsSent` climbed 1171 → 2942. The caller's level moved
normally (0.001 → 0.64 on speech). Both sides: `audio/opus 48000`, zero loss,
zero jitter, `host` candidates over **UDP** — a direct LAN path.

So it was never the network, never TURN, never TCP relay, never CPU. **The
receiver tab's microphone produced silence**, which is what happens when two
tabs on one machine contend for one physical device and the second track is
muted by the OS. A testing artefact of the one-machine setup, not a fault in
the call — it will not reproduce across two machines.

It did expose a **real product gap**, now fixed: nothing noticed. Both ends
looked healthy and the call quietly transmitted silence. `WebrtcCallService`
now samples its own outgoing level every 3 s and raises `micSilent` after four
consecutive readings at or below a noise floor (a threshold, not a zero test —
a live mic in a quiet room still reports a floor; muted calls are exempt).
Meet shows the same warning. Only the sender can see this, which is exactly why
it has to be surfaced rather than left for the other person to report.

**Superseded note:** dathq's first live measurement
(2026-09-11) read `codec=audio/opus 48000, packetsLost=0, jitter=0,
concealment=0` — a clean path. He also reported the fault is **asymmetric**:
the caller hears the receiver poorly while the reverse is fine. With a perfect
transport that leaves **capture**, and the prime suspect is Chrome's echo
canceller on one of two tabs sharing a single microphone suppressing speech it
takes for echo (headphones mean there is no real echo to cancel). The probe now
also reports `outbound-rtp` and the source `audioLevel`, because `inbound-rtp`
measures only what arrives and a one-directional fault is invisible from the
bad end.

**Original note:** dathq confirmed on
2026-09-11 that his headphones are **wired**, which kills the Bluetooth
HFP/SCO theory; the feedback loop was already ruled out by muting the far end.
Remaining suspects: the network path, the capture settings, CPU contention.
A dev-only probe now logs codec/clock rate, loss/jitter/concealment, the
nominated candidate pair and the applied capture flags every 5 s during a live
call — so his next real call produces numbers instead of theories.

**Slice 5 ran and passed on 2026-09-13** — laptop and a phone on 5G, relayed
through a hosted TURN, zero packet loss. It also found the Module Federation
`publicPath` bug that no same-machine test could.

⚠️ **This machine has no camera** (confirmed 2026-09-11 — `system_profiler
SPCameraDataType` returns nothing). The first real video call failed instantly
with `NotFoundError: Requested device not found`. So **the whole video path of
slices 2-3 is unverifiable **from this side**: fake media devices keep every
suite green and prove nothing. **Resolved 2026-09-13 by the other end** — the
phone sent real camera video and the laptop decoded 973 frames of it, so the
receive path is proven. Sending camera video from this laptop still needs an
external webcam; everything else about video is now verified. Three things came out of it: media failures are now classified by cause instead
of all reading "the call could not connect"; a camera fault **degrades to
audio with a `recvonly` video transceiver** so the peer's video still arrives;
and the local tile says "No camera" rather than going black.

**The first fix was wrong and dathq caught it.** It disabled the video-call
button on a camera-less device — which removes a call that would have worked.
Meet, Zoom, Teams and Messenger all let you join a video call with no camera.
**Degrade, never refuse.** → `always-apply/local-environment.md`

Three findings worth keeping:

- **A bare `muted` attribute on an Angular-created `<video>` does nothing.** The
  attribute only sets the parse-time default; Angular sets it after the element
  exists, so `HTMLMediaElement.muted` stayed `false` and the peer would have
  been audible twice. `[muted]="true"` is the fix, and a spec pins it.
- **A test can pass for the wrong reason and look like proof.** The spec meant to
  guard "do not renegotiate while ringing" passed against the reverted code,
  because the call id is still null at that point and blocked it first. Firing
  `onnegotiationneeded` explicitly *after* `call.ringing` made it real.
- **A gitleaks-style history problem has an analogue here:** reverting product
  code to prove a test fails only counts if the revert still **compiles**. Two
  attempts produced no test output at all and no evidence.

### The original plan (2026-09-11)

Full plan: `products/messenger-architecture.md` § Phase 2.5. dathq asked for
FaceTime-style video and for calls to show up in the chat the way Messenger
does; both were then scoped into their own phase.

**1:1 video was never actually deferred by anyone — it fell through a gap in this
plan.** The architecture doc has always described the product as "1:1
audio/video" and specced a call panel with remote video and a local PiP, but
`WebrtcCallService` carried a comment saying video arrives with the SFU, and
phase 3's row lists only *group* calls. An SFU is for 3+ participants; 1:1 video
needs nothing from it. The stale comment was corrected on 2026-09-11.

Five slices, in order: **measure the audio before touching it** (`getStats`, see
below) → media kind end-to-end (`Call.Media`, a `media` column, migration 004) →
capture and render → **real SDP renegotiation** → call rows in the thread.

Two findings that shape the work, both confirmed by reading the code on
2026-09-11:

- **There is no renegotiation path today.** Perfect negotiation is implemented
  at *glare* level only — two simultaneous invites resolved by comparing owner
  ids. There is no `onnegotiationneeded` handler, and `call.answer` is
  answer-once. Turning a camera on mid-call *is* a renegotiation, so this is the
  slice with real risk and the one most worth hand-writing, given the product
  exists to practise WebRTC.
- **Call rows are half-built already.** `messenger-service` has the projection
  and serves `GET /calls` and `GET /conversations/:id/calls` with `end_reason`
  and `duration_seconds`. Nothing renders them. The open question for dathq is
  whether the thread merges them client-side or `GET
  /conversations/:id/messages` returns one ordered timeline — the second is how
  the majors do it and pages properly, but it changes a route phase 1 shipped.

### Audio quality — reported, not yet diagnosed (2026-09-11)

dathq: audible both directions, "not that stable… not clear". **Same machine,
two browser contexts, headphones on, far end muted** — so the acoustic feedback
loop, normally the first suspect, is ruled out.

Not diagnosed yet, and deliberately not "fixed" by changing constraints blind.
`pc.getStats()` on a live call distinguishes the candidates in one step:
`inbound-rtp` (`packetsLost`, `jitter`, `concealmentEvents`), the nominated
`candidate-pair` (a local relay pair is **TCP**, since colima forwards no UDP,
and TCP relay jitter reads exactly like a bad mic), the negotiated `codec` and
its clock rate (a Bluetooth headset switching to HFP/SCO to open its microphone
goes narrowband, and muffles **both** directions because both peers share the
one device), and `media-source` for the echo-cancellation flags actually applied
— `getUserMedia` is called with a bare `{ audio: true }`, so those are browser
defaults rather than anything this codebase asked for.

## Mobile UI survey — measured 2026-09-17

The measurement pass the mobile row asks for, run the day messenger finished.
Every route of all four frontends driven at **390x844** and **360x800** in
headed Chrome against each repo's own e2e mocks, screenshotted and measured.
Screenshots under `.claude/tmp/mobile-sweep/` (ephemeral); the four sweep specs
are archived in `.claude/tmp/mobile-sweep/instruments/` and were removed from
the repos, which are clean.

**The headline: `shell-frontend` has no responsive behaviour at all.**
`authenticated-layout.component.scss` contains **zero** media queries, and
`sidebarCollapsed` is a signal seeded only from `localStorage` — never from
viewport width. So a phone gets the desktop layout verbatim: the sidebar holds
`w-56` (224px) of a 390px screen, the toolbar wraps to **three rows** (~155px),
and the content column is left with ~165px. That single fault produces most of
what the screenshots show, including the clipped launcher cards ("Your
Applic…") and settings headings ("SETTIN…"). Even the collapsed rail is `w-14`
(56px) and permanent — a phone wants an **overlay** drawer, not a rail.

**What each frontend actually looks like:**

| Frontend | State at 390px |
|---|---|
| `messenger-frontend` | **Best of the four.** List↔thread transition works, bubbles wrap, composer clears the edge, no clipping. Its only defects are touch targets (below). |
| `shell-frontend` | Sidebar + 3-row toolbar eat the screen; launcher cards and settings headings clip mid-word. |
| `chatbot-frontend` | **Worst.** The two-pane chat layout persists at phone width, leaving the stage **~110px**: empty-state text wraps to one word per line and is vertically clipped mid-word, and the composer is a sliver. Messenger's list↔thread collapse has no counterpart here. |
| `event-store-frontend` | The events and DLQ tables show **2 of ~6 columns**; the rest are unreachable. A dense ops table needs a card-per-row treatment on a phone, not a narrower table. |

**Touch targets** are uniformly under the 44px HIG minimum in messenger:
`thread-call`, `thread-call-video`, `thread-details` and the back button are
**32x32**; `composer-send` and the attach button are **40x40**. The shell's
own bell and profile triggers are 40x40.

⚠️ **`overflowBy` was 0 on every route of every frontend** — no horizontal
scrollbar anywhere. That number says the bones are responsive and says nothing
about whether the screen is usable: chatbot's 110px chat stage and event-store's
2-of-6 columns both measure clean, because content is clipped or wrapped inside
its own container rather than overflowing the document. Another instance of
`working-agreement.md` § *an element can be present, correct, and invisible* —
the screenshots found all four faults, the measurements found none of them.

**Not a mobile defect, seen in the shots:** the seeded e2e token is not signed
with the gateway's real `JWT_SECRET`, so hosted-messenger and the notification
preferences panel render their error states ("Conversations could not be
loaded", "Could not save your preferences"). Layout is what the sweep shows;
data is not.

### shell-frontend — MERGED 2026-09-17 as !195

The first of the four. `authenticated-layout` gains a **bottom navigation bar
below `sm` (640px)**, the platform's existing compact breakpoint — the same one
messenger's list↔thread collapse already uses, so no new dialect. Material 3
puts three to five destinations in a bottom bar under 600dp and prefers it to a
modal drawer, because a drawer makes the user reach the *top* of the screen on
the device where that is hardest; the bar carries five (Home, the three apps,
Settings). The sidebar is `hidden sm:flex` — hidden outright rather than
collapsed, because even the collapsed rail is 56px and permanent. The hamburger
goes with it: below `sm` there is no sidebar to toggle.

**The toolbar's two selects moved, and that forced a second change.** Theme and
language wrapped the bar onto three rows (152px measured). Hiding them below
`sm` would have **stranded both capabilities on a phone**, because the Settings
page's Appearance and Language cards were `route: null` placeholders carrying a
"Coming soon" chip. So they are now real: each renders its control inline and
writes through `ShellContextService`, which already owned `setTheme`/`setLang` —
a second caller of one setter, not a third copy of the state. Their descriptions
also stopped claiming to be "synced across your devices", which is the deferred
server-sync row and has not shipped.

Verified: 4 new geometry specs in `e2e/specs/mobile-chrome.spec.ts`, each
red-proofed by neutralising the property it names — `Expected: 390, Received:
166` for the sidebar, `Expected: < 80, Received: 152` for the toolbar,
`Expected: >= 44, Received: 30.5` for the touch targets, and hidden/visible for
the bar itself. Shell suite **35 passed, 36 karma specs green**.

⚠️ **One pre-existing failure on `main`, not caused by this work and not fixed
by it:** `header-widget.spec.ts` › "an incoming call rings centred on the
viewport" fails with `Expected substring: "Dat Ha" / Received: "D   Incoming
call… AcceptDecline"` — the caller renders as an initial although the spec mocks
`/api/accounts/users/lookup` with the name. Proved pre-existing by stashing the
whole change and watching it fail identically on a clean tree. It is a name-
resolution fault, wants its own look, and is **unrelated to mobile**.

### chatbot-frontend — MERGED 2026-09-17 as !193

The two panes now **swap** below `sm` instead of sharing 390px: the chat is what
you land on and history is a tab away, which is the camp ChatGPT, Claude and
Gemini are all in — an assistant puts you *in* a conversation, where a messenger
puts you in a list. So this is deliberately **not** messenger's list-first
pattern, though the mechanism is the same one (`[class.hidden]` below `sm`,
`sm:flex` above it, both panes untouched on a desktop).

`historyOpen` is closed by `newChat()` and by `selectConversation()` — the
latter **before** its same-id early return, or tapping the thread you are
already in would leave you stuck in the history pane.

Two things the screenshots caught that no assertion would have: the new History
button was styled with the sidebar's dark-theme utilities and was nearly
invisible in the light stage header (fixed by reusing `.chat-soft-button`, which
the stylesheet already theme-corrects), and the pre-fix stage measured **110px**.

Verified: 5 specs in `e2e/specs/mobile-chat.spec.ts`, red-proofed against the
exact pre-fix markup — `Expected: 390, Received: 110`. Suites **60 e2e, 34
karma** green.

⚠️ The first red-proof attempt **stayed green**, because I neutralised the
sidebar's *width* class when the load-bearing property is the `[class.hidden]`
binding. Restoring the real pre-fix shape is what produced the honest red.

### event-store-frontend — MERGED 2026-09-17 as !194

Both ops tables showed 2 of 6 columns. Fixed by **progressive disclosure**, not
by a horizontal scroller: below `sm` the `.es-table__secondary` columns are
dropped (the class already existed on the cells and only had to be added to the
matching `<th>`, or the columns shift), leaving timestamp + type on events and
timestamp + sink + status on DLQ. Every row opens a detail page that carries the
full payload, which is the only reason dropping columns is acceptable — a spec
pins that path.

Hiding columns was **not enough on its own**, and measuring is what said so:
PrimeNG takes the table's floor as an *inline* `[tableStyle]` `min-width` of
52rem/48rem, which no stylesheet can override without `!important`. Routed
through `--es-table-min-width` custom properties instead, so the binding stays
PrimeNG's own seam and the breakpoint lives in CSS. Two more measured facts
followed: the `whitespace-nowrap` timestamp was ~200px, and a sink like
`file.conversation_cleanup` is one unbreakable token that held its column at
186px — hence `white-space: normal` and `overflow-wrap: anywhere` below `sm`.

Verified: 4 specs in `e2e/specs/mobile-tables.spec.ts`, both properties
red-proofed (`Expected: <= 391, Received: 438.6` for the floor, `441.8` for the
columns). Suites **43 e2e, 24 karma** green.

### messenger-frontend touch targets — MERGED 2026-09-17 as !192

Header controls were 32px and the composer's 40px, against the 44px minimum.
Raised to 2.75rem under **`@media (pointer: coarse)`** — keyed on the input
device rather than on width, because a touch laptop wants the bigger target at
any size.

`:host(:not(.is-windowed))` is load-bearing: a docked mini window deliberately
shrinks these to 1.75rem to fit five buttons beside the title, and growing them
there would undo the measuring session that produced that layout. The dock specs
passing is what proves the exclusion works.

Verified: 2 specs in `e2e/specs/touch-targets.spec.ts`, red-proofed
(`thread-back height Expected: >= 44, Received: 32`), plus a desktop spec so the
finger sizing cannot leak into the pointer case. Suites **70 e2e, 266 karma**
green.

### Two bugs found and fixed in the same wave (2026-09-17)

Chasing the pre-existing `header-widget.spec.ts` failure turned up one of each.

**A runaway lookup loop — real, in the product.** `ChatStore.ensurePerson`
guards on `this.directory().has(...)` and then rebuilds the Map unconditionally.
The call dock calls it from an `effect` per participant, so the effect tracked
the directory and the no-op rebuild re-emitted: **2187 requests in three
seconds**. Triggered in production by any owner the directory cannot resolve —
a deleted account, or someone who has never signed in. Fixed on both sides:
`untracked()` at the call sites, and `ensurePerson` returns early when the
lookup resolved nobody. Pinned by a spec that counts directory emissions,
red-proofed at `Expected 2 to be 1`.

**The spec's own fault — the `"D"` failure.** `WebrtcCallService` takes its
owner id from the socket's `ready` frame, and the spec's mocked socket never
sent one. With `selfOwnerId` empty the invited set never included this user, so
a 1:1 peer could not be resolved from a set of one and the ring showed an avatar
with no name. The product was right the whole time; the spec now sends `ready`.
**shell-frontend is 36 e2e / 36 karma green, with no known failures left.**

### Settings preference cards — fixed 2026-09-17 (regression from this wave)

dathq: *"the Appearance and the Language & Region are broken on the Setting
Page"*, with a screenshot. Mine, from making those cards real earlier the same
day: I reused `.shell-glass-card.datha-glass-sheen`, and the sheen sets
`overflow: hidden` so its `::before` clips to the radius. PrimeNG renders a
select's overlay **inline and in flow**, so the panel was cut off at the card's
edge *and* the card's own icon was pushed out through the top — 361px of content
in a 260px box. Fixed with a `--control` card modifier: no sheen, `overflow:
visible`, `position: relative`, and the overlay forced out of flow. Guarded in
`notification-settings.spec.ts`, red-proofed at `Expected: >= 293.59, Received:
278.59`. Shell: **38 e2e / 36 karma**, clean `build:prod`.

Note for the bump below: replacing the selects with **buttons** removes this
whole class of problem, because a button has no overlay to clip.

### DONE 2026-09-18 — v0.6.0 shipped, all four consumers adopted

`shared-frontend` **!196** merged, tagged `v0.6.0`, published to `platform-npm`;
adopted by **!197** chatbot, **!198** event-store, **!199** messenger, **!200**
shell. Every repo back on `main`, branches deleted, all four pinned `0.6.0`.

Theme and language are chip menus — **not** the cycling toggle first proposed,
which dathq rejected because the option lists are expected to grow. Detail and
the design reasoning: `services/shared-frontend-architecture.md` § v0.6.0.

What adoption actually cost, for next time: the public API was unchanged so no
consumer template changed, and **nine specs still broke** because they drove the
rendered `.p-select` DOM. Lockfiles moved exactly one package each, confirmed by
comparing package **sets** — the webpack lines in the raw diff were peer-suffix
noise.

Rode along in `messenger-frontend` (!199): Email Support moved out of every
remote's sub-header into the profile menu (130px of a 390px screen, for a mailto
nobody opens weekly; sub-header 85px → 56px), the thread's touch targets were
separated from their drawn size, and a **landscape phone** fix — see below.

### Still open after the bump

> **Closed 2026-09-19 by !201-!204.** Both items below are done. The landscape
> sweep covered all four frontends and fixed three real faults (not one);
> `selfOwnerId` now resolves from the access token. What remains of the
> responsive work is the *Phone UI/UX enhancement* section further down, now
> ordered **after** the event-store filter wave.

## Landscape + ops lists — MERGED 2026-09-19 (!201-!204)

`event-store-frontend` **!201**, `chatbot-frontend` **!202**,
`messenger-frontend` **!203**, `shell-frontend` **!204**. Branch
`fix/landscape-and-ops-pagination`, all four repos back on `main` and clean.

Shipped: container queries for every rule that is about room rather than window
(three products, three measured faults, all invisible standalone); the ops
lists' column ink, flattened in both hosts by a blanket cell rule at (0,3,2);
a rebuilt paginator with first/last, numbered pages, gaps and a page-size
control; form controls raised from 25.3px to 38px; and
`WebrtcCallService.selfOwnerId` resolved from the access token instead of a
`ready` frame no caller delivered.

Caught during prepare-push and worth repeating: a **scripted edit bypassed
prettier** on a spec file, and MegaLinter gates TS prettier — it would have
failed the PR. Also established what actually gates a run: knip and e2e both
default `true`, and there is **no production build step**, so component-style
budget warnings are local-only.

## Event-store filter options, scaling and payload filtering — MERGED (!205-!208)

**All four merged 2026-09-19/20: `event-store` !205, `file-service` !206,
`event-store-frontend` !207 and !208.** Every repo back on `main`, branches
deleted after confirming zero unmerged commits. Note !207 merged *before* !205,
which inverts the stated order — nothing was deployed so nothing broke, and the
frontend degrades quietly, but the backend owes the frontend its endpoints and
should land first next time.

`event-store` and `event-store-frontend`. **`api-gateway` needed nothing** —
`/api/event-store/*` is a wildcard prefix proxy, so the new routes were
reachable the moment they existed; the plan's third repo was imaginary.

**What was wrong, measured against the dev database.** The events filter offered
`analytics-service` (0 rows, a deferred service) and omitted `realtime-service`
(412) and `messenger-service` (148): **560 of 715 events, 78%, unfilterable**.
The DLQ filter was worse than this row originally recorded — both its
hard-coded sinks had **zero** records and the one sink that had any
(`messenger_service.calls`) was not offered, so every choice it presented
returned an empty table.

**Shipped:** `GET /events/services` and `GET /dlq/sinks`, both returning
`{ data: string[] }` ascending; migration `004_events_service_idx.sql`; the two
constants, both `_ORDER` arrays, `helper/translated-filter-options.ts` and
`sortByCanonicalOrder` deleted; six i18n keys removed from each catalog.

**The index decision, settled with EXPLAIN rather than a guess.** A loose index
scan (recursive CTE walking the index one distinct value at a time), not
`SELECT DISTINCT` — Postgres 16 has no index skip scan, so `DISTINCT` reads
every row and, once indexed, every index entry. Measured at 715 rows: **11
buffers / 0.18 ms** versus a 45-buffer sequential scan, and the loose form does
not grow with the table. No rollup table: that is write-path coupling plus a
backfill, and a derived query cannot drift.

**Names stay raw**, dathq's call. Both catalogs had in any case been carrying
the identifier as its own translation in English and German.

**Three things the plan did not see, each found by measuring:**

1. **A failed options fetch popped the global error dialog** over a page that
   had loaded fine. `EventsService` had never carried the quiet-errors context
   and header that `DlqService` has. Found by the e2e for the degradation path,
   which failed on a modal intercepting a click — not by any reasoning.
2. **The dropdown clipped its last option.** PrimeNG's default `scrollHeight` is
   200px = five 40px rows minus 16px of list padding, and the list went from
   four hard-coded options to five real ones. Fixed with
   `scrollHeight="min(18.5rem, 60vh)"`; guarded by a rect assertion, because
   the option was present, correct and reachable the whole time it was clipped.
3. **`/events/services` sits where an event id goes.** find-my-way prefers the
   static segment, and the e2e mock's own `/events/:id` regex did *not* — it
   would have 404ed the options. Both are pinned by tests.

**Verified:** 56 backend / 30 karma / 53 Playwright, knip and prettier clean in
both repos; endpoints curled live off the real database; the filters looked at
in a real browser against real data. Three specs red-proofed with the predicted
message (`expected 400 to be 200`, `Expected $[0] = 'chatbot-service' to equal
'api-gateway'`, `Expected: 0 Received: 3`).

**The audit's three raised items, closed 2026-09-20** (dathq: "fix all the
audit bugs, finish all the small tasks in this wave"):

1. **`LOADING_LIST` was the "never built" kind of orphan, not the dead kind** —
   exactly why the audit refused to delete it. PrimeNG's loading mask is a
   spinner with an `aria-hidden` icon, so every refetch was silent for a screen
   reader while the detail pages announced theirs. Both list pages now carry an
   `sr-only role="status" aria-live="polite"` region bound to `loading()`.
   Red-proofed at `Expected "Loading events…" / Received ""`.
2. **Every Sass `@import` migrated to `@use`.** Four were trivial; the two that
   mattered are `@import`ed **inside** `:host ::ng-deep`, and `@use` cannot be
   nested. Fixed with the pattern `_table-compact.scss` already used in the same
   files: make the partial a mixin, `@use` for the namespace, `@include` where
   the old `@import` sat — which also keeps the emit point, and these rules are
   meant to win on source order. Proven by compiling both versions with the
   `sass` CLI: **byte-identical output for all six files**, deprecation warnings
   1 → 0.
3. **`anyComponentStyle` budget 10 kB → 16 kB.** ~6.5 kB of each ops list page
   is shared partials that *must* be inlined per component, because a Module
   Federation host never loads a remote's global stylesheet. The budget predated
   that constraint and was flagging the architecture, not bloat; the 48 kB error
   budget still guards. `build:prod` is now warning-free.

**A wrong bot finding that was standing on a real bug (2026-09-20).** PR-Agent
claimed `generate_series(date, date, interval)` is ambiguous and would abort
migration `005` and app boot. Wrong on the facts — `timestamptz` has
`typispreferred = t`, so resolution is defined — and wrong on the consequence:
the migration had run three times against real PG 16, and a virgin database
migrated and booted to `/health` 200 while checking. But the neighbourhood was
rotten. **`timestamptz` partition bounds are parsed in the session TimeZone**,
so the same DDL built different partitions per caller: under `America/New_York`
a partition named for May really ran to `2027-06-01 04:00+00`. Retention derives
the upper bound from the **name**, so the daily job would have dropped rows four
hours before they expired and reported success. Migration `007` makes bounds
explicit `+00` text, takes the window from `now() AT TIME ZONE 'UTC'`, and
refuses to run against a database whose partitions already disagree with their
names. Verified across three session timezones and a boundary row.

**Payload filtering (2026-09-20).** dathq asked whether `origin` could actually
be filtered. It could not — file-service has `?origin=` on its own list, but the
event store filters columns and `origin` lives in `payload`, so the field added
two days earlier was visible and unselectable. Fixed generically rather than
with an `?origin=` param: a GIN index on the whole document (migration `008`,
`jsonb_path_ops`) plus `?payload.<key>=<value>` containment matching, so every
payload key is filterable and the next publisher gets it free. Values are
matched as the string *and* as the JSON scalar they parse to, because
containment is type-strict and a query string is always text — otherwise
`payload.duration_seconds=0` would never find the number `0`. A bad key is a
**400**, never ignored. UI: two inputs in the advanced panel that set one key at
a time, chips to remove.

Found on the way: **every filter chip announced itself as "Remove filter"**,
because `aria-label` overrides visible text. Four active filters meant four
identical buttons to a screen reader. Surfaced because `getByRole` could not
address one either — if a test cannot tell two controls apart, neither can a
screen reader.

**Not done, deliberately:** the `type` filter is still free text over 10 distinct
values. Same endpoint shape would fit; nobody has asked.

### Folded in on dathq's word: scaling + file origin (2026-09-19)

Asked whether the indexing was best practice, and told to fold the answers into
this wave. Three repos now: `event-store`, `event-store-frontend`,
`file-service`.

**Indexing was already right** — every service indexes its filter columns; the
only gap was `events.service`, closed above. Two things were not.

**1. `COUNT(*)` on every page.** Replaced with a count over a `LIMIT cap + 1`
subquery (`LIST_COUNT_CAP`, default 10,000), and the response says
`totalCapped` so the UI renders "10,000+" rather than a silently wrong floor.
Offset paging stays while the total is exact, because page numbers need a total.

**1b. …and then the list learned to keep walking (same day).** dathq: *"i
totally forgot why i pick the next and previous from the start, the best
practice for a big ass list should be like that. But for normal list the new
pagination is the best."* He was right, and the first cut had a real gap: at the
cap, **Next disabled** — stranded at page 200 with rows still below, strictly
worse than the Previous/Next it replaced. It is not a choice between two
designs; they answer different halves of one list. Numbers cover what was
counted, a keyset cursor takes over after that. `?after=<opaque cursor>`,
`nextCursor` in the response, migration `006` for the `(timestamp DESC, id
DESC)` index a keyset needs, and Previous as a **stack pop** — the only exact
"back" available with no total. Measured: **15 buffers** against **1,234** for
`OFFSET 650`, and flat with depth. Events only; DLQ keeps offset + cap.

**2. No retention partitioning.** `events` is now `PARTITION BY RANGE
(timestamp)`, monthly, and `retain.ts` drops whole partitions. Detail and the
four consequences live in `platform/event-store-architecture.md`; the one worth
repeating here is that **retention granularity becomes the month** — a row 91
days old survives until its whole month expires.

**3. `origin` now rides the file events.** `files.origin` already existed and is
indexed (63 `chatbot`, 4 `messenger` on 2026-09-19), but it never left
file-service, so the event store could not answer "which product uploaded this".

**Four bugs found by running it, none by reasoning:**

1. **`pnpm build` nested the migrations directory.** `cp -r src/db/migrations
   dist/db/migrations` copies *into* an existing target, so from the second
   build onwards `pnpm migrate` silently skipped every new migration. Latent
   since the repo was written; surfaced because `005` would not apply. **This
   would have bitten any future migration in production.**
2. **`events_ensure_partitions($1)` did not resolve** — a bound parameter
   arrives as `unknown` and Postgres will not pick an overload from it. Needed
   `$1::int`. Found by the service refusing to boot.
3. **`eventsDeleted` was a lie.** It reported `eventsCandidates` (64) when 59
   rows were actually removed, because a partially-expired partition keeps its
   old rows. Found by counting the table before and after on a clone.
4. **A required `origin` found a third publisher.** `conversation-cleanup
   .consumer.ts` emits `file.deleted` for the chatbot cleanup choreography and
   would have kept publishing without it had the field been optional.

Also caught: a backtick inside a template literal closed the SQL string (the
documented trap, again), and `tsc` flagged a spread over `NodeListOf` that the
Playwright suite had run green — test runners transpile, they do not typecheck.

**Verified:** 74 backend / 30 karma / 56 Playwright / 22 file-service, knip and
prettier clean in all three. The migration trialled twice on a `TEMPLATE` clone
before touching the dev database. Retention run end to end on the clone: 715
rows in, `events_y2026m05` dropped, 657 left, `events_deleted=58` matching
exactly. A real `file.uploaded` published through NATS landed in
`events_y2026m09` with `"origin": "messenger"` — which also proves ingest works
against the partitioned table with the new conflict target. The cursor crossover was driven in a real browser against the
real 715 events with `LIST_COUNT_CAP=100`: page 1-2 numbered, Next hands over,
"Page 3" and "Page 4" walk on. Red-proofed: `expected null to be 'messenger'`,
`Expected: "Showing 1–50 of 100+" Received: " Showing 1–50 of 100 "`, and
`toBeEnabled() failed / Received: disabled` for the stranding.

## Bottom navigation runs out of room at 6 products — NOT STARTED (2026-09-20)

Raised by dathq while reviewing the mobile wave: *"i like the footer menu
design but we're gonna have more products in the future so please think about
that"*. He also asked whether the platform should move to an Instagram-style
floating "liquid glass" pill. **Answer: fix the scale, keep the bar anchored.**
Reasoning below, because the *why* is the part that will otherwise be
relitigated.

### The ceiling is real and close

`shell-bottom-nav` renders Home, then `@for (app of environment.apps)`, then
Settings, and every item is `flex-1` — so the bar **grows itself** whenever a
remote is registered, with no width rule to stop it. Measured at 375px on
2026-09-20:

| Items | Width each | State |
|---|---|---|
| **5 (today)** | **75px** | 10px labels, nothing truncated |
| 6 | 62.5px | "Event Store" truncates |
| 7 | 53.6px | most labels truncate; touch target still ≥ 44px, so this fails as *unreadable* rather than as *unhittable* |

`interview-prep` is the next product and `analytics-service` /
`search-service` are documented ahead of build, so the sixth is a question of
when. Nothing announces the failure — labels are `truncate`, so they degrade
silently, which is the same shape as every other bug this workspace has paid
for.

### The plan

Keep the **anchored full-width bar**; cap it at five items and make the fifth a
**"More" entry that opens a sheet** carrying the overflow plus Settings. Slack,
Teams, Gmail and Spotify all converge on this, and they converge on it for
exactly this reason: the number of destinations grows and a fixed bar cannot.

Shape of the work, all **shell-side** — no remote is touched, because
`environment.apps` is already the registry the bar reads:

1. Slice `apps` at the display cap in `AuthenticatedLayoutComponent`; the tail
   plus Settings become the sheet's contents.
2. The cap is a constant, not a media query — the failure is about *room*, so
   if it ever needs to vary it belongs in a container query on the bar itself.
3. The sheet is a new surface: it needs a focus trap, `Escape`, a backdrop, and
   the active-route highlight has to reach an item inside it or a person on an
   overflow product sees no "you are here" anywhere.
4. Guard belongs in the **shell's** suite, and must assert **rendered width and
   truncation**, not item count — `scrollWidth > clientWidth` on the label is
   what actually detects this. A count assertion passes while the bar is
   unreadable.

Cheap interim if a sixth product lands before this is built: drop the labels
below a width and show icons only. Buys one or two slots, costs discoverability,
and is a worse end state — so it is a stopgap, not the plan.

### Why not the floating glass pill

Three reasons, in cost order:

1. **This platform already owns a `backdrop-filter` bug of exactly that shape.**
   The shell toolbar's glass created a containing block for `position: fixed`
   and re-anchored the messenger call dock into the header corner (2026-09-10).
   A floating pill is `position: fixed` **with** `backdrop-filter` — same
   mechanism, and this time under every page rather than above one widget.
2. **It locks in the cap we are trying to escape.** Instagram's pill works
   because it is five destinations permanently. It has no overflow story; a
   full-width bar can spill into a sheet.
3. **It is a native-app idiom leaning on native affordances** — edge-to-edge
   safe areas and no browser chrome. A mobile browser puts its own URL bar
   there, and the pill ends up floating above a second bar.

⚠️ **Do not read this as "no glass".** The bar already uses `datha-glass-bar`
and that visual language is fine and worth pushing further. What carries the
cost is the **detached pill shape**, not the material. dathq likes the current
design; this row is about the item count, not the finish.

## Declare Chrome in the Angular pipeline template — NOT STARTED (2026-09-20)

`stack-angular-karma.yml` runs `--browsers=ChromeHeadless` with no `CHROME_BIN`
and no puppeteer install, so karma uses whatever Chrome the agent image ships.
Five repos rest on it — `shell-frontend`, `chatbot-frontend`,
`event-store-frontend`, `messenger-frontend`, `shared-frontend`.

Surfaced on 2026-09-20 by the `ubuntu-latest` → Ubuntu 26 migration warning
(19 October 2026). Every pipeline is now pinned to **`ubuntu-24.04`**, which
defuses the date but not the dependency: an image migration that moves or drops
Chrome fails those five as a **red**, unattended, and the pin itself expires
when 24.04 retires.

Cost: a `platform-pipelines` change, so a **new tag plus an `ExtendsCheck`
entry** — and per the 2026-09-06 `v8` lesson, only a **canary run** validates a
template change, because the ADO preview API expands YAML without running a
step. Not urgent while pinned; do it before 24.04 retires, and it lets the label
float again afterwards. Detail: `ci/bot-review-pipelines.md` § The agent image
is pinned.

## Phone UI/UX enhancement — DONE (!209-!226, closed 2026-09-21)

> **Complete.** `event-store-frontend` **!222**, `chatbot-frontend` **!224**,
> `messenger-frontend` **!225**, `shell-frontend` **!226**. Zero viewport
> utilities remain in code across all four frontends; the shell's remaining
> four are correct, because it owns the viewport.
>
> Container names: `es-page`, `cb-page`, `ms-page` + `ms-chats`. Declared on
> the **layout** region rather than the page root wherever the page's own host
> carries responsive layout, since an element cannot query a container it
> declares — and all in **component** stylesheets, so they travel with the
> federated JavaScript.
>
> The migration was a no-op standalone in every case, proven by measuring all
> five viewports before and after rather than by reading the diff. What it
> **did** change is hosted: every tier had been firing exactly one step too
> early, by the width of the shell's 224px sidebar.
>
> **Six defects came out of verifying it**, none of them the migration's own,
> each now a rule in `working-agreement.md`: a follow-bottom pin fighting the
> user across a 48-120px dead band; the call dock's stage overflowing a phone
> because a width was set beside insets; connector labels uppercasing
> `createOffer`, a NATS subject and a URL path; a chat reload losing its
> thread (now the `c` query param); the notification toast hanging 45px off
> the left edge; and a settings select clipped by a card's `overflow: hidden`.
>
> Two `anyComponentStyle` **warning** budgets went 10kb -> 16kb (chatbot,
> messenger), matching event-store. A federated remote has to inline rules a
> host will never load, so the number predated the constraint. Error budgets
> untouched at 48kb, and there is no production build step in CI.
>
> **Still open, deliberately:** the shell's phone gutter change
> (`3rem 2rem` -> `1.5rem 1rem` below 30rem) applies to **every** shell page,
> not only the one reported. Flagged in !226 and to dathq; not objected to.

### Original entry (opened 2026-09-19)

> **`event-store-frontend` is migrated and merged (!222, 2026-09-21)** — all 52
> of its viewport utilities are container queries on a named `es-page`
> container, plus frozen-column table scrolling, a stacked filter bar and
> pager. **`chatbot-frontend` (71 utilities) and `messenger-frontend` (48) are
> untouched and are what remains.** `shell-frontend` needs **none**: its four
> breakpoints switch the sidebar for a bottom bar, and the shell owns the
> viewport, so nothing sits beside it — that was checked, not assumed.
>
> What the done third proved, and the remaining two should expect:
> **the guards belong in the shell's suite**, because standalone a remote's
> viewport and content are the same width and the fault is invisible;
> **`_ngcontent` blocks any rule aimed at an element PrimeNG built**, which
> cost four separate silent failures; and **a wrapped row cannot be aligned,
> only replaced**, which was the cause behind both "chaotic" reports.

The landscape sweep of 2026-09-18 closed the acute faults and named the cause:
**every responsive breakpoint in this workspace keys on the viewport, while the
thing that decides a layout is how much room the element actually has.** The two
stop agreeing the instant a host puts a 224px sidebar beside a remote, which is
exactly what the shell does. One viewport, three products, the same bug:

| Where | Measured at 667x375 hosted | Fixed by |
|---|---|---|
| `event-store-frontend` tables | table container **0px tall at top=549**, below the fold, `overflow: hidden` above it | container query on `.es-table-wrap` + `max-height` page scroll |
| `chatbot-frontend` chat page | chat column **117px**, subtitle wrapping one word per line; composer running to 451px in a 375px viewport | container query on `:host` |
| `messenger-frontend` chats page | stage **119px** beside a fixed 288px list | container query on `.chats-root` |

**What is left, and it is not small:** the rest of the `sm:` / `md:` / `lg:`
Tailwind breakpoints across all four frontends are still viewport-keyed. Each
one is a latent copy of the same bug, waiting for a layout to put something
beside it. Migrating them to `@container` is the real fix and is a wave of its
own — it touches every page, needs a container declared per layout region, and
every existing responsive spec has to be re-pointed at the container rather than
the window.

Worth carrying into that wave:

- **Declare the container on the element that owns the layout**, not on `:host`
  by reflex — `.es-table-wrap` and `.chats-root` were right because they are the
  flex parents; `:host` was right for chatbot for the same reason.
- **`container-type: inline-size` implies layout containment**, so it makes the
  element a containing block for absolutely positioned descendants. Check for
  `position: absolute` children first; all three here already had
  `position: relative`, so nothing moved.
- **Container context crosses component boundaries even though styles do not.**
  `thread.component.scss` queries `.chats-root`, declared in a different
  component — and in the docked window, where no ancestor container exists, the
  rule simply never matches, which was the behaviour wanted.
- **A short viewport is a separate axis from a narrow one.** `max-height: 30rem`
  is doing real work in event-store and chatbot and has no container equivalent
  worth reaching for; a landscape phone is short before it is narrow.
- **Verify hosted, not standalone.** Every one of these three looked correct at
  its own port. The guards therefore live in the **shell's** suite
  (`e2e/specs/hosted-landscape.spec.ts`), because a standalone remote cannot
  reproduce any of them.

Also parked here rather than done: **the `--datha-form-*` tokens in
`@datha/platform-ui` describe a 25px control** (11px text, 4.8px padding). That
is right for a table cell and wrong for anything typed into. Only
`event-store-frontend` consumes `.datha-input` today, so it was fixed there
rather than bumping the library for two files — but if a second consumer
appears, fix the token instead and let the dense tables opt out.


1. **Landscape has only been swept in one place.** A phone held sideways is
   667x375: wide enough for the desktop layout, short enough to break it, and
   every breakpoint in the mobile wave keyed on width. Fixed for messenger's
   empty chats stage only. **`shell-frontend`, `chatbot-frontend` and
   `event-store-frontend` have not been looked at in landscape at all**, nor has
   the shell's own chrome.
2. **`WebrtcCallService.selfOwnerId` hardening** — analysed 2026-09-17, not
   reachable today (`realtime-service` sends `ready` before `ringPending` on the
   same ordered connection), latent coupling. Derive it from the access token
   via `src/helper/owner-id.ts` and let `ready` confirm. Its own PR, with the
   mesh exercised.
3. **`event-store-frontend`'s compact table rules are inert hosted** — they live
   in a global stylesheet, which a Module Federation host never loads.

### Superseded: the original bump agreement (2026-09-17)

dathq's call, and it unblocks the row below: *"i want to change theme and lang
from select to button to save space"*, with the other shared-frontend fixes
rolled into the same release. **The `.claude/` save moves behind this bump** —
see the deadline warning in the top row, which now has less room than it did.

Scope is **five repos**: `shared-frontend` (change + `release.yml` publishing a
new tag to `platform-npm`) and the four consumers, every one of which pins
`@datha/platform-ui` at an exact `0.5.0`. That makes it the version-bump case —
compatibility evidence first, then wait.

**Settle before building: who owns theme and language once they are buttons.**
This wave hid both selects below `sm` in the shell and made the Settings page
their home, because a select is ~150px and five controls wrapped the toolbar
onto three rows. Small buttons may fit the compact toolbar, at which point
Settings and the toolbar are two surfaces for one preference. That is not
automatically wrong — both write through `ShellContextService`, so it is one
mechanism with two surfaces, the same shape as the chats page and a docked
window — but it should be a decision, not a leftover. The remotes have no
Settings page, so **for them the toolbar is the only home** and the buttons are
what makes it fit.

### Deliberately not done: the remotes' standalone headers

All three remotes wrap their own header onto **three rows at 390px** (~140px),
the same fault the shell had. Not fixed, and not because it is hard: the shell
could move theme and language into Settings, and **a remote has no Settings
page**, so hiding them there would strand both capabilities. The alternative —
icon-only selects — is a `shared-frontend` change plus a library version bump,
which is the cross-repo case that wants evidence presented first. dathq's call.

### The dock window resize — fixed, and it exposed a platform-wide trap (2026-09-17)

dathq: *"when i open the dock chat. It open then it got resize bigger (width
wise)"*. Root cause is not animation or timing: **a Module Federation host does
not load a remote's global stylesheet.** `--messenger-dock-width` lives on
`:root` in `messenger-frontend/src/styles/base.scss`, so inside the shell it
computed to the empty string, `width: var(--messenger-dock-width)` was invalid,
and the window fell back to `width: auto` — content-sized, and widening as the
thread loaded. Measured: **299px hosted vs 320px standalone**. Fixed with a Sass
constant (`styles/_dock.scss`) compiled into each consumer; the custom property
is still published from it so the corner stays themeable, but no layout depends
on it. Guarded by `shell-frontend/e2e/specs/dock-window.spec.ts`, which samples
the width across 40 frames — a single late reading would have passed against the
bug. Red-proofed at `Expected [320], Received [299]`.

**The sweep for other instances found two more**, and the trap is general:

| Remote | Property | State |
|---|---|---|
| `messenger-frontend` | `--messenger-dock-width` | **fixed** |
| `event-store-frontend` | `--es-table-min-width{,-dlq}` | **added this session; given `var(…, 52rem)` fallbacks** so the hosted tables keep their floor |
| `chatbot-frontend` | `--app-toolbar-height` | pre-existing, unaudited |

⚠️ **The consequence nobody has addressed:** every rule in a remote's global
stylesheet is inert inside the shell. For `event-store-frontend` that includes
the whole `_table.scss` — the `.es-table__secondary` colours and
`.es-table__action-col` width (both pre-existing) **and this wave's compact
table rules**, so the ops tables are responsive standalone at :4002 and are
**not** responsive hosted at :4000/event-store. Making them work there means
moving those rules into the page components' own styles, which is a real change
and not part of this wave. Same question stands for `chatbot-frontend`.

### The gucci check caught one more — an SCSS budget warning (2026-09-17)

`pnpm build:prod` (never `pnpm build`, which is the *development* configuration)
reported `call-dock.component.scss exceeded maximum budget. Budget 10.00 kB was
not met by **7 bytes**`. Mine: the `@use` line plus a
`var(--messenger-dock-width, #{dock.$width})` fallback tipped a file that had
been just under. It would have reached dathq as a yellow PR, which he does not
merge.

Fixed by making it *smaller* rather than splitting or bumping the budget: the
three consumers now take `dock.$width` directly, which compiles shorter than the
`var(…, fallback)` form, and the custom property — which then had no reader at
all — was removed along with the three comments that still described it. Clean
`build:prod` afterwards: **no budget warning**.

Worth keeping as the reason the audit exists: every suite was green before this
ran, because no test compiles with production budgets.

### The wave is merged (2026-09-17)

**!192** `messenger-frontend`, **!193** `chatbot-frontend`, **!194**
`event-store-frontend`, **!195** `shell-frontend` — all merged, branch
`feat/mobile-responsive-ui` deleted in each, every repo back on `main` and
clean. No cross-repo contract changed and `@datha/platform-ui` stayed at
`0.5.0`, so there was no release and no merge order.

Two late additions rode the same branches after review:
`event-store-frontend`'s compact rules moved out of the global stylesheet into
a mixin each page component includes — a host never loads a remote's global
sheet, so they had been inert at :4000 while passing every check at :4002 —
and `shell-frontend` gained `hosted-ops-table.spec.ts` to pin that from the
host side. Verified hosted: **3 of 6 columns, table 305px**, against **6
columns and 832px** with the mixin neutralised.

**Mobile is now done for all four frontends.** What remains of the row above is
the remotes' own standalone header, which the v0.6.0 bump below is the fix for.

### Still open after this wave

1. **The remotes' standalone header** wraps to three rows at 390px — waiting on
   the shared-frontend bump, which turns theme and language into buttons.
2. **`WebrtcCallService.selfOwnerId` is only ever set by the socket's `ready`
   frame.** Analysed 2026-09-17 and **not reachable today**: `realtime-service`
   sends `ready` (server.go:134) before `ringPending` (135) on the same ordered
   connection, and the value is sticky across reconnects. It stays a latent
   coupling — five behaviours read it, and `politeTo` compares `"" < ownerId`,
   which is always true, so an unset client would always yield a glare, in
   silence. Recommended fix is to derive it from the access token via
   `src/helper/owner-id.ts` and let `ready` confirm it, exactly as
   `ChatStore.syncOwnerId()` already does for the same value. Its own PR, with
   the mesh exercised — not a late commit on someone else's branch.

**Scope implied:** four repos, four PRs, shell first — it is both the worst
offender and the one whose fix changes what the other three are laid out inside.

## `interview-prep` — next product, NOT STARTED (2026-09-21)

**`profile-match` and the interview-practice build spec were merged into one
product on 2026-09-21.** They were never two: the spec's CV × JD matching step
*is* profile-match's entire scope, and it exists there to feed the part with the
actual value — an interview you take, get scored on, and take again.

Docs are written and refined; **no code, no repos, nothing scaffolded**, and
`critical-behaviors.md` #8 still applies.

- `products/interview-prep-architecture.md` — the product, data model, build order
- `services/interview-prep-service-architecture.md` — API/worker, AI contract, Gemini
- `services/interview-prep-frontend-architecture.md` — screens, streaming, resumption

The three `profile-match` docs are deleted; their contents are folded in and the
four points where the two designs disagreed are recorded in the product doc
§ What changed when profile-match was folded in.

**Decided 2026-09-21, so they are not relitigated:**

| Question | Answer |
|---|---|
| Name | `interview-prep-service` (:3007), `interview-prep-frontend` (:4004) |
| Provider | **Gemini, free tier.** `chatbot-service`'s raw-REST client is the pattern; structured output via `responseSchema` is the one genuinely new piece, since chatbot streams prose and never needed it |
| Voice | **Out.** Every credible STT is paid, and it is the highest-risk component — its errors get scored as your errors. Steps 1-8 are a complete product with no audio in them. Revisit only if a free path (browser `SpeechRecognition`, local Whisper) proves out |
| Vector search | **Ships, but not under the match.** One CV × one JD is not a corpus problem and retrieval cannot produce `evidence[]` quotes. OpenSearch earns its place at step 9 on the two corpora that actually grow: the JD library ("which of my 40 saved JDs fit best") and past attempt transcripts |

That last row is the one dathq should push back on if he disagrees — it is the
only place the merge overrode a stated preference ("I still want to try and test
all the techs"). The tech is still built and tested; it is aimed at a question
that exists rather than under a single-pair comparison where an index answers
nothing.

**Prerequisite:** a 4th remote makes the shell's bottom bar six items, which
truncates silently. The bottom-nav cap above stops being optional.

**Also new infra:** OpenSearch in `_local/docker-compose.yml`, at step 9 — the
first container this platform adds since coturn.

## Synced 3D viewer — extraction done, product undecided (2026-09-22)

A room of platform accounts watching one 3D model together, with shared playback and
personal view controls.

**Extracted, not started:** `products/synced-3d-viewer.md` holds the three.js core (camera
authored *inside* the GLB and driven by the mixer; clip-name-addressed steps; per-step audio
and transcripts), the cross-machine sync protocol, and the four things wrong with it.

dathq's stated intent: explore three.js properly, and drive the 3D actions across machines
over **`realtime-service`** instead of the legacy app's Pusher. The second is the stronger
reason — realtime has only ever carried WebRTC signalling, and a completely different consumer
is what proves the room model generalises.

**Product shape decided 2026-09-22.** A room of N platform accounts, invited through the
accounts directory. `start` and `goto` are shared; transport, volume, subtitles, **language**
and camera are personal — which the legacy app synced, wrongly for peers. At most two
participants hold the shared commands: the host plus one grantee, **granted at runtime and
revocable**, expressed as a `ClaimWithTTL` keyed by `owner_id` so a dead grantee lapses by
itself. Room state is an `anchor_step`, not a `current_step`.

**Stack decided 2026-09-22: React, as a federated remote** — the platform's first
non-Angular frontend. `@react-three/fiber` is the reason; *"still need to be in the
ecosystem"* is why it is a remote rather than the standalone app that was offered. The
container protocol picks the bundler: the shell loads **webpack 5 MF v1** containers, so
Rspack/webpack, or a loading spike first if Vite is kept. Full integration contract
(mount-function expose, `afterNextRender`, JS-injected CSS, host-provided
`getAccessToken`, theme via the cascade) is in the product doc.

⚠️ **The trap most likely to bite:** a host never loads a remote's global stylesheet, and
Tailwind 4 emits one. Extracted CSS renders perfectly standalone and unstyled hosted.

⚠️ **The GLB models and narration audio are client assets**, not dathq's. Techniques carry
over; those files do not. Use a freely-licensed rigged model to learn against — the design is
clip-name driven, so the asset swaps out without changing anything structural.

**Two products now queue behind the bottom-nav cap** — `interview-prep` is the 4th remote
and this is the 5th. It stops being a backlog row and becomes a prerequisite for both.

## Zoneless migration — PREREQUISITE for the 3D viewer (2026-09-22)

All four frontends still run **Zone.js**: `angular.json` lists `polyfills: ["zone.js"]` in
every one, `zone.js ~0.15.1` is pinned in every `package.json`, and
`provideZonelessChangeDetection` appears nowhere. Angular 21 defaults *new* apps to zoneless;
these predate that and were never migrated.

Normally a tidy-up. It becomes a **prerequisite** for `synced-3d-viewer`, because Zone.js
monkey-patches `requestAnimationFrame`: a three.js render loop inside a federated remote
would trigger a full change-detection pass across the shell's entire component tree **60
times a second**. Invisible standalone at :4004 — there is no Angular there to tick — and
janky hosted, which is the same shape as every other Module Federation trap this workspace
has paid for.

`ngZone.runOutsideAngular()` around the mount is the workaround and stays worth having
regardless (a remote cannot assume its host is zoneless). Migrating is the fix.

Scope: four frontends, four PRs, shell first. The real work is not the provider swap — it is
finding every place that relied on Zone.js to notice a change: `setTimeout`/`setInterval`
callbacks mutating state, third-party callbacks (PrimeNG overlays, the OAuth library),
`addEventListener` outside Angular, and anything resolving a promise into a template
binding. Signals are already the idiom across these repos, which is what makes this
tractable; the audit is for what is *not* a signal yet.

## Related rules

- **`services/shared-frontend-architecture.md`** — v0.2.0 roadmap (glass, dialog, login-card, form wrappers, theme model, dark utilities)
- **`ci/bot-review-pipelines.md`** — Key Vault variable group pattern
