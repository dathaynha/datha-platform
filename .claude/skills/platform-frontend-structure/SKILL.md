---
name: platform-frontend-structure
description: >-
  Scaffold or review platform Angular frontend folder and routing structure
  (feature folders, *.routes.ts, page naming). Use when adding a new feature
  area, reorganizing modules/, asking about frontend folder conventions, or
  checking list/detail route layout across chatbot, shell, event-store, or
  other platform frontends.
---

# Platform frontend structure

Apply **`services/platform-frontend-conventions.md`** (read it first). This skill is the **workflow** for structure and routing — not product logic.

**Per-app rules** (`services/<app>-frontend-architecture.md`) override for ports, MF, and product routes.

## When to use

- User adds a list + detail (or multi-step) feature
- User asks where a page or component should live
- Refactor from flat `modules/foo-page/` + `modules/foo-detail-page/` into a feature folder
- Review PR for folder/routing consistency

## New feature checklist

```
- [ ] Pick feature slug: <feature> (domain name, not "page")
- [ ] Create modules/<feature>/<feature>.routes.ts
- [ ] Create route folders as siblings under modules/<feature>/
- [ ] Register loadChildren once in app-routing (+ remote-entry if MF remote)
- [ ] i18n keys under FEATURE_PAGE.* in assets/i18n/
- [ ] HTTP in services/implementations/ — gateway URL from environment
- [ ] OnPush + takeUntilDestroyed on new components
```

## Scaffold template

```text
modules/<feature>/
  <feature>.routes.ts
  <feature>-page/                 # path ''
    <feature>-page.component.*
    <child-widget>/               # optional — embedded only, not routed
  <feature>-detail-page/            # path ':id' — sibling of list, not inside it
    <feature>-detail-page.component.*
```

### `*.routes.ts` pattern

```typescript
import { Routes } from '@angular/router';

export const FEATURE_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./<feature>-page/<feature>-page.component').then((m) => m.FeaturePageComponent),
    data: { title: '…' },
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./<feature>-detail-page/<feature>-detail-page.component').then(
        (m) => m.FeatureDetailPageComponent,
      ),
    data: { title: '…' },
  },
];
```

Export name: `<FEATURE>_ROUTES` (e.g. `DLQ_ROUTES`, `EVENTS_ROUTES`).

### App routing hook

```typescript
{
  path: '<feature>',
  loadChildren: () =>
    import('@modules/<feature>/<feature>.routes').then((m) => m.FEATURE_ROUTES),
}
```

Same pattern in `remote-entry.ts` with relative imports.

## Navigation between list and detail

- List → detail: `router.navigate([record.id], { relativeTo: this.route })`
- Detail → list: `router.navigate(['..'], { relativeTo: this.route })`
- Inject `ActivatedRoute` + `Router` in the page component — not in a shared parent unless a feature shell exists.

## What goes where

| Item | Location |
|------|----------|
| Layouts, generic dialogs | `modules/shared/` |
| Table empty state, ops widgets reused in one app | `modules/shared/` or feature-local if single-feature |
| Feature constants | `constants/<feature>.constant.ts` or feature folder if tiny |
| Models | `models/` |
| Cross-app UI (future) | `shared-frontend/` library — not duplicated in each repo |

## Structure review (quick)

Flag as **wrong** when:

- Detail route folder is **nested inside** list page folder (reads as child component, not route sibling)
- Related list + detail sit as **top-level siblings** under `modules/` with no feature parent
- Child routes defined inline in `app-routing.module.ts` instead of feature `*.routes.ts` (when feature has 2+ routes)
- New feature NgModule added (use standalone + `loadComponent` only)

Flag as **OK**:

- `pages/list/` + `pages/detail/` under feature (route-oriented names)
- `<feature>-page/` + `<feature>-detail-page/` as siblings under feature (component-oriented names)
- Single-page feature with only `''` route — routes file optional but fine for consistency

## Related

- **`lang/lang-angular.md`** — components, signals, templates
- **`services/shell-frontend-architecture.md`** — MF host, shelled remotes
- **`services/shared-frontend-architecture.md`** — extract shared UI to library
