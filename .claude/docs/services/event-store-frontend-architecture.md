# `event-store-frontend` architecture and product rules

_Architecture, product behavior, and workflows for event-store-frontend_

Generic Angular best practices are in **`lang/lang-angular.md`**. This rule records event-store ops UI frontend architecture, auth, routes, and hosted/standalone workflows.

## Role

- **Platform ops UI** for **event-store** — DLQ list/filter/replay and Events list/detail via gateway `/api/event-store/*`.
- **Module Federation remote** loaded by **shell-frontend** at `/event-store` (shell owns manifest + sidebar; no ops logic in shell).
- **Not** analytics — see **`platform/analytics-service-architecture.md`** (future, separate product).

Backend contract: **`platform/event-store-architecture.md`**. Gateway proxy: **`services/api-gateway-architecture.md`** (`/api/event-store/*`; **admin role** required before shipping ops features to prod).

## Stack & port

- **Angular 21** — NgModule bootstrap (`AppModule`), standalone components inside, signals for local state.
- **`@angular-builders/custom-webpack:browser`** — webpack builder (NOT esbuild). Required for Module Federation.
- **`@angular-architects/module-federation` v21.2.2** — exact version, matching shell and chatbot remote.
- **PrimeNG 21 + Aura theme** — `eventStoreAuraPreset` in `src/theme/prime-aura-preset.ts`.
- **Tailwind CSS v3** — v4 incompatible with webpack; stay on v3.
- **`ngx-translate`** — i18n with JSON catalogs in `src/assets/i18n/`.
- **`angular-oauth2-oidc`** — Google + Microsoft Entra (PKCE) via api-gateway token proxy.
- **pnpm** — package manager.
- Dev port: **4002** (shell **4000**, chatbot **4001**).

## Local dev

From `event-store-frontend/`:

```bash
pnpm start   # ng serve --port 4002
```

Backend companion: **`pnpm dev`** in **`event-store/`** (tsx watch). Do not use **`pnpm start`** on the backend locally unless **`dist/`** is freshly built.

## CI — bot review

Mirror **`chatbot-frontend`** bot-review scaffolding (`azure-pipelines/bot-review.yml`, `.mega-linter.yml`, `.pr_agent.toml`, Karma JUnit + PR comment upsert). Markers use `event-store-frontend`. See **`ci/bot-review-pipelines.md`**. **ADO:** bot-review pipeline registered.

## Path aliases

Use `@modules/*`, `@services/*`, `@guards/*`, `@models/*`, `@pipes`, `@directives` as in `tsconfig.json`.

**Do NOT share path aliases as MF modules.** `webpack.config.js` uses `sharedMappings: []` + filtered `shareAll` (same pattern as chatbot-frontend).

## Module layout

Feature folders per **`services/platform-frontend-conventions.md`**:

```
src/modules/
  events/
    events.routes.ts
    pages/list/   EventsPageComponent
    pages/detail/ EventsDetailPageComponent
  dlq/
    dlq.routes.ts
    pages/list/   DlqPageComponent
    pages/detail/ DlqDetailPageComponent
  shared/
    authenticated-layout/   (toolbar: Overview | Events | DLQ)
    table-empty-state/
```

## Module Federation — remote setup

`event-store-frontend` is a **remote** (loaded by `shell-frontend` at runtime).

### Exposed module: NgModule, not Routes array

```typescript
// src/remote-entry.ts
@NgModule({ imports: [RouterModule.forChild(routes)] })
export class EventStoreRemoteEntryModule {
  constructor(translate: TranslateService, store: TranslateStore) {
    registerRemoteTranslations(translate, store);
  }
}
```

**Why NgModule?** Plain `export const routes` without a decorator is tree-shaken by `@ngtools/webpack` → `m.routes` undefined at runtime. Same rationale as chatbot-frontend.

### webpack.config.js

```js
name: 'event-store'
exposes: { './Module': './src/remote-entry.ts' }
publicPath: process.env.MF_EVENT_STORE_PUBLIC_PATH ?? 'http://localhost:4002/'
sharedMappings: []
```

### angular.json

