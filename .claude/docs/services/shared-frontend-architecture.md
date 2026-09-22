# `shared-frontend` — architecture and design rules

_Shared Angular UI library repo — theme, SCSS, wrappers consumed by platform frontends (multi-repo)_

Alias: **`frontend-shared`**. Generic Angular patterns: **`lang/lang-angular.md`**. MF host/remote rules stay in each app repo.

## Role

- **Publishable npm library** (e.g. `@datha/platform-ui`) — **not** a deployable app.
- **Single source of truth** for cross-app UI: PrimeNG Aura preset, design tokens, global SCSS partials (`es-*` / platform classes), optional thin wrapper components (`datha-date-picker`, etc.).
- **Does not replace** `shell-frontend`, `chatbot-frontend`, or `event-store-frontend` — those remain separate ADO repos and MF deployables.

## What belongs here vs in apps

| In `shared-frontend` | Stays in each app repo |
|----------------------|-------------------------|
| Theme preset, CSS variables, SCSS partials | Routes, guards, feature pages |
| Reusable presentational components | Module Federation `webpack.config.js`, `remote-entry.ts` |
| i18n keys for shared chrome only (if any) | App-specific i18n catalogs |
| Package `peerDependencies` on Angular / PrimeNG | OAuth bootstrap, `environment.*.ts`, gateway URLs |

## Module Federation — styling contract

Hosted remotes do **not** reliably load their own global CSS. Shared styling must work when **only the shell bundle** loads globals.

1. **Shell** imports `@datha/platform-ui/styles` (or equivalent entry) in its global styles pipeline.
2. **Remotes** depend on the package for **component-scoped** imports and preset config — not duplicate global theme injection in hosted mode.
3. **Never ship hacks as public API** — no `zoom` / `MutationObserver` datepicker fixes in the library. Fix via preset tokens, documented global overrides, or a wrapper component with supported PrimeNG APIs (`panelStyle`, theme extension).

## Stack alignment

Match production frontends exactly:

- **Angular 21** — exact pinned versions (no `^` / `~`); same as shell/remotes for MF DI safety if any runtime sharing.
- **PrimeNG 21 + Aura** — preset lives here; apps import and pass to `providePrimeNG`.
- **Tailwind v3** — v4 incompatible with webpack MF stack; shell may still own Tailwind `content` scanning until a documented split exists.

## Package shape (target)

```
shared-frontend/
  src/
    theme/           # prime-aura-preset, tokens
    styles/          # SCSS partials (_tokens, _input, _table, …)
    components/      # optional wrappers (OnPush, minimal API)
  package.json       # exports: preset, styles, components
```

Publish to **Azure Artifacts** (or local `pnpm link` during development). Apps pin semver ranges only after the library stabilizes; until then prefer exact versions.

## Migration from duplicated app code

When extracting from `event-store-frontend` / `chatbot-frontend`:

1. Move preset + `src/styles/*` partials first.
2. Update **shell** global styles import, then each remote’s preset import.
3. Delete duplicated files in app repos in the **same coordinated PR wave** (separate ADO PRs per repo, called out in summaries).

## Roadmap — v0.2.0 (planned 2026-07, one consolidated release)

Status: **v0.1.0 published** (Aura preset + tokens/surface/forms SCSS); shell-frontend adopted (preset + global styles). Remotes not yet migrated.

One version while the platform has only 3 frontends — do NOT split into multiple releases:

| Item | Content |
|------|---------|
| **Glass design system** | Codify glassmorphism once: `--datha-glass-*` tokens (blur, opacity, border), `.datha-glass` utility, refine `.datha-surface-card` on it. Apps stop hand-rolling `backdrop-filter` |
| **Theme model (TS)** | Move `shell-theme.model.ts` (Starlight/Midnight ids, normalize) into lib beside the preset |
| **Dialog/modal component** | Extract per-app `modules/shared/dialog/` into first Angular component export |
| **Login-card component** | Presentational login shell (card + backdrop + slots via content projection); OAuth/auth logic stays app-side |
| **Form field wrappers** | Componentize existing `datha-input` / `datha-select` / `datha-label` classes |
| **Dark-surface utilities** | Shared classes for the `:host-context(.dark)` raw-surface re-pointing every component currently hand-writes (raw `--p-surface-N` primitives do NOT darken under `.dark` — Aura swaps slate→zinc only) |

