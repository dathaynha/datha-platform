# shell-frontend — architecture and design rules

_Architecture, design rules, and conventions for shell-frontend (Angular host app for module federation)_

## Role

`shell-frontend` is the **platform host app**. It owns authentication, top-level routing, the persistent outer shell UI (header + collapsible sidebar), and the federation manifest that loads remote micro-frontends. It is the **only** app the user hits directly; everything else is loaded as a remote.

## Account provisioning (added 2026-09-09)

`AccountSyncService` POSTs `/api/accounts/users/me/sync` from
`AppComponent.ngOnInit` whenever the session is valid.

**This was missing entirely.** Every doc said the shell called it after login;
nothing did, and `git log -S` confirms it never existed. That endpoint is the
only thing that creates a user row, so the Messenger directory was empty after
six successful logins and nobody could find anyone to start a conversation with
— reported as "I couldn't even find a person to chat with".

- **On every app start, not only after a fresh login.** The call is an upsert, so
  repeating it is free, and that is what makes it self-healing for sessions that
  predate the code or were established while accounts-service was down.
- **No identity in the body.** accounts-service reads the gateway-injected
  `X-Owner-ID` / `X-User-Email` / `X-User-Name` / `X-User-Picture`, so a client
  cannot claim to be someone else.
- **Silent, and resolves even on failure.** Provisioning must never block app
  start or stack a modal on every load; the row appears on the next start.
- Consequence worth remembering: **a person is only findable once they have
  signed in at least once.** There is no invite or pre-create, so any
  two-account test needs both accounts to have visited the shell.

## Build config — declared CommonJS dependencies

`angular.json` declares `allowedCommonJsDependencies` for
`@angular-architects/module-federation` and `jsrsasign` (2026-09-09). Both are
unavoidable — the federation runtime, and a transitive dependency of
`angular-oauth2-oidc-jwks` — so `build:prod` emitted two CommonJS bailout
warnings on every single run. Declaring them turns noise nobody can act on into
an explicit decision and leaves the production build clean. The shell is the
only frontend that hits this.

## Ports

| App | Port |
|---|---|
| `shell-frontend` | **4000** |
| `chatbot-frontend` | **4001** |
| `event-store-frontend` | **4002** |

## Stack

- **Angular 21** — NgModule-based app bootstrap (needed for `RouterModule.forRoot`), standalone components inside, signals for local state.
- **`@angular-builders/custom-webpack:browser`** — webpack builder (NOT esbuild). Required for Module Federation; esbuild does not support MF.
- **`@angular-architects/module-federation` v21.2.2** — pinned to the same major as Angular.
- **PrimeNG + Tailwind CSS v3** — Tailwind v4 is incompatible with webpack; stay on v3.
- **`ngx-translate`** — i18n, JSON catalogs per app.
- **`angular-oauth2-oidc`** — Google + Microsoft Entra (PKCE) via `api-gateway` proxy.
- **pnpm** — package manager.

## CI — bot review

Mirror **`chatbot-frontend`** (canonical): `azure-pipelines/bot-review.yml`, `.mega-linter.yml`, `.pr_agent.toml`, Karma JUnit in `karma.conf.js`. Change only `shell-frontend` markers/titles. Details: **`ci/bot-review-pipelines.md`**.

## Routing map

```
/login                → UnauthenticatedLayoutComponent → LoginPageComponent   (LoginPageGuard)
/ (AuthGuard)
  ├── ''              → HomePageComponent  (app-launcher grid)
  ├── /chatbot        → ChatbotRemoteEntryModule  (MF remote)
  │    ├── ''          → chatbot HomePageComponent (shelled mode)
  │    └── /chat       → ChatPageComponent         (shelled mode)
  ├── /event-store    → EventStoreRemoteEntryModule  (MF remote)
  │    ├── ''          → event-store HomePageComponent (Overview, shelled mode)
  │    ├── /events     → Events feature (list + :id detail)
  │    └── /dlq        → DLQ feature (list + :id detail + replay)
  └── /messenger      → MessengerRemoteEntryModule  (MF remote)
       ├── ''          → messenger HomePageComponent (Overview, shelled mode)
       └── /chats      → Chats feature (list + thread panes, shelled mode)
```

