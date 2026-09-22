# @datha/platform-ui

Private Angular library for the DatHa platform theme and reusable UI primitives. It is published to the `platform-npm` Azure Artifacts feed; it is not a deployable application.

## Requirements

- Node.js 24
- pnpm 10.33.2 through Corepack
- Access to the `DatHa Platform` Azure DevOps project and `platform-npm` feed

## Azure Artifacts authentication

The committed `.npmrc` contains registry URLs only. Credentials must stay in the user-level `~/.npmrc`.

1. In Azure DevOps, open **Artifacts → platform-npm → Connect to feed → npm → Other**.
2. Create a short-lived PAT with **Packaging: Read** for installing packages or **Packaging: Read & write** for manual publishing.
3. Copy the generated authentication block into `~/.npmrc`, not this repository.

Azure Pipelines uses `npmAuthenticate@0` and its build identity; no PAT is stored in pipeline YAML.

## Install and build

```bash
corepack enable
corepack prepare pnpm@10.33.2 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm test        # karma headless, one run — same command bot-review uses
pnpm pack:check
```

`pnpm test:watch` is the interactive re-run mode. Build output is written to `dist/platform-ui` and must not be committed.

## Consumer usage

Install an exact version:

```bash
pnpm add @datha/platform-ui@0.1.0 --save-exact
```

Configure PrimeNG in the application:

```typescript
import { platformAuraPreset } from "@datha/platform-ui";

providePrimeNG({
  theme: {
    preset: platformAuraPreset,
    options: { darkModeSelector: ".dark" },
  },
});
```

Load global tokens and opt-in primitives once from the shell's global Sass entry:

```scss
@use "@datha/platform-ui/styles";
```

For component-scoped form helpers:

```scss
@use "@datha/platform-ui/styles/forms";
```

Chrome mixins are a separate entry point. Use them from a **component** stylesheet — a hosted Module Federation remote never loads its own global stylesheet, so shared chrome CSS has to compile into the component styles that ship with the remote's module:

```scss
@use "@datha/platform-ui/styles/chrome" as chrome;

.my-layout {
  @include chrome.ambient;
}
:host-context(.dark) .my-layout {
  @include chrome.ambient-dark;
}
```

The product sub-header takes router tabs and projects its trailing controls. Label keys are resolved from the consumer's catalog; remotes must keep them out of the namespaces the shell owns (use `SUBNAV.*`, not `NAV.*`):

```html
<datha-sub-header [tabs]="tabs()" navAriaLabelKey="SUBNAV.ARIA">
  <p-button [text]="true" [label]="'SUBNAV.SUPPORT' | translate" />
</datha-sub-header>
```

Consumers must also provide `DIALOG.OK`, `DIALOG.GOT_IT`, `DIALOG.CANCEL` and `DIALOG.CONFIRM` for the dialog components.

The library does not provide Module Federation configuration, OAuth, routes, Tailwind output, or application translations.

## Local package check

Prefer testing the package that consumers will receive:

```bash
pnpm build
npm pack ./dist/platform-ui
```

Install the resulting tarball temporarily in a consumer. Do not commit the tarball dependency. `pnpm link` is discouraged because symlinked Angular or PrimeNG peers can create a second runtime instance.

## Release

1. Update `projects/platform-ui/package.json` and the root package version.
2. Merge the reviewed change to `main`.
3. Tag that commit `vX.Y.Z`.
4. Push the tag. `/azure-pipelines/release.yml` verifies tag and package versions, builds, and publishes.
5. Confirm the package in **Artifacts → platform-npm**. Promote it to `@Release` after consumer verification when feed views are used.

Package versions are immutable in Azure Artifacts. If a publish is wrong or partially fails, increment the version; deleting a version does not make it reusable.

Before `1.0.0`, use patch releases for compatible fixes and minor releases for additions or breaking API changes. Consumers pin exact versions.

## Troubleshooting

- `401 Unauthorized`: refresh the credentials in `~/.npmrc` from **Connect to feed**.
- `403 Forbidden` in a pipeline: grant both DatHa build-service identities **Feed Publisher (Contributor)**.
- `409 Conflict`: that version has already been used; increment it.
- Missing Sass import: run `pnpm pack:check` and confirm the `styles/*.scss` assets are listed.