After v0.2.0 ships: one adoption PR per app (shell, chatbot-frontend, event-store-frontend) deleting the local dupes.

**Status 2026-07-16:** v0.2.0 published to `platform-npm`. Adoption PRs not started.

## v0.6.1 — BUILT, NOT PUBLISHED (2026-09-20): remote translations stop eating host keys

`registerRemoteTranslations` rebuilt each top-level namespace as a **plain
replacement** of the remote's subtree. That drops any leaf only the host
defines — and the shell's profile menu is built from `PROFILE.*`, with
`PROFILE.SUPPORT` defined by the shell alone. So mounting any remote rendered
the raw key **`PROFILE.SUPPORT`** in the popup. dathq reported it with a
screenshot; reproduced on `/event-store/events` and correct on `/`.

**The rule and the library contradicted each other.** `sub-header.component.ts`
warns that a remote must not reuse a host namespace (`NAV`, `SETTINGS`,
`PROFILE`, …) — but `profile-popover.component.html` **hardcodes** `PROFILE.*`,
so every remote has to ship a `PROFILE` block to work standalone. The collision
was unavoidable, which makes the merge the only place it can be fixed. The
remotes were otherwise obedient: their own support item already uses
`SUBNAV.SUPPORT`.

**Three merge strategies, two of which have shipped a bug.** The namespace is
now rebuilt as *the host's baseline for that namespace, with the remote's
leaves merged over it*:

| Strategy | Failure |
|---|---|
| Replace the subtree (until now) | Host-only leaves vanish — this bug |
| Merge onto whatever is there now | Stale leaves from *another* remote survive; the original reason replacement was chosen |
| **Baseline ⊕ remote (now)** | — |

The host baseline is captured per language on first registration, in a
`WeakMap` keyed on the `TranslateStore` rather than in module state — so every
injector (each `TestBed`, a standalone remote, the shell) gets its own, and it
is collected with the store. Namespaces a bundle does not mention are left
alone, which is what keeps messenger's header-widget strings alive while
another remote is on screen.

**Conflicts resolve to the remote** (dathq's call, 2026-09-20). Hosted, the
popup header therefore still reads the remote's "Signed in as" rather than the
shell's "My Profile" — deliberate, not a leftover.

Verified: 37 specs (2 new), red-proofed by neutralising the merge to
`mergeTree({}, incoming)` — the two new specs fail, the three pre-existing pass.
Note the first attempt at that red-proof **deleted** the helper and died on
`TS6133` instead, which proves nothing about behaviour. `ng-packagr` build
clean, prettier clean.

⚠️ **Not published, and the bug is still live in the running app.** Proven end
to end by copying `dist/platform-ui` over both apps' installed package and
restarting them — the popup read "Email Support" — then restored with a real
`pnpm install`, because a patched `node_modules` leaves a false green behind it.
Releasing needs a `v0.6.1` tag plus an exact-version bump in all four
consumers, which is dathq's call.

## v0.6.0 (shipped 2026-09-18 — theme and language become chip menus)

`ThemeSelectComponent` and `LangSelectComponent` are no longer dropdowns. Each
is the platform's **chrome chip** (`p-button`, `[rounded]`, `[outlined]`,
`styleClass="datha-profile-trigger"` — the recipe the notification bell already
reused) opening a `p-popover` that lists every option with the current one
marked. The chip's face is the applied theme's icon, or the active language
code.

**Why not a toggle.** A cycling toggle was built first and rejected by dathq:
the option lists are expected to grow, and cycling makes reaching the third
entry a matter of pressing until it comes round. Two options did not justify
the ~150px each select was spending, but the answer is a chooser, not a cycle.