`AuthGuard` redirects unauthenticated users to `/login`. `LoginPageGuard` redirects authenticated users to `/`.

## Layout

**Unauthenticated layout** — login page only, no chrome.

**Authenticated layout** (`AuthenticatedLayoutComponent`) — two nested levels:

1. **Shell outer layer** (always visible after login):
   - **Top header**: platform logo, language switcher, user profile menu.
   - **Collapsible sidebar**: list of available apps (static `AppDescriptor[]` for now). Highlights the active remote via `routerLinkActive`; link colours come from the lib's `--datha-chrome-*` tokens (one recipe shared with `datha-sub-header`, so sidebar and remote bars cannot drift).

   **App descriptors carry routing config only** (2026-09-03). `environment.apps` entries are `{ icon, route, remoteName }` — no `name` / `description`. Display strings live in the i18n catalog under `APPS.<REMOTE_NAME>.NAME` / `.DESCRIPTION`, derived from `remoteName` by `appNameKey()` / `appDescriptionKey()` in `src/models/app-descriptor.model.ts` (`event-store` → `APPS.EVENT_STORE`). Home cards, sidebar labels, sidebar tooltips and the `BRAND.WITH_APP` header all read the keys, so adding an app means one env entry plus two catalog entries per language. The shell owns the `NAV.*` namespace; remotes must use `SUBNAV.*` (see `shared-frontend-architecture.md` v0.5.0 — `registerRemoteTranslations` replaces whole top-level subtrees).
   - **`<main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">`**: remote fills this area.
   - `<router-outlet>` inside main — children must use `h-full` / `flex-1` to fill it.

2. **Remote inner layer** (rendered by the remote itself in shelled mode):
   - Slim sub-header: `datha-sub-header` from the lib (v0.5.0) — router-anchor tabs for the remote's own pages, projected Email Support button. Language, profile, logout are **hidden** (shell owns those).
   - Remote page content.

The shell header and sidebar are **never** replaced or hidden by a remote.

## Module Federation setup

### Shell (`webpack.config.js`)

```js
const allShared = shareAll({ singleton: true, strictVersion: false, requiredVersion: 'auto' });

// Filter out TypeScript path aliases (e.g. @pipes, @directives) that shareAll
// picks up from webpack resolve config. They pollute the MF shared scope and
// cause module-ID collisions with exposed remote entry modules.
const realPackages = new Set([ ...deps, ...devDeps ]);
function rootPackage(name) { /* scoped: @scope/pkg, unscoped: pkg */ }
const shared = Object.fromEntries(
  Object.entries(allShared).filter(([k]) => realPackages.has(rootPackage(k)))
);

withModuleFederationPlugin({
  remotes: {},           // loaded dynamically via manifest
  sharedMappings: [],    // REQUIRED: prevent non-wildcard tsconfig paths from becoming shared MF modules
  shared,
})
```

**`sharedMappings: []` is mandatory.** Without it `withModuleFederationPlugin` auto-registers non-wildcard tsconfig path aliases (e.g. `@pipes`, `@directives`) as shared modules. This creates consumer virtual modules whose webpack IDs collide with the exposed remote entry, making the router receive the wrong object and throw **NG0919**.

### Remote (`chatbot-frontend/webpack.config.js`)

```js
exposes: {
  './Module': './src/remote-entry.ts',  // exposes a NgModule, NOT a Routes array
}
```

Same `sharedMappings: []` + same `shareAll` filter required.

### Remote entry pattern

Remotes must expose a **`@NgModule`** (not a plain `Routes` array). The Angular compiler tree-shakes files without decorators, making the export undefined at runtime.

```typescript
@NgModule({ imports: [RouterModule.forChild(routes)] })
export class ChatbotRemoteEntryModule {
  constructor(translate: TranslateService, store: TranslateStore) {
    registerRemoteTranslations(translate, store);
  }
}
```

