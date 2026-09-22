# datha-platform

A personal microservices + microfrontends platform — 16 services and frontends
sharing one core, each product independent. Built to try production patterns
properly rather than to ship a demo: polyrepo boundaries, event choreography
over JetStream, Module Federation, WebRTC calling, and an architecture doc per
service that is kept true.

> **This is a read-only mirror, for viewing.** The real source lives in **16
> separate Azure DevOps repos**, one per service, each with its own pipeline,
> branch policies and PR history. They are combined into this single repository
> so the whole platform can be read in one place. Nothing here is deployed from
> here — **but it all still runs locally**, and the steps below are the ones I
> actually use.
>
> **Snapshot taken 22 September 2026. Nothing syncs it.** Development continues
> in the Azure DevOps repos, so treat anything here as true of that date and no
> later. There is no automation and no schedule — the mirror is refreshed by
> hand, when it is worth refreshing.

## What's in it

| | |
|---|---|
| **Backends** | Go 1.25 (chi), Node 22 (Fastify 5), Python 3.11 (FastAPI) |
| **Frontends** | Angular 21, Module Federation — one host, four remotes |
| **Data** | PostgreSQL 16 (partitioned event store), Redis, NATS JetStream |
| **Realtime** | WebSockets, WebRTC mesh calling, coturn TURN relay |
| **AI** | Gemini, streamed over SSE |
| **Ops** | Grafana, Loki, Prometheus, OpenTelemetry |

### Services

| Repo | Stack | Port |
|---|---|---|
| `api-gateway` | Go, chi, JWT, reverse proxy | 8080 |
| `file-service` | Node, Fastify, Azure Blob SAS | 3001 |
| `event-store` | Node, Fastify, JetStream ingest | 3002 |
| `notification-service` | Node, Fastify, JetStream → bell | 3003 |
| `realtime-service` | Go, websockets, Redis presence | 3004 |
| `messenger-service` | Node, Fastify, conversations/messages | 3005 |
| `accounts-service` | Node, Fastify, users/workspaces | 3006 |
| `chatbot-service` | Python, FastAPI, SQLAlchemy, Gemini | 8050 |
| `platform-nats` | JetStream topology — owns every stream | — |
| `platform-observability` | Docker Compose — Grafana/Loki/Prometheus | 3000 |
| `platform-pipelines` | Shared Azure DevOps YAML templates | — |

### Frontends

| Repo | Role | Port |
|---|---|---|
| `shell-frontend` | Module Federation **host** — chrome, auth, routing | 4000 |
| `chatbot-frontend` | remote — streamed AI chat | 4001 |
| `event-store-frontend` | remote — ops UI, event browser, DLQ replay | 4002 |
| `messenger-frontend` | remote — chat, calls, header widget | 4003 |
| `shared-frontend` | Angular library published to a package feed | — |

## A few things worth looking at

- **`.claude/docs/`** — the architecture single source of truth. One doc per
  service, plus platform-wide ones for the NATS topology and the event envelope.
  These are written to be read.
- **`platform-nats/`** — one repo owns every stream and consumer. No service
  creates its own topology on startup, which is what stops two services
  disagreeing about a durable name.
- **`event-store/`** — the events table is partitioned by month, retention drops
  whole partitions, and paging hands over from numbered pages to a keyset cursor
  past a counted cap.
- **`realtime-service/`** — WebRTC signalling, a call-room model with an atomic
  claim, instance heartbeats and an orphan reaper, so a crashed instance cannot
  leave a call marked live forever.

## Running it locally

Everything runs on your machine. No cloud account needed.

**Prerequisites:** Docker (Colima or Docker Desktop), Node 22+ with
`pnpm`, Go 1.25+, Python 3.11+.

### 1. Infrastructure

Postgres, Redis, NATS and a mail catcher come from `_local/docker-compose.yml`:

```bash
cd _local
docker compose up -d postgres redis nats mailpit
docker compose ps          # wait for "healthy"
```

