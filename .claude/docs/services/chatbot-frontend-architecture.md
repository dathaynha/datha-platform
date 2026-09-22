# `chatbot-frontend` architecture and product rules

_Architecture, product behavior, and workflows for chatbot-frontend_

Generic Angular best practices are in **`lang/lang-angular.md`**. This rule records chatbot-specific frontend architecture, product behavior, routes, and hosted/standalone workflows.

## Stack & port

- **Angular 21** — NgModule bootstrap (`AppModule`), standalone components inside, signals for local state.
- **`@angular-builders/custom-webpack:browser`** — webpack builder (NOT esbuild). Required for Module Federation.
- **`@angular-architects/module-federation` v21.2.2** — exact version, matching the shell.
- **PrimeNG 21 + Aura theme** — `chatbotAuraPreset` in `src/theme/prime-aura-preset.ts`.
- **Tailwind CSS v3** — v4 is incompatible with webpack; stay on v3.
- **`ngx-translate`** — i18n with JSON catalogs in `src/assets/i18n/`.
- **`angular-oauth2-oidc`** — Google + Microsoft Entra (PKCE) auth.
- **pnpm** — package manager.
- Dev port: **4001**

## CI — bot review

Canonical Angular bot-review template for the platform (`azure-pipelines/bot-review.yml`, `.mega-linter.yml`, `.pr_agent.toml`, Karma + PR comment upsert). **`shell-frontend`** copies this pattern with service-specific markers only. See **`ci/bot-review-pipelines.md`** and repo **`README.md`** (CI section).

## Path aliases

Use `@modules/*`, `@services/*`, `@guards/*`, `@models/*`, `@pipes`, `@directives` etc. as defined in `tsconfig.json`.

**Do NOT share these aliases as MF modules.** They are TypeScript-only aliases; adding them to the MF shared scope causes module-ID collisions. `webpack.config.js` uses `sharedMappings: []` + a `shareAll` filter to prevent this.

## Module Federation — remote setup

`chatbot-frontend` is a **remote** (loaded by `shell-frontend` at runtime).

### Exposed module: NgModule, not Routes array

```typescript
// src/remote-entry.ts
@NgModule({ imports: [RouterModule.forChild(routes)] })
export class ChatbotRemoteEntryModule {
  constructor(translate: TranslateService, store: TranslateStore) {
    registerRemoteTranslations(translate, store);
  }
}
```

**Why NgModule?** The Angular compiler (`@ngtools/webpack`) tree-shakes files that have no Angular decorators and are not reachable from `main.ts`. A plain `export const routes: Routes` has no decorator → it is stripped, and `m.routes` is `undefined` at runtime. Wrapping in `@NgModule` forces the compiler to emit the file.

### webpack.config.js

```js
exposes: { './Module': './src/remote-entry.ts' }  // always './Module', never './Routes'

sharedMappings: []   // prevents @pipes / @directives leaking into MF shared scope
```

### angular.json

```json
"serve": {
  "options": {
    "liveReload": false   // REQUIRED: prevents WDS client from reloading the shell's browser tab
  }
}
```

## Dual-mode layout

`AuthenticatedLayoutComponent` operates in two modes:

| Mode | Detection | Behaviour |
|---|---|---|
| **Standalone** | `route.data.shelled` absent / false | `h-[100dvh]` full layout, complete toolbar (tabs + lang + profile + logout) |
| **Hosted** (inside shell) | `route.data.shelled === true` | `h-full flex-1` layout, slim toolbar (tabs + Email Support only — shell owns lang/profile/logout) |

**Chrome comes from the lib (v0.5.0).** Both layouts render `datha-sub-header` — router-anchor tabs (`SUBNAV.*` label keys) plus a projected actions slot; the local `p-toolbar` markup, the `--p-button-text-primary-color` overrides and the duplicated ambient gradient are gone. Layout SCSS now only `@use "@datha/platform-ui/styles/chrome"` for the `ambient` / `content-surface` mixins. Remote i18n must stay out of the shell's namespaces (`NAV`, `BRAND`, `SETTINGS`, `PROFILE`, `APPS`) — use `SUBNAV.*`; `registerRemoteTranslations` replaces whole top-level subtrees, so a colliding namespace hides the shell's keys while this remote is mounted.


`remote-entry.ts` passes `data: { shelled: true }` to the layout route. `AuthenticatedLayoutComponent` reads `route.snapshot.data['shelled']` in `ngOnInit`, sets `isShelled` signal, and adjusts router link targets:
- Standalone: `['/']`, `['/chat']`
- Hosted: `['/chatbot']`, `['/chatbot/chat']`

## Routing (standalone mode)

```
/login          → UnauthenticatedLayoutComponent → LoginPageComponent
/ (AuthGuard)
  ├── ''         → AuthenticatedLayoutComponent → HomePageComponent
  └── /chat      → AuthenticatedLayoutComponent → ChatPageComponent
```

## Routing (hosted / remote-entry routes)

```
'' (shelled AuthenticatedLayoutComponent, data: { shelled: true })
  ├── ''    → HomePageComponent
  └── chat  → ChatPageComponent
```

No `AuthGuard` in remote routes — the shell already guards `/chatbot`.

## Gateway integration

All browser API traffic goes through **api-gateway** — never call chatbot-service or file-service ports directly in production.