Each remote ships `src/i18n/register-remote-translations.ts` — shallow top-level merge so remotes do not clobber each other's subtrees (e.g. shared `LANDING.*` keys). Also call from shelled `AuthenticatedLayoutComponent` when the user navigates back to that remote.

### Shell loading

```typescript
loadChildren: () =>
  loadRemoteModule({ type: 'manifest', remoteName: 'chatbot', exposedModule: './Module' })
    .then(m => m.ChatbotRemoteEntryModule)
```

### Manifest — driven by `environment.remotes`

There is **no static `federation.manifest.json`**. Each `environment.*.ts` file carries a `remotes` map:

```typescript
remotes: {
  chatbot: "http://localhost:4001/remoteEntry.js",
  "event-store": "http://localhost:4002/remoteEntry.js",
}
```

`main.ts` passes this map directly to `setManifest()` before bootstrapping:

```typescript
import { setManifest } from "@angular-architects/module-federation";
import { environment } from "./environments/environment";

setManifest(environment.remotes)
  .then(() => import("./bootstrap"))
  .catch(err => console.error("Failed to bootstrap application", err));
```

Add a new key to every `environment.*.ts` `remotes` object when onboarding a new remote.

### Remote `publicPath` — env var at build time

Each remote's `webpack.config.js` reads `publicPath` from an env var with a localhost fallback:

```js
const publicPath = process.env["MF_<REMOTE>_PUBLIC_PATH"] ?? "http://localhost:<port>/";
```

Set the env var in CI before building for non-dev environments:
```sh
MF_CHATBOT_PUBLIC_PATH=https://chatbot.example.com/ pnpm build
```

### Remote dev-server config

Each remote's `angular.json` must have `"liveReload": false` under `serve.options`. Without this, the remote's webpack-dev-server client is bundled into `remoteEntry.js` and triggers `window.location.reload()` in the shell's tab on every rebuild.

## Version pinning

All Angular packages in every app must be pinned to the **same exact version** (no `^` or `~`). A mismatch causes Module Federation to load two `@angular/core` instances, which breaks the shared DI tree and produces NG0919.

```json
"@angular/core": "21.2.12"   // exact, no range prefix
```

## Tailwind CSS — multi-app setup

The shell **owns the shared CSS bundle**. Its `tailwind.config.js` must scan every remote's source files so all utility classes used by any remote are generated:

```js
content: [
  './src/**/*.{html,ts}',
  '../chatbot-frontend/src/**/*.{html,ts}',
  '../event-store-frontend/src/**/*.{html,ts}',
]
```

Remotes' own `global.css` / `styles.js` are **not** loaded in hosted mode (only `remoteEntry.js` is fetched). All needed Tailwind utilities must be present in the shell's CSS bundle.

## Dual-mode remote pattern

Angular remotes operate in two modes detected via Angular router `data`:

| Context | How to detect | Behaviour |
|---|---|---|
| **Hosted** (inside shell) | `route.snapshot.data['shelled'] === true` | Slim sub-header (tabs + email support only), `h-full flex-1` layout, no own lang/profile/logout |
| **Standalone** | `data['shelled']` absent / false | Full `h-[100dvh]` layout with complete toolbar |

The remote's `AuthenticatedLayoutComponent` reads `isShelled` from route data and adapts accordingly. Route links also switch between absolute paths (`/chatbot`, `/chatbot/chat`) in hosted mode and (`/`, `/chat`) in standalone mode.

## Shell context — future cross-app state contract

`SHELL_CONTEXT` is the lib's `DATHA_SHELL_CONTEXT` token, re-exported from `shell-frontend/src/constants/injection-token.constant.ts` (the contract itself lives in `@datha/platform-ui`: `lib/context/datha-shell-context.ts`). `ShellContextService` implements it and **the shell provides it at root** (`app.module.ts`, `useExisting: ShellContextService`) — `authToken$`, `lang$`, `theme$`, `ownerProfile$`, `logout()`, `setLang()`, `setTheme()` are live today, refreshed on `token_received` / `token_refreshed` and on lang change.

