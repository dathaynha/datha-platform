# accounts-service

Platform source of truth for **users, workspaces and memberships** — the identity facts that Google and Entra do not model for you. Port **3006**.

Architecture and phased scope: `.claude/docs/services/accounts-service-architecture.md`.
The product that introduced it: `.claude/docs/products/messenger-architecture.md`.

## What it owns

| Does | Does not |
|---|---|
| Platform users keyed by the gateway's `owner_id` (`google_<sub>` / `entra_<oid>`) | OAuth flows or JWT issuance — that stays in `api-gateway` |
| Workspaces and memberships | Replace the IdP's own directory |
| Directory search and batch user lookup for other services | Authorization decisions (OPA later; in-app membership checks today) |

## Identity comes from headers, never from the body

Every route reads the gateway-injected `X-Owner-ID` / `X-User-Email` / `X-User-Name`. The gateway strips client-supplied copies before forwarding, so a caller cannot claim another identity. There is no JWT code in this service.

`POST /users/me/sync` upserts the caller from those headers, including `X-User-Picture` for the avatar. Non-empty values only ever overwrite stored ones — a provider that stops sending a display name or picture must not blank an existing profile, and the derived name fallback is used on insert only.

## Directory visibility

A user is visible to a caller only if they **share a workspace**. Phase 0 puts every signed-in user in one shared workspace (`DEFAULT_WORKSPACE_SLUG`), because solo workspaces would make the directory empty and no conversation could ever start. The schema stays multi-tenant, so splitting into real tenants later is data rather than a change of shape.

## API

All routes require `X-Owner-ID`. `GET /health` and `GET /metrics` do not.

| Route | Purpose |
|---|---|
| `POST /users/me/sync` | upsert the caller, join the default workspace, return profile + workspaces |
| `GET /users/me` | current profile + workspaces; `404` before the first sync |
| `GET /users?q=&limit=` | directory search within the caller's workspaces, caller excluded |
| `GET /users/lookup?owner_ids=a,b,c` | batch hydration for participant lists (max 100) |
| `GET /health` | `{"status":"ok"}` |
| `GET /metrics` | Prometheus exposition |

Reached through the gateway as `/api/accounts/*`.

## Local development

```bash
docker exec -it datha_platform_db createdb -U postgres accounts_service_db
cp .env.example .env
pnpm install
pnpm migrate:dev
pnpm dev
```

`pnpm test` runs vitest, `pnpm knip` the dead-code gate — both are what bot-review runs.

## Not built yet

No NATS dependency: this service publishes no events in phase 0. When user lifecycle events are needed, they follow the standard envelope (`.claude/docs/platform/event-store-architecture.md`) and the durable belongs to `platform-nats`.
