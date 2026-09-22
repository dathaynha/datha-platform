# Platform frontend — barebone conventions

_Shared barebone conventions for all platform Angular frontends (structure, routing, naming) — not app-specific product logic_

Neutral baseline for **every deployable Angular app** in the workspace. Product behavior, MF wiring, and ports live in per-app rules — not here.

| Topic | Canonical rule |
|-------|----------------|
| Component / signal / template patterns | **`lang/lang-angular.md`** |
| Shell host, MF manifest, dual-mode | **`services/shell-frontend-architecture.md`** |
| Publishable UI library | **`services/shared-frontend-architecture.md`** |
| App-specific routes & product | **`services/<app>-frontend-architecture.md`** |

## Stack (shared)

- **Angular 21** — `AppModule` bootstrap; **standalone** route components; **signals** for local state.
- **pnpm**; **PrimeNG 21 + Aura** (`src/theme/*-aura-preset.ts`); **Tailwind v3** (not v4 with webpack MF).
- **`ngx-translate`** — `src/assets/i18n/en.json`, `de.json`; `modules/i18n-root.module.ts`.
- **OAuth** — `angular-oauth2-oidc` via **api-gateway** token proxy (never commit secrets).
- **MF remotes** — `@angular-builders/custom-webpack:browser`; expose **`./Module`** as an `@NgModule` in `remote-entry.ts` (not a bare `Routes` export).

## `src/` layout (shared skeleton)

```
src/
  modules/           # app shell + features + shared UI
  services/          # implementations/*.service.ts (+ interfaces/ when used)
  guards/
  models/
  constants/
  factories/
  interceptors/
  environments/
  theme/
  styles/
  assets/i18n/
  global.css         # Tailwind entry
  bootstrap.ts
  main.ts
```

Use **tsconfig path aliases** (`@modules/*`, `@services/*`, `@guards/*`, `@models/*`, `@constants/*`) — never register aliases as MF shared modules (`sharedMappings: []`).

## App shell (`modules/`)

| Path | Role |
|------|------|
| `app.module.ts`, `app-routing.module.ts`, `app.component.*` | Root bootstrap |
| `i18n-root.module.ts`, `oauth-root.module.ts` | Cross-cutting module wrappers |
| `shared/authenticated-layout/`, `shared/unauthenticated-layout/` | Auth chrome |
| `shared/dialog/` | Reusable dialogs (message, confirmation, help) |
| `login-page/`, `home-page/` | Top-level pages (flat under `modules/` until a feature grows) |

## Feature folders & routing

Group **related routes** under one **feature directory** — not as sibling top-level folders at `modules/` root.

```text
modules/<feature>/
  <feature>.routes.ts       # export FEATURE_ROUTES: Routes
  <feature>-page/           # route path ''
  <feature>-detail-page/    # route path ':id' (when needed)
  …                         # optional: other route targets as sibling folders
```

**App routing** lazy-loads the feature once:

```typescript
{
  path: '<feature>',
  loadChildren: () =>
    import('@modules/<feature>/<feature>.routes').then((m) => m.FEATURE_ROUTES),
}
```

**Inside `<feature>.routes.ts`:** use **`loadComponent`** + standalone components — **no feature NgModule**. Child paths `''` and `':id'` are **routing siblings**, not a parent/child component tree.

### Folder nesting semantics

| Location | Meaning |
|----------|---------|
| Sibling folders under `modules/<feature>/` | Separate **route targets** (list, detail, …) |
| Folder **inside** `<feature>-page/` | **Embedded child component** used only by that page (filters, row actions, …) |
| `modules/shared/` | Cross-feature reusable UI |

Do **not** nest a detail **route** inside a list page folder — that implies a child component, not a router sibling.

Alternative acceptable layout: `pages/list/` + `pages/detail/` under the feature when you prefer route-oriented names; keep the same sibling-route rule.

## Page naming

- File: `*-page.component.ts` / `*-detail-page.component.ts`
- Class: `*PageComponent` / `*DetailPageComponent`
- Selector: `app-*-page` / `app-*-detail-page`
- Route `data.title` for shell / browser title where used

## Auth routing pattern (apps with login)

```text
/login  → UnauthenticatedLayoutComponent → LoginPageComponent (LoginPageGuard)
/       → AuthenticatedLayoutComponent (AuthGuard) → lazy feature/page routes
**      → redirectTo /
```

`RouterModule.forRoot(..., { onSameUrlNavigation: 'reload' })` in standalone apps. Remotes: `RouterModule.forChild` in `remote-entry.ts`; shell owns top-level `/login` and remote prefix.

## Services & API

- HTTP services in **`services/implementations/`**, `providedIn: 'root'` unless scoped.
- Browser calls go through **api-gateway** URLs from `environment.*.ts` — not direct backend ports in prod.
- **`ChangeDetectionStrategy.OnPush`**, **`takeUntilDestroyed()`**, strict TS on new code.

## i18n

- Keys in **`assets/i18n/`**; page sections grouped (`FEATURE_PAGE.*`).
- Standalone: preload default lang in `APP_INITIALIZER`.
- MF remote hosted mode: **`registerRemoteTranslations(translate, store)`** in **`remote-entry.ts`** (and shelled **`AuthenticatedLayoutComponent`** on re-entry). Copy pattern from **`chatbot-frontend/src/i18n/register-remote-translations.ts`** — shallow top-level merge, not raw `setTranslation(..., merge: true)`.

## Agents

- New multi-route feature → **feature folder + `*.routes.ts`**; wire once in app routing.
- Reusable across apps → plan for **`shared-frontend/`** (library), not copy-paste across repos.
- Do not duplicate MF host/remote checklists here — read the **shell** and **target app** architecture rules.
