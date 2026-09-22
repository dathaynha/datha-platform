# E2E Testing Strategy (Playwright)

_E2E testing strategy with Playwright — shell suite (shipped), auth seeding, selector rules, pipeline placement_

Unit and service-level tests: **`testing/unit-testing-strategy.md`**.

## Shipped: shell-frontend suite (PR 44, 2026-07-29)

```
shell-frontend/
  playwright.config.ts   ← repo root; webServer starts/reuses :4000, system Chrome (channel: chrome)
  e2e/
    global-setup.ts      ← mints gateway-shaped HS256 JWT → storageState (seeded auth)
    fixtures.ts          ← authedTest = test + seeded storageState
    specs/*.spec.ts
```

Scripts: `pnpm e2e` (headless), `pnpm e2e:ui` (UI mode), `pnpm e2e:headed`.

### Auth = seeded, never clicked

Real IdP round-trips (Google/Microsoft) are not automatable (bot walls, 2FA, credentials in CI). `global-setup.ts` mints the JWT with node crypto and writes the angular-oauth2-oidc localStorage keys — `hasValidAccessToken()` only checks presence + `expires_at` client-side. Levers when a spec needs more:

- `E2E_JWT_SECRET` = the gateway's secret → gateway ACCEPTS the minted token (API-hitting specs)
- future opt-in `E2E_AUTH_MODE=refresh`: exchange the stored Google refresh token via the gateway token proxy for real tokens (needs running gateway; refresh token as CI secret)

### Remote-dependent specs self-skip

Offline-dialog vs hosted-sub-header specs probe `remoteEntry.js` and skip in the opposite remote state — exactly one of each pair runs, shell-only CI exercises the offline path. All remotes live in one `REMOTES` table; new app = new row.

### Selectors

Prefer **role/label-based** locators (`getByRole`, `getByText` for i18n assertions) — they double as a11y checks and survive restyles. `data-testid` is the fallback for elements with no semantic handle — not the default.

**Never write a locator that encodes an a11y bug.** Before lib v0.5.0 several specs worked _around_ PrimeNG hosts carrying the accessible name — `[aria-label='Notification settings'] button`, `getByRole("button", { name: /^close$/i }).last()` (X and footer shared the name), a loose `/notifications/i` that only matched one element because the bell's name sat on a non-button host. Fixing the lib broke all three: the workaround selectors stopped matching, and the loose regex became ambiguous once the bell button got a real name. Those failures were the fix working. Write the locator the accessible tree _should_ have, and if that is impossible, fix the component instead of the spec.

### CI

E2E runs inside `bot-review.yml` after unit tests: config-managed dev server on the agent, system Chrome, JUnit published, traces uploaded on failure. `CI=true` enables retries ×2 + junit reporter.

## Shipped: chatbot-frontend suite (2026-08-17, extended 2026-08-27/28) — 54 specs

Same shape as the shell, in the remote's own repo, against **standalone mode** (:4001):

```
chatbot-frontend/
  playwright.config.ts   ← webServer starts/reuses :4001, system Chrome, 2 local workers
  e2e/
    global-setup.ts      ← same seeded-auth mint, storageState for :4001
    fixtures.ts          ← authedTest
    chat-api-mock.ts     ← all gateway + file-service stubs, request recorder, shared waits
    specs/
      chat-send.spec.ts            (6)  send → SSE, Enter/Shift+Enter, queued state, error paths
      chat-sidebar.spec.ts         (9)  list, untitled fallback, empty, rename, delete, pagination
      chat-thread-history.spec.ts  (9)  newest page, older paging + cursor, hint, failure retries
      chat-model-picker.spec.ts    (5)  list, search, pick, persistence, fallback on failure
      chat-attachments.spec.ts     (6)  prepare → SAS PUT → confirm, remove, size cap, failures
      chat-reattach.spec.ts        (4)  replay, 204, done-dedupe, expired stream
      chat-jump-to-bottom.spec.ts  (3)  visibility threshold, return-to-bottom, geometry
      chat-retry.spec.ts           (6)  Try again (live + from history), 409, no button on client errors, worker retry progress, exhausted retries
      auth-and-shell.spec.ts       (6)  guard → /login, providers, toolbar nav, i18n, landmarks
```

Scripts and CI step mirror the shell (`pnpm e2e`, Playwright step in `bot-review.yml` after unit tests, JUnit published, traces on failure).

**Gateway and file-service are route-mocked, never live.** `chat-api-mock.ts` owns the stubs and returns a **recorder** (posted message bodies, older-page cursors, patched titles, deleted ids) so specs assert on requests, not just DOM. SSE is fulfilled as a `text/event-stream` body of `id:`/`data:` frames, with the follow-up reconnect answered 404 so `EventSource` stops retrying. A retried job gets its own id (`RETRY_JOB_ID`) so the stream route can serve different frames for the second attempt.

