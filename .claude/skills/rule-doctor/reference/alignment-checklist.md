# Alignment checklist — what to verify in the repo

Extract **evidence** from the repo (read-only). Never read backend `.env` — use **`.env.example`** only.

**Domain runs:** repeat this checklist **per repo** in the profile; then use **`domain-profiles.md`** product rules + **`prepare-push/reference/cross-repo-matrix.md`** for **`cross-rules.md`**.

## Evidence sources (read in order)

1. **`README.md`** — stated stack, ports, setup commands
2. **Manifest** — `package.json`, `go.mod`, `pyproject.toml` (name, scripts, deps, engines)
3. **Layout** — top-level dirs (`src/`, `cmd/`, `internal/`, `azure-pipelines/`)
4. **`.env.example`** — env var names (compare to rule “Key env vars” tables)
5. **Entry / routes** — `main.go`, `cmd/`, `src/routes/`, `src/app/` routing
6. **NATS** — `src/nats/streams.ts`, publish/consume code, durable name constants
7. **CI** — `azure-pipelines/bot-review.yml`, `.mega-linter.yml`, test commands in YAML
8. **Frontend MF** — `webpack.config.js`, federation manifest, `environment.*.ts`, dev port in `angular.json` / README
9. **Migrations / schema** — SQL migrations vs rule schema snippets

## Claim types to extract from each rule

For each loaded `.md`, list concrete claims:

- Stack (language, framework, major versions)
- Ports / URLs
- HTTP routes and auth model (`JWT`, `X-Owner-ID`, internal routes)
- NATS subjects, stream names, durable names, event types
- Env var names and defaults
- File/repo map (“lives in `src/...`”)
- CI / bot-review status (“registered in ADO”, canonical template)
- Responsibility “Does / Does not” boundaries
- Cross-links to other rules (note if sibling repo needed)

## Diff categories

| Category | Meaning | Typical action |
|----------|---------|----------------|
| **ALIGNED** | Rule matches repo evidence | None |
| **RULE STALE** | Repo changed; rule is wrong or incomplete | **Update rule** (primary output user wants) |
| **RULE AHEAD** | Rule describes planned/future; repo not implemented or absent | Keep rule; note “not in repo yet” |
| **CODE DRIFT** | Rule is platform truth; repo violates it | Fix code (mention only unless user asks to fix) |
| **UNVERIFIED** | Cannot confirm without running service or missing files | State what was not checked |

## High-value checks (datha_platform)

- **api-gateway:** proxy path strips, auth routes, `stream_token`, NATS publish subjects
- **chatbot-service:** Redis queue, SSE, outbox, conversation delete + orphan query
- **file-service:** SAS upload flow, `X-Owner-ID` auth (no JWT), conversation cleanup consumer durable name vs `platform-nats/topology.ts`
- **platform-nats:** durable names vs each service `streams.ts` constant
- **shell + remotes:** ports 4000/4001/4002, remote names in manifest vs webpack `exposes`
- **bot-review:** rule says “registered” vs file exists on disk; test command in YAML vs rule

When **`platform-nats`** and a consumer repo are both in scope, compare durable/subject strings **both ways**.