```json
"serve": { "options": { "liveReload": false } }
```

Required so WDS does not reload the shell tab when the remote rebuilds.

## Dual-mode layout

`AuthenticatedLayoutComponent` operates in two modes (same pattern as chatbot):

| Mode | Detection | Behaviour |
|---|---|---|
| **Standalone** | `route.data.shelled` absent / false | Full viewport layout; toolbar with app title, lang, profile, logout |
| **Hosted** (inside shell) | `route.data.shelled === true` | `h-full flex-1`; slim toolbar (app title + Email Support only — shell owns lang/profile/logout) |

**Chrome comes from the lib (v0.5.0).** Both layouts render `datha-sub-header` — router-anchor tabs (`SUBNAV.*` label keys) plus a projected actions slot; the local `p-toolbar` markup, the `--p-button-text-primary-color` overrides and the duplicated ambient gradient are gone. Layout SCSS now only `@use "@datha/platform-ui/styles/chrome"` for the `ambient` / `content-surface` mixins. Remote i18n must stay out of the shell's namespaces (`NAV`, `BRAND`, `SETTINGS`, `PROFILE`, `APPS`) — use `SUBNAV.*`; `registerRemoteTranslations` replaces whole top-level subtrees, so a colliding namespace hides the shell's keys while this remote is mounted.


`remote-entry.ts` passes `data: { shelled: true }`. No `AuthGuard` on remote routes — shell guards `/event-store`.

## Routing (standalone mode)

```
/login          → UnauthenticatedLayoutComponent → LoginPageComponent
/ (AuthGuard)
  ├── ''         → AuthenticatedLayoutComponent → HomePageComponent (Overview)
  ├── events     → EVENTS_ROUTES (list '', detail ':id')
  └── dlq        → DLQ_ROUTES (list '', detail ':id' + replay)
```

## Routing (hosted / remote-entry routes)

```
'' (shelled AuthenticatedLayoutComponent, data: { shelled: true })
  ├── ''      → HomePageComponent
  ├── events  → EVENTS_ROUTES
  └── dlq     → DLQ_ROUTES
```

Toolbar tabs: **Overview**, **Events**, **DLQ**. `AuthenticatedLayoutComponent` adjusts router links for hosted mode (`/event-store`, `/event-store/events`, `/event-store/dlq`). `routerLinkActive` keeps Events/DLQ highlighted on detail routes.

Row click navigates to **full-page detail routes** (`/events/:id`, `/dlq/:id`), not drawer. Shared detail styles: `src/styles/_ops-detail.scss`.

## Environment

- `gateway.baseUrl` → gateway prefix for event-store, e.g. `http://localhost:8080/api/event-store`.
- OAuth `redirectUri` → standalone origin, e.g. `http://localhost:4002`.
- Do **not** add file-service URLs unless a feature needs them.

## i18n

- **Standalone:** default `en` pre-loaded via `APP_INITIALIZER` in `AppModule`.
- **Hosted:** `registerRemoteTranslations()` in `EventStoreRemoteEntryModule` (and `AuthenticatedLayoutComponent` when shelled) merges `en` / `de` into the shared `TranslateService` without clobbering other remotes' subtrees. See `src/i18n/register-remote-translations.ts`.

## Current features

- **Overview** — landing / intro + tech stack (`HomePageComponent`).
- **Events** — list with filters/pagination/sort; detail via `GET /events/:id`. The service filter's options come from `GET /events/services`.
- **DLQ** — list/filter by `sink`, dates, sort; detail + replay via `POST /dlq/:id/replay`. The sink filter's options come from `GET /dlq/sinks`.

## List tables (Events / DLQ)

Ops list pages use PrimeNG **`p-table`** with server-side sort synced to the query API (see **`platform/event-store-architecture.md`** **`order`** param).