| Config key | Dev example | Use |
|------------|-------------|-----|
| `environment.gateway.baseUrl` | `http://localhost:8080/api/chatbot/v1` | Chat REST (`/messages`, `/conversations`, …) |
| `environment.gateway.filesBaseUrl` | `http://localhost:8080/api/files` | File prepare / confirm / list / download-url (proxied to file-service) |
| `googleOidc.tokenProxyUrl` / `entraOidc.tokenProxyUrl` | `http://localhost:8080/auth/.../token` | OAuth code exchange — gateway injects client secrets |
| `*.redirectUri` | `http://localhost:4001` | SPA origin for PKCE |

**SSE:** every gateway response that names a `job_id` includes `stream_token` — `POST /messages`, `GET /conversations/{id}/active-job` (re-attach) and `POST /conversations/{id}/retry-last` ("Try again"). Open the stream with `GET {baseUrl}/stream/{job_id}?stream_token=...` — see `message-stream.service.ts` and `MessageJobResponse.stream_token`. All three go through the same `streamJobIntoNewBubble` path in `chat-page.component.ts`. Frame types and the `retrying` pending stage: **`products/chatbot-architecture.md`** § Generation retry — `MessageStreamService` completes only on `done`/`error`.

**Auth interceptor:** attach Bearer JWT to gateway chat/file URLs only; exclude IdP and token-proxy URLs via `oauth.ignoreUrls`.

## i18n

- Default language `en` is pre-loaded synchronously via `APP_INITIALIZER` in `AppModule` (standalone mode).
- **Hosted:** `registerRemoteTranslations()` in `ChatbotRemoteEntryModule` (and `AuthenticatedLayoutComponent` when shelled) merges `en` / `de` into the shared `TranslateService` without clobbering other remotes' subtrees. See `src/i18n/register-remote-translations.ts`.
- JSON catalogs: `src/assets/i18n/en.json`, `src/assets/i18n/de.json`.

## Home page layout (aurora background)

`HomePageComponent` uses a layered structure to allow scrolling without the aurora gradient bleeding into the shell:

```
<app-home-page host="h-full overflow-hidden ...">      ← clips everything
  <section class="h-full overflow-hidden ...">         ← clips aurora
    <div class="landing-aurora" />                     ← position:absolute, inset:-40% -20%
    <div class="landing-noise" />
    <div class="z-10 flex-1 overflow-y-auto ...">      ← scroll container above aurora
      <!-- page content -->
    </div>
  </section>
</app-home-page>
```

The host element is `overflow-hidden` (not `overflow-y-auto`) — scrolling is handled by the inner `flex-1 overflow-y-auto` div. This prevents the absolutely-positioned aurora from bleeding outside the component's bounds.

## Quality

- Strict TS; no `any` in public APIs.
- `ChangeDetectionStrategy.OnPush` on new components.
- `takeUntilDestroyed()` for subscription cleanup.

## The open conversation is a query param (2026-09-21, !224)

`/chat?c=<id>`. A reload, a bookmark and the back button all land on the
thread you were reading; before this, picking a chat and refreshing dropped
you on a blank new chat.

**Why not `/chat/:id`, which is what ChatGPT and Claude put in the URL.**
Angular's default `RouteReuseStrategy` reuses a component only when
`future.routeConfig === curr.routeConfig`, so sibling `chat` and `chat/:id`
routes destroy and recreate this page on **every** conversation switch. This
component owns the SSE stream, the chunk batcher, the conversation list and
the attachment set directly — unlike `messenger-frontend`, whose state lives
in `ChatStore` and which therefore affords the path segment. The nicer URL is
available the day that state is hoisted into a service; it is not free today.

Two consequences worth keeping:

- The component survives the parameter change, so `queryParamMap` is
  **subscribed** rather than read from the snapshot. That is the opposite of
  messenger's choice and for the opposite reason: there, `""` and `":id"` are
  sibling routes and the outgoing instance would emit an id-less map over the
  incoming one's work.
- Every write of `conversationId` goes through one `syncConversationParam`,
  **including the send that creates a conversation** — otherwise a first
  message is lost on reload, which is the same bug one step later.

Red-proofed in both directions separately: neutralising the write path fails
the reload test while the deep-link test stays green, and neutralising the
read path fails all three. Specs: `e2e/specs/chat-deep-link.spec.ts`.

## Follow-bottom releases on the first scroll up (2026-09-21, !224)

The thread pin is a single `ResizeObserver` on the scroll content. It used to
be that **plus** an `IntersectionObserver` on a bottom sentinel, which
re-asserted the pin whenever the sentinel left the viewport by 48px — and a
sentinel leaving the viewport is exactly what a user scrolling up looks like.
With the release threshold at 120px, every drag landing in between was pulled
back (`wheel -60: gap 100 -> 0`). Growth is a resize and the `ResizeObserver`
already covered it, so the second mechanism was deleted rather than retuned;
the release gap dropped to 24px because a nudge is now enough.

`THREAD_PIN_BOTTOM_RELEASE_GAP_PX` and `THREAD_JUMP_TO_BOTTOM_GAP_PX` answer
different questions and must not be collapsed: one releases the pin, the
other decides when the jump-to-latest button appears.
Spec: `e2e/specs/chat-scroll-pin.spec.ts`.
