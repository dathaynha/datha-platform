# Angular — best practices

_Angular best practices — components, signals, templates, routing, forms (any Angular project)_

Aligned with [Angular — LLM prompts & AI IDE setup](https://angular.dev/ai/develop-with-ai#rules-files).

## TypeScript

- Strict mode; prefer inference; avoid `any` — use `unknown` when needed.

## Composer footers — one rhythm across products

A bottom-anchored message composer uses the same spacing in every frontend
(settled 2026-09-09, after Messenger's was reported as "super close to the
bottom"):

```
border-t px-4 pb-5 pt-3 sm:px-6      # the footer/form wrapper
```

plus a centred hint line below the input reading *Enter to send ·
Shift+Enter for new line* — both products bind Enter to send, so the hint is the
same sentence and the behaviour is discoverable. `chatbot-frontend`'s
`.chat-composer` is the reference; `messenger-frontend`'s `.thread-composer`
matches it. `event-store-frontend` has no composer.

**`pb-5` is the point.** `py-3` leaves the input jammed against the viewport
edge, which reads as a rendering bug rather than a layout choice.

Aligned **by convention, not by a shared component.** A composer in
`@datha/platform-ui` would be the stricter answer, but it would mean a
shared-frontend release and a version bump in four repos for what is padding —
revisit only when the composers need to share behaviour, not just spacing.

## Components

- Prefer **standalone**; in **v20+** omit `standalone: true` (default).
- **`inject()`** for DI in new code; **`ChangeDetectionStrategy.OnPush`** for new/presentational components.
- Prefer **`input()` / `output()`** over `@Input` / `@Output` in new code.
- Use **`host: { }`** on `@Component` / `@Directive` — not `@HostBinding` / `@HostListener`.
- **`NgOptimizedImage`** for static images (not inline base64).

## State & templates

- **`signal` / `computed` / `update` | `set`** for local state; do not use `mutate` on writable signals.
- **`@if` / `@for` / `@switch`** — avoid `*ngIf` / `*ngFor` / `*ngSwitch` in new or edited templates.
- **`class` / `[class.xxx]`** instead of `ngClass`; **`style` / `[style.xxx]`** instead of `ngStyle`.
- **`async` pipe** for templates consuming observables when practical.

## Routing & forms

- New features: prefer **`loadComponent`** + standalone components over **`loadChildren`** + feature `NgModule`.
- Prefer **reactive forms** for non-trivial forms.

## RxJS

- `takeUntilDestroyed()` or `async` pipe to manage subscriptions; avoid nested subscribes.

## Accessibility

- Target **WCAG 2.1 AA**; verify with **axe** when changing UI.

## Replaced environment files must be excluded from `tsconfig.app.json` (2026-09-08)

`angular.json` `fileReplacements` substitutes `environment.dev|int|prod.ts` for `environment.ts`, so each is already compiled **under that path** by the build that selects it. If the broad `include: ["src/**/*.ts"]` also pulls them in as themselves, every production build prints two `is part of the TypeScript compilation but it's unused` warnings. All four frontends carried them until 2026-09-08.

Fix is one `exclude` entry per replacement file. Typechecking is not lost — each file is still compiled by the configuration that selects it. **Verify per configuration after changing this**: build prod, integration and development and confirm each output carries its own gateway URL and not another's. A silent fallback here would ship the wrong backend URL, which no test would catch.

New frontend? Do this in the scaffold.

## knip's `.css` hint in the frontends is not worth fixing (2026-09-08)

Every frontend's `knip` run ends with one configuration hint: `.css — Compiled extension excluded by project (imports not followed)`. Adding `src/**/*.scss` to `project` makes it **worse** — two hints, because knip then wants a registered compiler for the extension. Registering one is real configuration for no dead-code benefit, since component styles are reached through `styleUrls` that knip already resolves via its Angular plugin. Leave the hint; it is not a finding and does not fail CI.

## Sibling routes share a component but not an instance (2026-09-08)

`{ path: "" }` and `{ path: ":id" }` pointing at the same component are two route configs, so switching between them **destroys and recreates** the component. Anything that reacts to `paramMap` therefore runs on the *outgoing* instance too: in `messenger-frontend` the leaving instance emitted an id-less map and cleared the shared store *after* the arriving instance had opened the thread, leaving a URL with no thread on screen.

Read the id from `route.snapshot` at construction and re-read it on `NavigationEnd`. A destroyed component runs neither, so the ordering cannot happen. And when a store's state must outlive that churn — the open conversation, say — hold it in the store rather than deriving it from a list that a background refresh can replace.

## Navigating inside a federated remote

Use `relativeTo` the feature's own route (`route.parent`), never an absolute path: the same routes are mounted at `/chats` standalone and `/messenger/chats` under the shell, and an absolute path only works in one of them.