- **Sort columns:** **`timestamp`** (Events) and **`failedAt`** (DLQ) only — no other column sorts without backend support.
- **URL / API:** `?order=asc|desc` — default **`desc`**; omit `order` from the router when desc (canonical URL).
- **PrimeNG:** `[customSort]="true"`, `(sortFunction)`, and explicit **`<p-sortIcon field="…" />`** inside custom header templates (`pSortableColumn` alone does not render icons).
- **MF hosted mode:** remote global CSS may not reach PrimeNG internals — import **`primeng-table-overrides`** and **`table-empty-overlay`** inside `:host ::ng-deep` on list page SCSS (`stylePreprocessorOptions.includePaths: ["src/styles"]`). Standalone mode also loads overrides via **`src/styles/base.scss`**.

## Future (not built)

- **Gateway admin role** before prod — any authenticated JWT today; restrict ops routes to admin claims at gateway.
- Advanced event analytics, alerting UI, export — out of scope for this remote.

## Shell integration

Wired in **shell-frontend**:

1. Manifest entry: `event-store` → `http://localhost:4002/remoteEntry.js` (dev)
2. Route `/event-store` → `loadRemoteModule({ remoteName: 'event-store', exposedModule: './Module' })` → `EventStoreRemoteEntryModule`
3. `environment.apps[]` entry for home grid + sidebar
4. `tailwind.config.js` scans `event-store-frontend/src/**`

See **`services/shell-frontend-architecture.md`**.

## Quality

- Strict TS; no `any` in public APIs.
- `ChangeDetectionStrategy.OnPush` on new components.
- `takeUntilDestroyed()` for subscription cleanup.

## Testing

Karma unit specs cover the two list pages. **Playwright E2E: 39 specs** (2026-09-04)
in `e2e/`, run against standalone :4002 with seeded auth and a route-mocked
gateway — no backend needed. `e2e/event-store-api-mock.ts` owns every stub and
returns a recorder, so filter/paging specs assert the **request** the page made,
not only the DOM. Runs in `bot-review.yml` after the unit tests.

Full shape, patterns and the traps found while writing it:
**`testing/e2e-testing-strategy.md`** — do not restate them here.

## Pagination — `modules/shared/ops-paginator/` (2026-09-19)

Both ops lists page through `es-ops-paginator`, not PrimeNG's `p-paginator`.
The library component was used first and replaced: **its page links are a fixed
sliding window with no ellipsis and no boundary pages**, the only knob is
`pageLinkSize`, and there is no template hook for the links — a 15-page list
offered "1 2 3 4 5" with no hint that 15 existed.

The replacement keeps the first page, the last page, the current page and its
neighbours, with a gap for each skipped run, so the control stays a fixed width
whatever the page count and the end is always one click away. Everything that
is not the links — the step buttons, the page-size select — is still PrimeNG.

Two behaviours that are decisions, not accidents:

- **Changing the page size keeps the record, not the page number.** Page 3 of
  50 is record 101; at 10 a page that is page 11. The component emits both
  `offset` and `pageSize` together, and the list takes both from the event
  rather than deriving either, because changing the size also changes which
  record is first.
- **Below `26rem` of container width the numbers are replaced by a `3 / 15`
  readout**, not clipped. Keyed on a container query, because this control sits
  inside a card inside a page that may itself be beside the shell's sidebar.
  The host takes `flex: 1 1 auto` with a `min-width`, because
  `container-type: inline-size` makes width independent of content and a
  shrink-to-fit host measures zero.

The page size is component state and is deliberately **not** in the URL:
`toEventsListQueryParams` builds the query-param state, and persisting size
would mean changing that helper and its type. Raise it if a reload losing the
size becomes annoying.

## Styles: `@use`, not `@import` (2026-09-19)

Every `@import` is gone; Dart Sass 3.0 removes them. Four were plain top-level
imports and converted directly. The other two were the interesting case: the
ops list pages import `primeng-table-overrides` and `table-empty-overlay`
**inside** `:host ::ng-deep`, and **`@use` cannot be nested** — it has to sit
before every rule in the file.

The fix is the pattern `_table-compact.scss` already used here: **make the
partial a mixin**, `@use` it at the top for the namespace, and `@include` it at
the point the old `@import` sat. Including at the call site is not cosmetic —
it keeps the emit point exactly where it was, and these rules are meant to win
on source order against `ops-table()` above them.