- **"Flaky spec" that is really launch starvation (2026-08-28).** Failures reading `Test timeout exceeded while setting up "context"` happen _before any test code runs_ — the browser could not launch in time. On a machine also running the platform's dev servers, two Chrome workers is enough to trigger it (~1 failure in 10 full runs, always a different spec, which is what made it look like a scroll race). Local `workers: 1` + a 60s local test timeout fixed it; CI keeps full parallelism and the 30s budget. Read the error before hardening a spec — the assertion was never the problem.

- **Open streams need a real socket (`liveSse`, 2026-08-28).** `route.fulfill` can only send a complete body, and closing it is what `EventSource` reports as an error — so any state that exists _while the stream is still open_ (the worker's `retrying` frame) cannot be asserted through a fulfilled route without racing. `e2e/sse-server.ts` starts a node SSE server on an ephemeral port; the stream route is `route.continue({ url })`-rewritten to it, and it holds the socket open after the scripted frames. The page still believes it called the gateway, so the server sends `Access-Control-Allow-Origin`. Frames carry their own `delayMs`. Teardown runs on page close, and `stopSse()` is exposed on the recorder.

**Patterns that matter here:**

- **Unmocked-request tripwire.** A catch-all `**/api/**` route is registered _first_ (so every specific stub wins) and fulfils 599 while recording the URL. Without it a missing stub reaches the real gateway on :8080, which 401s the e2e JWT and pops the global error dialog — a failure that looks nothing like its cause. This is how the `DELETE /files/:id` on attachment-remove was found.
- **The global HTTP error dialog fronts every failed request** and blocks the page until dismissed. `dismissGlobalErrorDialog()` targets `datha-message-dialog` because the PrimeNG header X and the lib footer button are _both_ named "Close" (the known lib a11y nit).
- **Never scroll once and assert.** `settleAtBottom()` waits out the follow-bottom clamp after a thread opens; `scrollToTopUntil()` keeps nudging until the expected effect appears. Three separate flakes were all this same race.
- **Paginate stubs by query param, not call order.** The sidebar auto-fetches when scrolled near the bottom, so call-order stubbing served the wrong page under load.
- **Assert what renders, not the DTO.** Model labels are shortened for the trigger (`shortModelDisplayName` strips a leading "Gemini "), so `Gemini Pro` renders as `Pro`.
- **A fulfilled SSE route closes the stream**, which `EventSource` reports as an error. An in-flight generation needs a _delayed_ fulfil (`holdStreamOpen`); never answering leaves a dangling request that slows teardown and can starve browser launch.
- **Restart the dev server after a dependency install.** A running `ng serve` caches absolute `node_modules/.pnpm/...` loader paths; `pnpm install` relinks them and the server then serves a broken bundle (`Can't resolve .../mini-css-extract-plugin/dist/loader.js`) while still answering on the port.

**Two app bugs the suite found:** the unconditional placeholder removal on a dropped stream (partial text wiped mid-replay), and `CHAT.MODEL_LABEL` / `CHAT.MODEL_SEARCH` missing from both locales, so the model search box rendered the raw key as its placeholder.

## Shipped: event-store-frontend suite (PR 106, 2026-09-04) — 39 specs

Third and last frontend suite; the ops UI was previously verifiable only by hand.
Same shape again, against **standalone mode** (:4002):

```
event-store-frontend/
  playwright.config.ts       ← webServer starts/reuses :4002, system Chrome, 1 local worker
  e2e/
    global-setup.ts          ← same seeded-auth mint, storageState for :4002
    fixtures.ts              ← authedTest
    event-store-api-mock.ts  ← all gateway stubs, request recorder, fixtures
    specs/
      auth-and-shell.spec.ts (8)  guards, deep links, sub-header tabs + aria-current, i18n, profile
      events-list.spec.ts    (9)  rows, filters → query params, advanced toggle, paging, sort, empty, error
      events-detail.spec.ts  (5)  row → detail, deep link, payload, back, failures
      dlq-list.spec.ts       (6)  rows, replayed/pending status, sink + correlation filters, paging, empty, error
      dlq-detail.spec.ts     (11) fields, replay confirm/cancel, success, 409/400/server-message, inline-not-modal, load error
```

**The mock is a URL dispatcher, not a pile of globs.** One handler on
`**/api/event-store/**` parses the pathname and branches; anything it does not
recognise calls `route.fallback()` into the tripwire. That avoids reasoning about
glob precedence between `/dlq/:id` and `/dlq/:id/replay`, which differ only by a
suffix.

**Paging is computed from `limit`/`offset`, never from call order** — the same
lesson as the chatbot sidebar. `makeEvents(60)` / `makeDlqRecords(60)` generate a
dataset the stub slices, so a paging spec asserts both the rendered rows and the
offset the page asked for.

**Filters are asserted through the recorder, not the DOM.** The point of a filter
is the request it produces, so specs read `eventListQueries` / `dlqListQueries`
and check `service=`, `type=`, `correlation_id=`, `offset=`, `order=`. This is
also what proves the repeated-param encoding (`?type=a&type=b`).

**Replay is the one state-mutating action in the platform's ops UI**, so it gets
the most coverage: confirmation required before any POST, cancel proves _no_
request, and each backend status maps to its own message (409 already replayed,
400 no envelope, server-supplied `error` body wins over the generic copy). One
spec asserts a replay failure renders inline and does **not** open the global
message dialog — the service sets `SKIP_GLOBAL_ERROR_DIALOG` for exactly that
reason, and a modal over an ops action would hide the record being diagnosed.

Two things the suite turned up while being written: `DLQ_PAGE.TABLE.ORIGINAL_SUBJECT`
was a dead i18n key (header removed, cell never existed) — deleted from both
catalogs; and `typesFromInput` sorts, so `"file.uploaded, file.deleted"` reaches
the service sorted. That is deliberate (canonical query state = stable deep
links) and the spec asserts the sorted form.

## E2E specs are typechecked (all three frontends, 2026-09-04, PRs 105-107)

**Playwright transpiles with esbuild and never checks types**, and `e2e/` sits
outside `tsconfig.app.json` / `tsconfig.spec.json` — so until now a green suite
proved nothing about the specs' types, in any of the three repos. Each frontend
now carries:

- `@types/node` **pinned exact, same version in all three repos** (24.13.3 since
  the 2026-09-04 Node 24 sweep) — the typings major must match the runtime that
  executes the specs, and every pipeline runs `UseNode@1` with `version: '24.x'`
  (`always-apply/workspace-layout.md` § Node version owns that number). Do not
  `pnpm add -D @types/node` and take the default: it resolves to the newest
  major (26 at the time of writing) and,
  because the Angular toolchain declares `@types/node` as a peer, that drags the
  whole tree's resolution up with it — a ~120-line lockfile diff and typings that
  advertise APIs CI's Node does not have. A green suite will not catch it;
  `@types/node` is compile-time only. Check the lockfile diff after any add.
- `tsconfig.e2e.json` — extends the root config, adds `"types": ["node"]`,
  `noEmit`, and includes `e2e/**/*.ts` + `playwright.config.ts`
- `pnpm typecheck:e2e`, wired into `bot-review.yml` **before** the Playwright
  step so a type error fails fast instead of after a browser run

All three passed on the first run, so this adds a guard rather than fixing a
backlog of errors. Do not "fix" a type error by running the suite and seeing it
pass — that check is not the one that would catch it.

## Shell suite hardening (PR 107, 2026-09-04)

Brought the shell suite up to the patterns the two later suites established:

- **`e2e/notification-api-mock.ts`** — the bell/drawer and preferences specs each
  carried their own copy of the notification stubs; now one module with an
  options object (`notifications`, `unreadCount`, `pushEvent`, `preferences`) and
  a recorder (`putBodies`, `unmocked`).
- **Unmocked-request tripwire** added, as in the other two suites.
- **`workers: 1` + 60s timeout locally** — the launch-starvation fix was
  discovered after the shell suite shipped and never backported.
- **Stale workaround selectors removed.** `datha-profile-popover button` and
  `shell-notification-bell button` (with comments citing the lib a11y nits as
  still-open) predate lib v0.5.0, which gave both triggers real accessible names.
  They now use `getByRole("button", { name: "Open profile menu" | "Open
notifications" })`. A workaround selector that outlives its bug is worse than
  the bug: it silently asserts the broken tree is correct.

One trap when centralising a mock: the old preferences helper 401'd the
stream-token immediately, the bell one served a valid token on the _first_
connect. Collapsing those into `if (streamServed || !pushEvent)` broke two specs —
the bell resyncs its unread count only after a **successful** connect, so the
badge stayed empty. The first mint must always succeed.

## Manual verification against the real stack (local, 2026-08-27)

For "does this actually work against real Postgres/Redis/NATS/Gemini", drive a **headed
Chrome through the repo's own Playwright** — not the VSCode simple browser (dathq's
preference) and not a real OAuth login.