What is still **pending is the consuming half**: no remote injects the token yet, because none has needed it. The contract for when one does:

- Shell provides it at root; remotes `inject(SHELL_CONTEXT, { optional: true })`.
- If present → hosted mode: read `authToken$`, `lang$`, `theme$`, `ownerProfile$`; call `logout()` / `setLang()`.
- If absent → standalone mode: run own OAuth + translate bootstrap.
- Remotes must **never** mutate shell state directly — only via the callbacks.

**Planned addition (Messenger, phase 2)** — the header widget needs only what the token already exposes, so phase 0 shipped without touching the contract. The one missing member is needed by the call dock, and lives in `@datha/platform-ui`, so adding it is a lib release plus a version bump in every consumer — deliberately deferred to the phase that uses it:

| Member | Purpose |
|---|---|
| `registerFloatingView(view)` | attach a view **outside the router outlet** so it survives navigation — the call dock and the incoming-call ring, later docked mini chat windows. One overlay host, all floating product UI |
| existing `authToken$` / `lang$` / `ownerProfile$` | what a header widget needs before it can render anything |

Module Federation shares a single Angular instance, so a remote may create a component with its own environment injector and hand the resulting view to the shell. The shell owns *where* it renders; the remote owns *what* renders.

## Header widget slots

> **Built 2026-09-06** (shell side; first widget ships with `messenger-frontend`).

The header today is fixed chrome: language, bell, profile. **Messenger** needs a slot in it, and Messenger is a *product*, not chrome — so the shell must render remote-owned content without importing it. The notification bell is not the precedent to copy: the bell renders any service's events, which makes it chrome; a chat popover is product logic and belongs to its remote.

The remote exposes a second federated module beside its routed one:

```js
// messenger-frontend/webpack.config.js
exposes: {
  './Module':       './src/remote-entry.ts',        // routed product at /messenger
  './HeaderWidget': './src/header-widget-entry.ts', // standalone component
}
```

The shell renders it from config, in the same spirit as `environment.remotes` and `environment.apps`:

```typescript
// environment.ts — HeaderWidgetDescriptor (src/models/header-widget-descriptor.model.ts)
headerWidgets: [{ remoteName: 'messenger', exposedModule: './HeaderWidget', order: 20 }]
```

`HeaderWidgetHostComponent` (`src/modules/shared/header-widget-host/`) sorts the descriptors by `order`, loads each via `loadRemoteModule({ type: "manifest", … })` and renders it with `ngComponentOutlet`. Header order is `[theme] [lang] [widgets by order] [bell] [profile]`.

The load call sits behind the `HEADER_WIDGET_MODULE_LOADER` token — one indirection whose only purpose is that the degradation path is unit-testable without a live remote, which is the behaviour most worth pinning.

**The widget must be the module's `default` export.** That keeps onboarding config-only: the shell holds no product class name and a widget rename never touches the host.

Rules:

1. **Expose a standalone component, not a `Routes` array** — the same tree-shaking caveat as `remote-entry.ts`: the class needs a decorator to survive compilation. A standalone component has one.
2. **The shell degrades silently.** A failed `loadRemoteModule` (remote down, 404 on `remoteEntry.js`) logs and renders nothing in that slot. A stopped remote must never break the header — that behaviour belongs in the shell's own tests.
3. **Config only, no shell code per product.** Onboarding a widget is one `environment` entry, exactly like onboarding a remote.
4. **The widget owns its own i18n** via `registerRemoteTranslations`, under its own top-level namespace (`MESSENGER.*`). The shell keeps `NAV.*`; remotes keep `SUBNAV.*`. A widget registers translations under three constraints a *routed* remote does not have, because it lives inside shell pages rather than replacing them — all three cost real bugs on 2026-09-06:
   - **Only the active language.** Writing a catalog for a language the shell has not fetched yet marks it loaded in ngx-translate, which then skips the shell's own lazy fetch: the shell silently loses every key it had not already registered (the home page came up blank in German).
   - **Only its own subtree.** Passing the remote's whole bundle replaces shared subtrees (`PROFILE`, `THEME`, `DIALOG`, HTTP error keys) with the remote's copies, rewriting chrome the shell owns.
   - **Guard re-entrancy.** `registerRemoteTranslations` ends with `translate.use(currentLang)`, which re-emits `onLangChange`; a widget that re-registers on that event recurses until the stack overflows. Track registered languages in a `Set` and mark *before* the call.

   The failure mode worth remembering: after the recursion fix the UI looked correct while the console was full of `RangeError`, so the shell's e2e now asserts on console errors during a language switch, not just on rendered text.