Verified by compiling both versions with the `sass` CLI and diffing: the
emitted CSS is **byte-identical** for all six files, so this is a pure
deprecation fix with no behaviour attached. The hosted guards in the shell's
suite were re-run on top of that, because a remote's styles disappearing
silently in the host is a failure this repo has already had twice.

**`anyComponentStyle` warning budget raised 10 kB → 16 kB** in the same pass.
The two ops list pages compile to ~11.3 kB and ~11.7 kB, and about **6.5 kB of
each is shared partials that must be inlined per component** because a Module
Federation host never loads a remote's global stylesheet. The budget was set
before that constraint existed, so it was flagging the architecture rather than
bloat. The 48 kB error budget is untouched and remains the real guard. Note the
pipeline has **no production build step**, so neither number ever gated a PR —
the point is that a warning nobody can act on teaches you to ignore warnings.

## The responsive scale keys on the container (2026-09-20)

Every page here declares a **named** container — `container-name: es-page` on
`.events-root`, `.dlq-root`, `.landing-root` and both detail roots — and the
gutters, type scale and grid counts are `@container es-page (min-width: …)`
rules in the component sheet rather than `sm:` / `lg:` / `xl:` utilities in the
template.

**Why, with numbers.** A viewport breakpoint stops telling the truth the moment
anything sits beside the element, and hosted, the shell's 224px sidebar always
does. Measured 2026-09-20, hosted, before the change:

| Window | Content | Gutter taken | Correct for the content |
|---|---|---|---|
| 1440 | 1216 | 48px | ✅ |
| 1280 | 1056 | 48px | ✅ |
| **1024** | **800** | **48px** | ❌ 32px |
| 864 | 640 | 32px | ✅ |
| **667** | **443** | **32px** | ❌ 20px |
| 390 | 390 | 20px | ✅ |

The error is exactly the sidebar, every time: the page is one whole step too
wide for its room across the band where the sidebar shows and `viewport − 224`
falls below the breakpoint the viewport just matched. 390 is right for an
instructive reason — below `sm` the shell swaps the sidebar for a bottom bar, so
viewport *is* content. That is why the 2026-09-17 phone sweep passed: it only
ever looked where the bug cannot occur.

**`xl:` and `2xl:` were worse than wrong.** No window this remote is shown in is
224px wider than the room it gets, so those two steps could only ever fire in
the wrong condition.

**The rem values are the Tailwind breakpoints unchanged** — 40rem, 64rem, 80rem,
96rem. What changed is what they measure. Proven by probing standalone at :4002,
where content and viewport are the same width: the gutters came back 80/64/64/
48/32/32/20 and the title scale identical, i.e. byte-for-byte the old behaviour.
So the migration is behaviour-preserving where the old code was already right
and corrective only where the sidebar made it wrong.

**Named, deliberately.** `.events-filters-card` and `.es-table-wrap` are
containers too, and an unnamed `@container` binds to whichever is nearest — so
a page-level rule would silently bind to a card. `container-type: inline-size`
also implies layout containment, which makes the element a containing block for
absolutely positioned descendants; every root here already had
`position: relative`, so the auroras and noise layers did not move.

**What stays `@media`.** `max-height: 30rem` in `_table-compact.scss` — a
landscape phone is short before it is narrow, and height has no container
equivalent worth reaching for — plus `prefers-reduced-motion` and
`prefers-reduced-transparency`.

### Wrapping cannot be tidied — the filter bar and pager stack (2026-09-20)

dathq, reviewing the mobile wave: the filter bar was *"very chaotic, select
services not as long as select by correlation ID and the buttons is random
also"*, and the pagination *"very chaotic also"*. One structural cause for
both: **a flex-wrap row hands every line its own width**, so nothing can be
made to line up by adjusting the parts.

Measured hosted at 375x667, card interior 296px:

| | before | after |
|---|---|---|
| Services select | x=39, **w=224** | x=39, w=296 |
| Correlation input | x=39, w=296 | x=39, w=296 |
| Action group | **x=118**, w=218 | x=39, w=296 |
| Search button | 102, stranded | **175**, fills the row |