**Real sign-in is not available in an automated browser.** Google answers
_"This browser or app may not be secure"_ for any automation-controlled Chrome, so the
login button is a dead end regardless of who clicks it. Seed the session instead — the
same approach as `global-setup.ts`:

1. **Mint a gateway-shaped HS256 JWT** (`sub` = owner id) and write the
   angular-oauth2-oidc localStorage keys via `context.addInitScript(...)` before the app
   boots, then reload once (init scripts land on the _next_ document). Optionally seed
   `chatbot.selectedModel` to dodge a flaky default model.
2. **Make the gateway accept it without reading `.env`.** Start the gateway with
   `JWT_SECRET=<throwaway> go run -mod=vendor ./cmd/gateway` — `godotenv.Load()` does
   **not** overwrite existing env vars, so the process env wins and the real secret in
   `api-gateway/.env` is never read. Nothing on disk changes.
   **Restore afterwards** by restarting the gateway with no override, and confirm the
   throwaway token now 401s.
3. **Persist the browser profile** (`launchPersistentContext` with a profile dir under
   `.claude/tmp/`) so a session survives relaunches; delete the profile when finished.

**Routes differ between host and standalone:** the shell mounts the remote at
`/chatbot`, whose own sub-nav puts chat at **`/chatbot/chat`**; the standalone remote
serves **`/chat`** on :4001. `/chatbot` alone renders the remote's Overview page — an
easy 30 s timeout when a script expects the composer.