`init-db.sh` creates one database per service on first boot. Add coturn only if
you want a TURN relay for calls — `docker compose up -d coturn`.

### 2. JetStream topology

One repo owns every stream and consumer, so create them before starting
anything that publishes:

```bash
cd platform-nats && pnpm install && pnpm reconcile
```

### 3. Environment files

Every service ships a `.env.example` with working local defaults:

```bash
for d in */; do [ -f "$d/.env.example" ] && cp -n "$d/.env.example" "$d/.env"; done
```

The frontends read `src/environments/environment.dev.ts`, which is not in this
mirror because it holds real OAuth client ids — copy each `environment.ts` to
`environment.dev.ts` and fill in your own if you want to log in.

### 4. Services

Each is its own project. Start the gateway and whichever product you want:

```bash
# Go — vendor/ is not committed, so fetch modules first or -mod=vendor fails
cd api-gateway      && go mod vendor && go run -mod=vendor ./cmd/gateway    # :8080
cd realtime-service && go mod vendor && go run -mod=vendor ./cmd/realtime   # :3004

# Node
cd accounts-service     && pnpm install && pnpm dev                 # :3006
cd notification-service && pnpm install && pnpm dev                 # :3003
cd event-store          && pnpm install && pnpm dev                 # :3002
cd messenger-service    && pnpm install && pnpm dev                 # :3005
cd file-service         && pnpm install && pnpm dev                 # :3001

# Python
cd chatbot-service && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8050 --reload                           # :8050
python -m app.worker                                                # worker
```

### 5. Shared component library — build this first

All four frontends depend on `@datha/platform-ui`, which upstream is published
to a **private package feed**. You cannot install it, so build it from source in
this repo instead — it has no private dependencies of its own:

```bash
cd shared-frontend && pnpm install && pnpm build   # -> dist/platform-ui
```

Then point each frontend at that build before installing:

```bash
cd ../shell-frontend
pnpm add ../shared-frontend/dist/platform-ui   # replaces the feed pin
pnpm install
```

Repeat for `chatbot-frontend`, `event-store-frontend` and `messenger-frontend`.
This is the one place the mirror cannot behave exactly like the real workspace.

### 6. Frontends

The shell is the host; remotes are optional and it degrades gracefully when one
is not running — a missing remote shows an "app unavailable" dialog rather than
breaking the shell.

```bash
cd shell-frontend        && pnpm start              # :4000
cd chatbot-frontend      && pnpm start              # :4001
cd event-store-frontend  && pnpm start              # :4002
cd messenger-frontend    && pnpm start              # :4003
```

Open **http://localhost:4000**.

> Each `ng serve` costs roughly 1–1.5 GB of RAM, so run one product at a time
> unless you have room to spare.

### Tests

```bash
pnpm test                      # Node services and Angular apps
go test ./... -count=1 -cover  # Go services
pytest                         # chatbot-service
```

## Notes

- **Not a monorepo.** Each top-level folder is an independent repository with
  its own history, pipeline and PRs. A change never spans two of them; a
  cross-service feature is coordinated PRs. That constraint is the point, and
  the layout here preserves it.
- **CI/CD is not wired here.** Builds, PR review bots and deployments run in
  Azure DevOps against the real repos. The `azure-pipelines/` folders are
  included so you can see how they are set up.
- **Deployment configuration and secrets are not in this mirror.** The values in
  `_local/docker-compose.yml` are local-only placeholders bound to localhost.

## Freshness

This repository is a **point-in-time copy**, not a live fork. It has a single
commit and no upstream link, so nothing here updates when the real repositories
do — if a date matters to you, the commit date is the one to trust, not the
contents of any document.

Refreshing it means re-exporting every repository's tracked files and committing
the result. Two things make that safe to repeat rather than fiddly: only
**git-tracked** files are copied, so `.env`, `node_modules` and build output stay
out by construction; and the frontends' `environment.dev.ts` is excluded on top
of that, because it carries real OAuth client ids.