`margin-left: auto` on the actions is what pushed that group off the card's
left edge. Below 34rem the row now stops being a row: one column, one left
edge, one width, with the primary action growing and the two secondary controls
keeping their size — 175 + 65 + 40 + gaps is exactly 296.

⚠️ **The submit button needed `:host ::ng-deep`.** `flex: 1` grew the
`p-button` wrapper and the `<button>` inside stayed 102px, because PrimeNG
builds it and it carries no `_ngcontent`. Fourth instance of that trap in one
session.

**The pager had the same fault with a decoy.** Its narrow rule already said
`justify-content: space-between; width: 100%`, which reads as "one row" and
never was: controls 208 + size select 75 + gap = **289 in a 261px host**, so it
wrapped, and the wrapped line laid out on its own terms — steps at x=57 and the
select beneath them at x=57 with 186px of empty space to the right. Below the
width those two need together it is now a deliberate column: steps spread
across the full width, which also puts real distance between "next" and "last
page" for a thumb, and the size select right-aligned because it is a setting
rather than a step.

⚠️ **The stack has its own threshold, and getting that wrong looked like a
third bug.** The column was first keyed on the same `26rem` query that hides
the numbered page links — but those two answer different questions: 26rem is
where the *links* stop fitting, **19rem** is where the steps and the size
select stop fitting *beside each other*. Hosted in landscape the pager gets
329px, comfortably enough for one row, and the column rule split it into two
anyway; the footer then centred a one-line summary against an 84px block, so
"Showing 1-50 of 722" sat **between** the steps and the select. Reported as
"pagination is a little bit off". The general point: when one breakpoint is
made to serve two rules, the second rule is wrong at some width, and it shows
up somewhere that looks unrelated.

General rule worth carrying: **when a layout looks arbitrary, check whether it
wraps before adjusting any of its parts.** A wrapped row cannot be aligned,
only replaced.

### Narrow keeps every column and freezes the first (2026-09-20)

The 2026-09-17 rule dropped the three supporting columns below 40rem, leaving
timestamp, type and the chevron. dathq rejected it on use — *"2 columns is a
little bit not information enough"* — and asked for horizontal scroll with a
sticky first column.

**The survey agrees, and the reason matters.** Three camps: freeze-and-scroll
(Sheets, Airtable, AWS, Datadog, Grafana, Stripe), drop-by-priority (Bootstrap,
DataTables' responsive extension), and stack-into-cards (Polaris and Material
both recommend this for phones). Cards suit three to five *human-readable*
fields; these columns are **identifiers you compare and copy**, and a card
layout would make each row five lines tall — three rows to a screen, which is
the wrong trade for a list whose whole job is triage. Freeze-and-scroll is what
every ops console with identifiers does, and that is the case this is.

Measured hosted at 375x667: the full set is **816px in a 290px window**, so the
travel is under three screens.

**The frozen column is addressed by a class the template writes**
(`.es-table__sticky` on the first `th` and `td`), not by `:first-child` on
PrimeNG's row. `_table-compact` is included at the component's top level, so
its rules carry `_ngcontent` and cannot reach an element the library built —
the first attempt did exactly that and the cell stayed `position: static` while
the neighbouring `.es-table__secondary` rule worked, because *that* class sits
on a template-authored cell. Third instance of this trap.

**Two properties had to be handed to the winning rule rather than fought for.**
`.es-table .p-datatable-thead > tr > th` is (0,3,2) and owns both `background`
and — via the `--scroll` rule — `z-index`. A class on the cell is (0,1,0) and
can never outrank it, so the header now reads `var(--es-head-cell-bg,
transparent)` and `var(--es-head-cell-z, 1)`, and the frozen cell sets both.
Symptoms when it was not done: the header cell was transparent and the scrolled
headings slid under it, rendering **"Timestamp" and "Service" on top of each
other**; and with z-index tied at 1, *every* `th` being `position: sticky`
already meant DOM order decided and the later sibling painted on top. Same seam
as `--es-cell-ink` and `--es-table-min-width`.