**Verify Playwright resolution when the script lives outside a repo:** `require` resolves
from the script's own directory, so a helper in `.claude/tmp/` needs
`createRequire(path.join(REPO, "package.json"))`.

Worth knowing: the chat translations come from the **remote's** i18n bundle even when
hosted (shell's `en.json` has no `CHAT` block), so a remote-side i18n fix does apply in
the shell.

## Cross-service E2E (future)

Requires the **`int` environment** — the deployed integration tier (all services deployed and wired). `int` is this platform's name for what is elsewhere called staging; the frontends already carry `environment.int.ts` and an `integration` build config, so use `int` everywhere and do not introduce a second name. Nothing is deployed there yet — see `platform/platform-backlog.md`. Flows like delete-chat → files-cleanup go in a **nightly** `e2e.yml` against `int` — never a PR gate. All three frontends now have their own suite in their own repo (shell 22, chatbot 54, event-store 39); the `int` work adds a cross-service tier on top, it does not replace them.

## ADO permission needed

For any pipeline that posts comments on PRs, the build service identity needs:
**Project Settings → Repositories → [repo] → Security → `[repo] Build Service` → Contribute to pull requests → Allow**

## Mocking a WebSocket, and the route-glob trap (2026-09-08)

Playwright's `page.routeWebSocket(pattern, handler)` makes the mock *be* the server: `ws.send(...)` pushes a server frame at the app and `ws.onMessage(...)` captures what the app sent back. That is how the shell's unread-badge specs assert the frame → badge contract without a running `realtime-service`, which keeps the run hermetic and the frames exact.

**The trap:** `page.route("**/api/realtime/token", …)` does **not** match `…/token?culture=en-US`, and the shell's interceptor appends exactly that. An unmatched route is silent — the real request goes to the gateway, returns 401, and the feature simply never initialises, which reads as a broken feature rather than a broken mock. Always end an HTTP route glob with `*` (`**/api/realtime/token*`) or use a regex. Found by logging `page.on("request")` after a badge spec failed with the product code working correctly.

## Timeouts that are not the test timeout

`playwright.config.ts` raises the **test** timeout locally because the machine
also runs the platform's dev servers and Docker. Two waits do not inherit it
and have bitten this suite (2026-09-10):

- **`expect.poll` defaults to 5s.** Opening the messenger socket means loading
  the remote, minting a stream token and connecting; under contention that
  overran about once in fifteen runs. Pass an explicit timeout
  (`SOCKET_POLL` in `chat.spec.ts`).
- **`page.waitForEvent(...)` has no default bound.** With a `.catch()`
  swallowing the rejection it sits for the whole test timeout and then fails on
  a later assertion, which reads as a hang rather than a bug. Always give an
  incidental `waitForEvent` a short explicit timeout.

Neither is a flaky test: both were unbounded waits meeting a slow machine.

A third shape, same root: **sampling a value once, immediately after the action
that changes it.** The composer-growth spec read `clientHeight` straight after
`fill()`, but the growth happens in the Angular `input` handler, so the read
raced the reflow and failed about once in four full runs. `expect.poll` fixes
it *and* keeps the test honest — with growth disabled it still fails
`Expected: > 38, Received: 38`. Prefer `expect.poll` over a bare read whenever
the value is produced by a handler rather than by the action itself.
