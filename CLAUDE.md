# datha_platform

Personal platform workspace: microservices + microfrontends sharing a core, each product individual. Every top-level folder is its own git/ADO repo — this is **NOT a monorepo**, and a commit here never spans two of them.


> **This is a read-only public mirror.** The sixteen repositories are combined
> here into one so the platform can be read in one place; upstream they are
> separate, each with its own pipeline and PR history. Running it locally: see
> `README.md`.


**Running it locally? See `README.md`** — infrastructure via Docker Compose, then each service in its own project.

Rules live in `.claude/rules/` and are always in effect:

@.claude/rules/critical-behaviors.md
@.claude/rules/working-agreement.md
@.claude/rules/workspace-map.md

Architecture single source of truth is `.claude/docs/`. Before editing a repo, read its `.claude/docs/services/<repo>-architecture.md` and the matching `.claude/docs/lang/` doc. Never duplicate that content elsewhere — link to it.

Workflow skills live in `.claude/skills/` (real directories, invoked by name). Scratch output goes to `.claude/tmp/`.