5. **The slot is for ambient behaviour, not for hiding the product.** A product that must be live on every page (socket, badge, ringing) needs a header slot — that part is not a preference. Whether it *also* appears in `environment.apps` is a separate question, answered by whether it has a destination worth navigating to. Messenger does (its Overview page documents the stack), so it carries both: widget **and** tile. Chosen by dathq 2026-09-06, reversing the original "not an app tile" rule, which had conflated the two decisions.

Loading a widget at login also keeps that remote alive for the session, which is what lets its root-provided services hold a socket or a call across navigation. That is a deliberate property, not a side effect.

**Badge coverage lives in this repo's e2e suite**, not the remote's: the widget only renders inside the shell, so `e2e/specs/header-widget.spec.ts` mocks the token mint, the unread resync and the socket itself (`page.routeWebSocket`) and asserts the frame → badge contract. The socket's own behaviour is covered where it lives, by `realtime-service`'s Go tests.

**`HttpContextToken` does not cross the federation boundary** (found 2026-09-08). `HttpClient` is a shared singleton, so the interceptor that runs for a *remote's* request is the **shell's** — but a remote bundles its own copy of `http-context.tokens.ts`, so the token it sets is a different object identity from the one the shell reads. A remote's `SKIP_GLOBAL_ERROR_DIALOG` was therefore ignored, and a background chat poll raised the session dialog over the whole app. The fix is a value, not an identity: the header **`X-Datha-Quiet-Errors`** (`SKIP_ERROR_DIALOG_HEADER`), which both interceptors honour and strip before the request leaves the browser. **All three remotes now set it** — `messenger-frontend` (chat + socket polling), `chatbot-frontend` (file preview / download URL) and `event-store-frontend` (DLQ replay) — because all three had quiet requests that were silently raising the modal while hosted. Anything shared as an *identity* across the boundary has the same problem, so prefer values, or a singleton exported from `@datha/platform-ui`.

## i18n in hosted mode