**The timestamp format changes with the width, not just its size.** `medium`
renders "Sep 21, 2026, 2:03:41 AM" and measured **157px of a 290px window** —
54% spent on a frozen column whose year is implied and whose seconds nobody
reads at a glance. Narrow swaps to `short` via two spans toggled by the
container query (a pipe format cannot be reached from CSS), which brought it to
111px; the header label plus sort icon is the floor from there. `short` is
locale-aware, so this does not hardcode a 24h clock the way a custom pattern
would, and the exact instant is one tap away on the detail page.

**The invariant that must not regress:** the sideways travel belongs to the
*table*, never the document. Off-screen inside a scroller is the feature;
off-screen inside `overflow: hidden` was the 2026-09-17 bug, and a page that
scrolls sideways would fight the vertical page scroll the portrait fix depends
on. Every spec asserts `documentElement.scrollWidth - clientWidth <= 1`.

Guards: `e2e/specs/mobile-tables.spec.ts` (rewritten — it encoded the old
decision) and `shell-frontend/e2e/specs/hosted-ops-table.spec.ts`. Red-proofed
in three independent pieces: `position: static` gives `Expected: 43, Received:
-194`; `--es-head-cell-z: 1` gives `Expected: > 1, Received: 1`; and the
column-count claim fails if the old `display: none` returns.

### Narrow and short want opposite things (2026-09-20)

The `max-height: 30rem` rule written for a landscape phone could not see a
phone in **portrait**: 375x667 is tall enough that it never fires, and still far
too small for a layout that spends the viewport on a heading, a description and
a filter card before the table gets what is left. Measured hosted:
`.es-table-wrap` **0px tall at top=616**, paginator at **top=676 in a 667px
viewport**, behind `overflow: hidden` — present, correct and unreachable, the
same shape as the landscape bug reached by the other axis. Reported by dathq
with a screenshot. It **predates the container migration**: the pre-change tree
measured 0px at top=624, i.e. marginally worse.

The fix is a container rule on width, which the migration had just made
possible — `@container es-page (max-width: 40rem)` sets `.ops-page-body` to
`overflow-y: auto`. Three things about it are worth keeping:

- **It is keyed on the *page* container, not the table's.** `.ops-page-body` is
  `.es-table-wrap`'s ancestor, and a descendant container cannot size the box
  that contains it.
- **The two conditions want opposite declarations**, which is the mistake made
  first. A short viewport has no vertical room, so the table is capped at 12rem
  and scrolls inside. A narrow one has all the room it needs once the page
  scrolls, so the table takes its natural height and there is exactly **one**
  scroller — a capped table inside a scrolling page is two, which on a touch
  screen is the worse arrangement. Merging them into a shared mixin looked like
  DRY and was wrong. Measured after: body `scrollHeight` 3686 against
  `clientHeight` 490, table container 3066 = 3066.
- **The narrow rule is guarded on `@media (min-height: 30rem)`.** A landscape
  phone is narrow *and* short, matches both, and the container rule sits later
  in the file at equal specificity — so unguarded it silently undid the cap.
  Caught by the landscape guard at `Expected: > 100, Received: 76.39`.

The results card needed the same treatment: it is `flex-1`, so it divided the
body's height instead of taking its content's, and the table and paginator
rendered outside its own background. `.ops-results-card.ops-results-card` —
doubled for (0,2,0) — beats Tailwind's `.flex-1` at (0,1,0) **wherever the two
sheets land relative to each other**, which matters because hosted the
utilities come from the shell's bundle and the component styles from the
remote's JavaScript, so source order is not something the remote can rely on.

Guard: `shell-frontend/e2e/specs/hosted-ops-table.spec.ts` § *phone in
portrait*. Red-proofed by making the container query unmatchable:
`Expected: > 400, Received: 0`.

⚠️ **Sass forbids a mixin declaration inside a mixin** (`Mixins may not contain
mixin declarations`), found while trying to share those declarations. A helper
mixin has to live at file scope even when only one mixin includes it.

**The guard lives in the shell's suite**
(`shell-frontend/e2e/specs/hosted-container-scale.spec.ts`), because standalone
at :4002 the viewport and the content are the same width and every
viewport-keyed breakpoint is accidentally correct. Red-proofed by swapping the
`@container` rules back to `@media`: 48 vs 32, 32 vs 20 and 72 vs 60 — the
original measurements exactly.