**Why no tail.** Apple draws a tail on a *popover* — a transient view — and not
on a [pull-down button's menu](https://developer.apple.com/design/human-interface-guidelines/pull-down-buttons),
which is what every menu on this platform actually is. The rule lives on
`.p-popover` in `styles/_overlays.scss`, not on these two components, because a
tail on the messenger widget beside a tail-less theme menu is the inconsistency
people notice. It also deleted a class of bug: a tail must be repositioned by
hand whenever its panel is, and **the theme paints it at its own offset from
the token that moves it** (`--p-popover-arrow-left` read 156px while the arrow
painted at 176px in Aura), which produced two rounds of visibly misplaced
arrows before the tail went.

**Alignment.** `controls/align-popover.ts` centres a panel on its trigger and
clamps it to the viewport with an 8px margin; `max-width: calc(100vw - 1rem)`
keeps it narrower than the screen. It reads `offsetWidth`, never a bounding
rect, because `onShow` fires while the panel is still scaling in.

**Dismissal.** The same file exports `dismissOnOutsidePress`, a **capture**-phase
`mousedown` listener. PrimeNG's own outside-click was not enough: the messenger
header widget re-dispatches its trigger's click after the original dispatch
finishes, so by the time the document handler runs the target has moved and two
menus sat open side by side.

**API unchanged** — same selectors, `selected` model, `languages` input,
`inputId`. Consumers needed only the pin, one new `LANGUAGE.LABEL` key per
catalogue (`THEME.LABEL` already existed), and **nine spec fixes**, because the
rendered DOM changed even though the API did not.

`@angular/forms` became unused by the library here. It stays a peer dependency:
the form-field wrappers on the v0.2.0 roadmap need it and every consumer is an
Angular app that already has it.

Adopted by PRs !197 chatbot, !198 event-store, !199 messenger, !200 shell.

## v0.5.0 (built 2026-09-03 — chrome extraction, closes the last two next-minor rows)

`SubHeaderComponent` (`datha-sub-header`) — the slim product bar both remotes hand-rolled. Tabs input (`DathaSubHeaderTab { id, labelKey, route, exact? }`, exported type) on the left, `<ng-content>` slot for chrome controls on the right; the bar itself renders `datha-glass-bar`, z-index 10, `min-height: var(--datha-toolbar-height)`.

**Tabs are anchors, not buttons.** This adds `@angular/router` as a peerDependency — a deliberate narrowing of the v0.4.0 "no Router in the lib" rule, which is about *navigation policy* (which route a target points at stays consumer-side), not link semantics. Real `<a href>` gives middle-click and open-in-new-tab, lets `routerLinkActive` own active state, and exposes link role + `aria-current="page"`. It also deleted the reason the duplication existed: no `p-button` means no `--p-button-text-primary-color` fight and no `.p-toolbar` background override.

**Chrome tokens** — `--datha-chrome-text`, `--datha-chrome-text-strong`, `--datha-chrome-text-active`, `--datha-chrome-hover-bg`, `--datha-chrome-active-bg` (light + `.dark` in `_tokens.scss`). The sub-header, its projected PrimeNG text buttons (via `--p-button-text-primary-color` set on the actions slot) and the shell sidebar all read them, so the neutral-inactive / primary-active recipe has one definition. Consumers lose their `:host-context(.dark)` duplicates: the tokens are already theme-aware at `:root`/`.dark`.

**`styles/_chrome.scss` — mixins, new package export `@datha/platform-ui/styles/chrome`.** `ambient` / `ambient-dark` (the identical 40-line gradient wash both remotes carried) and `content-surface` / `content-surface-dark`. Mixins, not utility classes, because a hosted remote never loads its own global stylesheet — shared chrome CSS has to compile *into* component styles, which `@use` from a component SCSS does and a global class cannot.

**a11y nits closed** — profile trigger uses `[ariaLabel]` (the PrimeNG Button input, which lands on the inner `<button>`) instead of `[attr.aria-label]` on the host, which left the real button nameless. Dialog footers move off the hardcoded `'Close'`/`'Cancel'`/`'Confirm'` strings onto `DIALOG.OK` / `DIALOG.GOT_IT` / `DIALOG.CANCEL` / `DIALOG.CONFIRM`, so the footer button no longer shares the name "Close" with the panel X. Consumers must add the `DIALOG.*` keys.

**i18n namespace rule (learned the hard way).** `registerRemoteTranslations` replaces a whole top-level subtree on purpose (so two remotes cannot leave stale keys in each other's namespace). A remote must therefore never reuse a namespace the shell owns — the first cut of this work gave both remotes a `NAV.*` namespace and the shell sidebar rendered a raw `NAV.HOME` while a remote was mounted. Remotes use **`SUBNAV.*`**; shell keeps `NAV.*`.

Adoption: chatbot-frontend + event-store-frontend (both layouts each — authenticated and unauthenticated), shell-frontend (sidebar reads the tokens). Consumer pins can only move to 0.5.0 once the tag is published to `platform-npm`.

Folded in while the files were open: `aria-expanded` moved off the `p-button` host (inert there — `ButtonProps` has no attribute passthrough) onto the real button via `[pt]="{ root: { 'aria-expanded': … } }"`; and every consumer catalog lost its legacy English-sentence keys (`"Login"`, `"Logout"`, `"Language"`, `"Confirmation"`, `"Are you sure you want to do this?"`, `"Save"`, `"Delete"`, `APP_NAME`) — all dead, verified by grepping for `| translate` / `instant()` before deleting. The chat rename editor's two live ones became `CHAT.RENAME_SAVE` / `CHAT.RENAME_CANCEL`, so no catalog carries loose top-level keys any more. Route `data.title` values look like keys but are inert — there is no `TitleStrategy`.

## v0.4.0 (PR 66, released 2026-08-03 — tag `v0.4.0`, shell adopted same day, PR 69)

`ProfilePopoverComponent` gains **opt-in menu items**: `menuItems` input (`DathaProfileMenuItem { id, labelKey, icon? }`, exported type) + `menuItemSelect` output rendered between identity rows and logout. Navigation stays consumer-side (no Router dep in lib). Shell passes `[{ id: "settings", labelKey: "SETTINGS.NAV", icon: "pi-cog" }]` → `/settings`; **standalone remotes pass nothing** (no settings routes there — settings are host-owned chrome). Sub-header extraction, chrome-text token and the a11y nits landed in v0.5.0 (above).

## v0.3.3 (PR 43, 2026-07-29)

Dialog seam fix — mask carries the blur, panel is filter-free (see glass lessons). No API change; all 3 frontends bumped same day (PRs 44–46). Both a11y nits noted here were fixed in v0.5.0.

## v0.3.2 (PR 39, 2026-07-29)

Overlay hover-smear fix only — `_overlays.scss` restructured (see glass lessons below). No API change. Consumers bump from 0.3.1 with zero code changes.

## v0.3.0 + v0.3.1 (published 2026-07-27; shell adopted)

**Liquid Glass** (<https://developer.apple.com/documentation/technologyoverviews/liquid-glass>) — web approximation, extends v0.2.0 tokens in place:

- Tokens: `--datha-glass-saturation`, `--datha-glass-bg-{surface,overlay,control}` (color-mix translucency), `--datha-glass-edge`, `--datha-glass-highlight` (top specular), `--datha-glass-shadow`, `--datha-glass-radius-{surface,overlay,control}` (control = capsule). Light + `.dark` sets.
- `.datha-glass{,-overlay,-control}` upgraded to full material (blur+saturate, tint, hairline edge, inset highlight); new `.datha-glass-bar` for full-bleed toolbar/sidebar.
- **Layering rules:** glass on chrome/navigation layer only (toolbar, sidebar, popover, dialog, controls) — never on the content layer, never glass-on-glass.

**Gathered from app duplicates (TS):**

- `DATHA_SHELL_CONTEXT` token + `DathaShellContext`/`DathaOwnerProfile` types (moved from shell `shell-context.token.ts`; shell re-exports or aliases during adoption)
- `registerRemoteTranslations(translate, store, bundles)` — bundles now injected; remotes keep only their JSON imports
- `datha-theme-select` / `datha-lang-select` toolbar controls (consumer supplies `THEME.*` i18n keys; `DATHA_LANGUAGE_LABELS` exported)

**v0.3.1 additions:** login card/buttons on glass material; global `_overlays.scss` (glass for PrimeNG `.p-dialog`/`.p-popover`/`.p-select-overlay` — needs `.p-component` specificity to beat PrimeNG's own bg); `.datha-glass-sheen` (top reflection) + `.datha-glass-shine` (animated sweep, hero surfaces only, reduced-motion safe); `--datha-glass-{brightness,sheen,shine-color,control-edge}` tokens (theme-tuned).

**Glass lessons (hard-won):** backdrop-filter is invisible over flat backgrounds — chrome needs a colorful ambient behind it (shell `.shell-root` gradient); backdrop-filter creates a stacking context — chrome needs explicit z-index or overlays get trapped; absolutely-positioned sheen pseudos paint above static children — sheen/shine utilities lift direct children (`> * { position: relative; z-index: 1 }`); light theme needs lower glass whiteness + saturated backdrop or the effect vanishes; **panel-scoped backdrop-filter = GPU sampling-seam artifact** (edge-aligned band on re-raster, random on hover/open/click-hold; GPU-only, invisible to headless capture) — v0.3.2's shadow/filter layer split did NOT fix it; the real fix (v0.3.3) removes the filter from the dialog panel entirely and frosts the full-viewport `.p-dialog-mask` instead (no partial sampling region = no seam; Apple-style modal backdrop). Popover/select keep the v0.3.2 split (no mask available) — if the seam ever shows there, drop their filter for a stronger tint. Non-overlay glass (login card, bars, home cards) unaffected in practice.

Adoption status: **all 3 apps adopted** — shell PR 31 (0.3.1) + PR 40 (0.3.2 bump); chatbot-frontend PR 41 + event-store-frontend PR 42 (2026-07-29, combined 0.2.0+0.3.2: dupes deleted, pin sweep, es-* form/surface → datha-*, glass chrome). Remote lessons: remote global styles never load hosted, so chrome ambient lives in **component** styles; remote toolbar z-10 (under shell z-20 or it covers shell dropdowns); PrimeNG internals unreachable from scoped rules — override PrimeNG CSS **variables** (e.g. `--p-button-text-primary-color`); chrome text neutral, primary = active state only (tinted pill, shell-sidebar recipe); remotes' bot-review pipelines need `npmAuthenticate@0` for the feed.

**Dark-mode overlay lesson (from shell popover bug):** PrimeNG body-appends overlays — component-scoped `:host-context(.dark)` rules never match there. Overlay content must use lib global utilities (`.datha-text-strong/muted`) or global stylesheet `.dark` rules.

## Agents

- **Commits / PRs / pipelines:** scoped to **`shared-frontend/`** only unless the user names consumer repos for coordinated bumps.
- Do **not** add MF host config, nginx, or OAuth flows to this repo.
- Cross-repo consumer changes: list required bumps in `shell-frontend`, remotes, and this package version.

## Related rules

- **`services/shell-frontend-architecture.md`** — Tailwind content scan, manifest, global CSS ownership
- **`services/chatbot-frontend-architecture.md`**, **`services/event-store-frontend-architecture.md`** — remote patterns
- **`services/platform-frontends-nx-architecture.md`** — optional Nx monorepo experiment (separate repo; may mirror this lib as `libs/platform-ui`)