`AppModule.i18nInitFactory` (which registers default translations) never runs in hosted mode. Every remote `NgModule` constructor must register its catalog via **`registerRemoteTranslations(translate, store)`** (see each remote's `src/i18n/register-remote-translations.ts`). Do **not** call raw `setTranslation(..., merge: true)` — deep merge leaves stale keys when switching between remotes with overlapping top-level sections (e.g. `LANDING`).

## Logout is local only (2026-09-09, merged)

`AuthenticationService.logout()` calls **`oauthService.logOut(true)`**. The `true` skips the redirect to the IdP's `end_session_endpoint`, so logout clears our tokens and leaves the provider's own session alone.

Shipped as PRs **!163** (shell), **!164** (chatbot), **!165** (event-store), **!166** (messenger), all merged 2026-09-09.

**This applies to all four frontends, not just the shell.** Each remote carries its own `AuthenticationService` and runs standalone in dev (4001/4002/4003), so each owns its own logout — and all three had the same bare `logOut()`. Found by the 2026-09-09 audit *after* the shell was already fixed, which is the argument for grepping every frontend rather than assuming the host owns auth alone.

**Why it matters, and why it was a real bug.** Without the flag, `angular-oauth2-oidc` redirects to that endpoint when one is known — and it learns it from the discovery document. Verified live 2026-09-09:

| Provider | `end_session_endpoint` | Old behaviour |
|---|---|---|
| Google (`accounts.google.com`) | **absent** | local only — `logOut()` hits `if (!this.logoutUrl) return;` |
| Entra (`organizations/v2.0`) | `.../oauth2/v2.0/logout` | **redirect → ends the whole Microsoft session** |

So the *same button* signed an Entra user out of Outlook, Teams and every Microsoft-backed site, while a Google user got a clean local logout. That asymmetry was invisible because the Google path is the one usually exercised.

**Trade-off accepted:** with the IdP session left alive, the next "sign in" can complete **silently** — no password prompt. That is correct for a personal platform and wrong for a shared device. If a "sign out everywhere" affordance is ever wanted, it belongs as a *separate* explicit action, not as the default logout.

Guarded by `authentication.service.spec.ts` in **each of the four repos**, every assertion **proven to fail against the old code** (`Expected undefined to be true`).

One trap worth knowing: `expect(spy).toHaveBeenCalledWith(true)` does **not** compile against this library — `logOut(customParameters = {}, state = '')` declares two parameters, so jasmine's typed matcher demands both and fails with `TS2554: Expected 2 arguments, but got 1`. That is a *compile* error, which means a revert-and-watch-it-fail check would "fail" for the wrong reason and prove nothing. Assert on `spy.calls.mostRecent().args[0]` instead. `api-gateway` has no logout or revoke route at all — logout is entirely client-side.

**Verified live on both providers, 2026-09-09**, headed Chrome with a real session and a same-provider canary tab:

| Provider (pool) | Logout landed on | IdP requests | Canary after logout |
|---|---|---|---|
| Google | `localhost:4000/login` | none | Spotify still signed in; `myaccount.google.com` still signed in |
| Entra (`consumers`, MSA tenant `9188040d-…`) | `localhost:4000/login` | discovery + JWKS only | `account.microsoft.com` still signed in |

Note the `consumers` pool **does** publish `.../consumers/oauth2/v2.0/logout`, so this is the case the flag actually protects. Proving the *old* behaviour live would really end dathq's Microsoft session, so it was not done — the published endpoint, the library code path and the failing spec are the evidence.

**Watch out when testing this:** dathq's personal Microsoft account uses the address `dathaynha@gmail.com`, so "logged in as dathaynha@gmail.com" does **not** identify the provider. Read `localStorage.authProvider` (or the profile popover's "Sign-in method") before concluding anything about which path ran.

### Google login forces consent on every sign-in

`loginWithProvider` sends `access_type: "offline"` + **`prompt: "consent"`** for Google on every login (`authentication.service.ts`). Consequences worth knowing before changing it:

- The Google consent screen appears **every** time — it is not a bug or a stale grant.
- Every consent **mints a new refresh token**. Google caps refresh tokens at roughly **100 per (OAuth client, user)** and silently revokes the oldest past that, so heavy development churns through grants.
- Combined with an automated browser (Playwright), repeated grant creation is exactly the pattern Google's risk engine reads as suspicious, which is the most likely explanation for dathq being signed out of Google **in another browser** during long dev sessions (2026-09-09). Our logout was ruled out by direct measurement — it never contacts Google.

**Decision 2026-09-09: leave `prompt: "consent"` as it is.** There is no free version of removing it.

- The obvious refinement — send `prompt` only when no refresh token is held — is a **no-op**: logout clears `refresh_token` and login only runs while unauthenticated, so the condition is always true at the point it is evaluated.
- The only real change is dropping the flag, and Google returns a refresh token **only when consent is granted**. Without it a re-login gets none, silent refresh breaks, and the session ends at access-token expiry (~1h) instead of renewing. The service actively calls `refreshToken()`, so that is a functional regression, not a cleanup.
- And the thing it would supposedly fix — Google signing dathq out of other sites during long dev sessions — is **unproven**. Trading session longevity against an unproven cause is a bad deal.

So the consent screen on every Google login is the accepted price of offline access. Revisit only if `myaccount.google.com` → Security → Recent security activity shows session revocations that line up with dev sessions.

## Design rules