## Payload filtering, and chips that say what they remove (2026-09-20)

> **Six control defects, all found by dathq in minutes, all invisible to the
> functional specs** — those drive by role and never ask how big anything is.
> Pinned in `e2e/specs/payload-filter.spec.ts`, each red-proofed.
>
> The root cause of three of them is one thing worth remembering: **a control
> PrimeNG builds carries no `_ngcontent` attribute**, so an encapsulated rule
> cannot reach it. `ops-table()`'s sizing fix therefore applied to the inputs
> written in the template and silently missed the one inside `p-autocomplete`
> (25.3px beside a 38px neighbour) and the `.p-select-label` (11px dense tokens
> top-aligned inside a 38px box — the "not centered"). Those rules now live
> under `:host ::ng-deep`, which reaches both kinds.
>
> - **`filterBy="."`** named a field a plain string option does not have, so the
>   field menu's search answered "No results found" for a key visibly in the
>   list. Removed; a string option list filters on itself.
> - **The clear icon was 16px, flush against a 40px chevron.** A click slightly
>   wide of it opened the dropdown, which is what "needs 2 clicks" was. Padding
>   applies to an inline `<svg>`, so the target grows while the glyph does not —
>   sized to the control's **content** box, since padding to the full height
>   overflows and grows the host to 40px, which then stops matching its
>   neighbours. **Reported twice:** the first fix padded to 28x28 and cured the
>   horizontal miss only, leaving a 5px band above and below, and the spec
>   passed because it only ever moved sideways. It now clicks near every edge
>   of both axes and asserts the target's height against the control's.
> - **A clear button appeared with nothing to clear.** `showClear` renders
>   whenever the model is not null, and the signal's empty state is `""` —
>   which is not null. So a fresh load showed an X beside "Select a field…"
>   that did nothing when pressed. Bound as `payloadKeyInput() || null`.
>   Asserted as a **count**, because what was wrong was its existence.
> - **The value box refused input while looking ready to take it** — PrimeNG's
>   disabled styling lands on a wrapper this input is not inside.
> - **The stacking rule never fired.** It is a `@container` query and nothing
>   between the row and the page declared a container — `.es-table-wrap` is the
>   only one on the page and does not contain the filters. Declared on
>   `.events-filters-card`. A container query with no container fails silently,
>   which is why this is asserted and not assumed.


The advanced panel gained **Payload field** + **Payload value**, sending
`?payload.<key>=<value>`. The inputs set **one key at a time and leave the
others alone**, because a deep link can carry several and touching the box must
not drop them; removing is the chip's job. A payload filter counts as an
advanced filter, so arriving with one in the URL expands the panel holding it.

Found while writing the test for that: **every filter chip announced itself as
"Remove filter"**, because `aria-label` overrides the visible text for the
accessible name. A screen reader user could not tell which filter each button
removed, and neither could a test address one. The label is now
`REMOVE_FILTER_NAMED` — "Remove filter: payload.origin: messenger" — on both
list pages. Same family as the loading announcement above: a control that works
by sight and says nothing useful out loud.

## Filter options come from the data (2026-09-19, extended 2026-09-20)

The service, sink and **type** multiselects fetch their options —
`GET /api/event-store/events/services`, `GET /api/event-store/events/types`
and `GET /api/event-store/dlq/sinks` —
instead of listing them in `src/constants/`. `EVENTS_SERVICE_FILTER_OPTIONS`,
`DLQ_SINK_FILTER_OPTIONS` and both `_ORDER` arrays are gone, and so is
`helper/translated-filter-options.ts`.

**Why, with numbers.** The constants were a snapshot of the platform as it stood
before messenger shipped. Measured against the dev database on 2026-09-19: the
events filter offered `analytics-service` (0 events, deferred service, can only
ever return an empty table) and omitted `realtime-service` (412) and
`messenger-service` (148) — **560 of 715 events, 78%, could not be filtered at
all**. The DLQ filter was wrong in *both* directions at once: its two sinks had
zero records and the only sink with records was not offered.

