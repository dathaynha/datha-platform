# `platform-frontends-nx` — Nx experiment (sandbox only)

_Experimental Nx + Module Federation sandbox repo — not production; reuses existing backends_

## Role

- **Separate ADO repo** for evaluating **Nx + Angular Module Federation** in a monorepo shape.
- **Does not replace** `shell-frontend`, `chatbot-frontend`, `event-store-frontend`, or **`shared-frontend`** unless explicitly promoted by the team.
- **Reuses existing backends** locally — same `api-gateway`, `event-store`, `chatbot-service`, etc. Point `environment.*.ts` at existing dev URLs; no duplicate BE services in this repo.

## Intended layout

```
platform-frontends-nx/
  apps/
    shell/              # MF host
    chatbot/            # remote
    event-store/        # remote
  libs/
    platform-ui/        # mirror or prototype of shared-frontend
  nx.json
  project.json          # per app/lib
```

Production patterns to copy **from** existing repos (webpack MF, `sharedMappings: []`, exact Angular pins, `liveReload: false` on remotes): **`services/shell-frontend-architecture.md`**.

## Scope boundaries

| OK in sandbox | Do not do here |
|---------------|----------------|
| Nx generators, `nx affected`, cache experiments | Change production ADO pipelines or deploy targets without explicit ask |
| Prototype shared lib as `libs/platform-ui` | Move platform-nats, gateway, or service code |
| Spike MF dev-server orchestration (`nx run-many -t serve`) | Assume this repo is wired in prod shell manifest |

## Relationship to `shared-frontend`

- **Multi-repo path (production intent):** `@datha/platform-ui` from **`shared-frontend`** ADO repo.
- **Nx path (experiment):** internal `libs/platform-ui` — if the spike succeeds, either migrate lib **into** `shared-frontend` or consolidate frontends here; **one** shared-UI story, not two divergent copies long-term.

When both exist, prefer **porting proven changes** from sandbox → `shared-frontend` + consumer apps, not the reverse.

## Local dev

- Clone beside existing services in `datha_platform/` for convenience (workspace folder is **not** a git monorepo).
- Start backends the same way as today (gateway, DBs, NATS per service READMEs).
- Sandbox ports should **avoid colliding** with production frontends (**4000** shell, **4001** chatbot, **4002** event-store) — use alternate ports (e.g. **4100–4102**) or run one stack at a time.

## CI (when added)

- `nx affected -t lint,test,build` on PR — validate graph + cache; no requirement to match MegaLinter setup in legacy repos until this repo graduates from experiment.

## Agents

- Treat all work here as **experimental** — call out “sandbox only” in summaries.
- **Commits / PRs:** scoped to **`platform-frontends-nx/`** only.
- Do not modify production frontend repos to depend on this sandbox unless the user explicitly requests integration.

## Related rules

- **`services/shared-frontend-architecture.md`** — target npm lib for production shared UI
- **`services/shell-frontend-architecture.md`** — canonical MF host behavior
- **`always-apply/workspace-layout.md`** — each folder is its own git repo