1. **Shell owns the URL.** Remotes never define routes that conflict with the shell's top-level segments.
2. **No postMessage for Angular remotes.** Replaced by DI + shared observables via `SHELL_CONTEXT`. The pre-federation bridge (`MicroFrontendsService`: `startSendingUrlToParent`, a `message` listener receiving tokens, theme, lang and url from a parent frame) was **deleted from every remote on 2026-09-06** — the shell had no sender left, and a federated remote shares the host's document rather than sitting in an iframe, so its `isIframe` guard was permanently false. What survived is the one genuinely live path: a small `ThemeService` per remote, the standalone-mode bus from the toolbar's theme select to the app root's `.dark` class. Hosted, the shell stamps the document itself and that service never runs.
3. **Remotes are standalone apps.** Each remote must boot, authenticate, and function without the shell. `SHELL_CONTEXT` + shelled data are enhancements, not requirements.
4. **Exact Angular version across all apps.** No range prefixes; any drift causes NG0919.
5. **Shell header actions are global.** Logout, lang, profile are in the shell header; remote sub-headers show only tab navigation and email support.
6. **`sharedMappings: []` in every webpack config.** Prevents tsconfig path alias leakage into the MF shared scope.
7. **Shell's Tailwind scans all remotes.** Add each new remote's `src/**` to `shell-frontend/tailwind.config.js` content array.

## Future (platform — not built)

| Item | Intent |
|------|--------|
| **Gateway admin role** | Restrict `/api/event-store/*` (and future analytics ops) to ops/admin JWT claims before prod — today any authenticated JWT. **`services/api-gateway-architecture.md`**. |
| **Messenger** | Phase 0 built: header widget slot, `/messenger` route, `messenger-frontend` skeleton (:4003). Still to come: conversations and presence (phase 1), then the call dock in the overlay host via `registerFloatingView` (phase 2). Plan: **`products/messenger-architecture.md`**. |

**Built:** **`event-store-frontend`** at `/event-store` — Overview, Events list/detail, DLQ list/detail/replay → gateway `/api/event-store/*`. Spec: **`platform/event-store-architecture.md`**; **`services/event-store-frontend-architecture.md`**.

## Phone chrome (2026-09-21, !226)

- **Toast width is fluid, not a breakpoint.** PrimeNG sizes `.p-toast` at a
  flat 25rem and `position="top-right"` offsets it 20px, so at 375px its left
  edge sat at **-45px** with the title clipped off the display — and document
  overflow stayed **0**, so the check that looks like a responsiveness check
  read clean. `width: min(25rem, calc(100vw - 2.5rem))` cannot be wrong at
  some width the way a threshold can. `::ng-deep` is required: PrimeNG builds
  that element and it carries no `_ngcontent`.
- **Drawer rules live in `src/styles/base.scss`**, not the bell component,
  because the drawer is `appendTo="body"` and a component rule cannot reach
  it. "Mark all read" keeps its words and drops its icon below 30rem — the
  words are the affordance, the icon is decoration beside an icon-only gear.
- **Page gutters below 30rem are `1.5rem 1rem`**, down from `3rem 2rem`. This
  is global to `.shell-page-shell` and therefore applies to **every** shell
  page; 2rem a side plus a card's own 1.5rem was spending 112px of a 375px
  screen on padding. Deliberate and flagged, not incidental.
- **A control with a popup inside a `datha-glass-sheen` card needs room.** The
  notification settings severity row stacks below 30rem: the card sets
  `overflow: hidden` for its sheen, so a fixed 11rem select did not merely
  crowd the label, it was **clipped**. A toggle is small enough to stay on its
  row; a select is not.

### Hosted container-scale guards

`e2e/specs/hosted-container-scale.spec.ts` asserts the **tier** each remote
picks for the room it actually has. These cannot live in the remotes' own
suites: standalone, a remote's viewport and its content are the same width, so
every viewport-keyed breakpoint is accidentally correct. They assert on
selectors the remotes own (`.landing-body`, `.chats-root`, `.chat-header`), so
renaming one there breaks a spec here — and they **self-skip when the remote
is not served**, which is always the case in CI, so they gate nothing there.