**Raw identifiers, not translations.** The options render the service name as
the service publishes it. They name infrastructure, and the reason to filter by
one is to match it against a log line; both catalogs had in any case been
carrying the identifier as its own "translation" in English and German alike.
`EVENTS_PAGE.FILTERS.SERVICE_*` and `DLQ_PAGE.FILTERS.SINK_*` were deleted.

**Ordering.** `sortByCanonicalOrder` existed to keep multi-select values in the
constants' declaration order inside a **synchronous** query-param parser, which
cannot see fetched data. Alphabetical is now the only order available, so it is
the canonical one — `sortFilterValues` in `helper/list-query-params.ts`. Nothing
observable changed: unknown values already sorted alphabetically at the end.

**Failure degrades to no filter, quietly.** A failed options fetch leaves the
list empty rather than falling back to the constant, which would reinstate the
wrong list. A `?service=` from a bookmark still filters, because the request and
the chip both read `servicesFilter` and never consult the options. Both fetches
carry the quiet-errors context *and* header (`EventsService` gained the pair
`DlqService` already had) — the first e2e run popped the global error dialog
over a page that was otherwise working, which is the wrong report.

**Paging past the cap.** The paginator has a second mode. While the total is
exact it is unchanged — numbered links, first/last, jump anywhere. When the
service reports `totalCapped`, Next on the last numbered page does *not*
disable: it hands over to the keyset cursor, the links and the Last button
disappear (there is no last), and the readout becomes a running "Page N".

The page owns the cursors, the control only says which way (`cursorMove`:
`first` | `prev` | `next`). Previous is a **stack pop**, not arithmetic — you go
back exactly the way you came, which is the only exact answer available with no
total. Popping the last cursor drops the list onto the final numbered page and
the numbers start working again.

The cursor is **not in the URL**, deliberately: it is a position in a result set
that keeps growing, so a bookmarked one means something different tomorrow. A
reload lands on the last numbered page. Changing a filter or the sort clears the
stack for the same reason — a cursor belongs to one result set.

**`hasNextCursor` gates the hand-over, not `totalCapped`** (fixed on review of
!207). Keying it on "is the total capped" produced two dead controls, both of
which *looked* alive:

- The **DLQ list** is capped and has no cursor paging, so it binds neither
  `hasNextCursor` nor `(cursorMove)`. Its Next stayed enabled on the last page
  and emitted into an output nobody had subscribed to — a press that did
  nothing at all.
- **Last** shared `isLast()` with Next, which on a capped list is deliberately
  false on the last numbered page because the cursor takes over. Last has
  nowhere left to jump to, so it sat enabled on the page it would have taken
  you to. It did not re-fetch — `goToPage` returns early when the target is the
  current page — which is the worse failure: an enabled control that silently
  does nothing says the opposite of the truth.

Last now has its own `isAtLastNumberedPage()`. The general rule: **two controls
that happen to agree today should not share a predicate** — they answer
different questions ("can Next go anywhere" vs "is there a page to jump to"),
and the day they diverge, one of them lies.

**Loading is announced, not only spun at.** PrimeNG's `[loading]` mask is a
spinner whose icon is `aria-hidden`, so every refetch — filter, sort, page —
was silent for a screen reader while the detail pages announced theirs
properly. Both list pages now carry a visually-hidden
`<p class="sr-only" role="status" aria-live="polite">` bound to `loading()`.
`EVENTS_PAGE.LOADING_LIST` and `DLQ_PAGE.LOADING_LIST` had been in both
catalogs since the pages were written, bound to nothing — the "specified and
never built" half of an orphaned string, which is exactly why the audit did not
delete them.

**Panel height.** PrimeNG's default `scrollHeight` is 200px = five 40px rows
minus the list's 16px of padding, so the fifth option was clipped in half the
day a fifth service started publishing. The multiselects set
`scrollHeight="min(18.5rem, 60vh)"` — seven whole rows, capped for a landscape
phone. A partial row is a scroll affordance when there is more below and reads
as broken when there is not. Guarded by a rect assertion in
`e2e/specs/events-list.spec.ts`; the clipped option was present, correct and
reachable the whole time.
