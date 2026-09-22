# accounts-service — architecture and phased scope

_Goals, boundaries, and phased scope for accounts-service (platform users/orgs/memberships; OPA reserved for later)_

## Product name / bounded context

**accounts-service** is the platform’s **source of truth** for human-facing account concepts Google/Entra do not manage for you:

- **Workspaces / tenants / orgs** in *your* product sense (stable internal ids — not Entra/Google as system of record).
- **Users** linked to authenticated identities (`owner_id`-style linkage from gateway: `google_*`, `entra_*`, etc.).
- **Memberships** and **roles** (who belongs to which workspace, at what privilege level).

Linguistically “account” includes *account-in-a-org* without implying you replicate or replace customer IdP tenant administration.

## Purpose

Centralize **cross-cutting identity and tenancy data** consumed by chatbot-service, file-service, future APIs, and (later) centralized authorization. Keeps chat/file databases focused on domain data.

## Responsibility boundary

| Does | Does not |
|------|----------|
| Own Postgres (or equivalent) schema for workspaces, platform users, memberships, invitations | Implement OAuth flows, mint primary JWTs, or store IdP `client_secret` (that stays **api-gateway**) |
| Map external identity → platform user (`owner_id`, optional provider metadata) | Parse raw IdP JWTs at the edge (`api-gateway` already normalizes identity) |
| Expose authenticated HTTP APIs + `/health` for directory-style operations | Substitute for Entra/Google account lifecycle inside *their* directories |
| Enforce **ownership** via trusted headers or service-to-service contracts aligned with gateway | Trust browser-supplied `X-Tenant-ID` / org hints without validating membership |

## Relationship to api-gateway today

Until accounts-service ships richer claims:

- Clients still authenticate with **internal JWT from api-gateway** (`owner_id` = `google_<sub>` / `entra_<oid>`).
- accounts-service should treat **`owner_id` (or equivalent claim)** as the primary join key when linking an IdP sign-in to a platform **User**.

Entra **`tid`** and similar claims are optional **hints** stored for auditing / enterprise segmentation — not required to rename the service “directory-service.”

## Data design principles

1. **`tenant_id` / workspace id**: your UUID (or surrogate key), orthogonal to OAuth issuer strings.
2. **External identity**: keyed by normalized provider prefix + stable subject (matching gateway `owner_id` semantics reduces drift).
3. **Membership is explicit**: `(user, tenant, role)` — no inferring tenancy from email alone without policy.
4. **Solo / personal use**: acceptable to auto-provision a one-member workspace; still multi-tenant-capable schema.

---

## Phase 1 — when this repo area is introduced

**Status: built and merged 2026-09-06** — port **3006**, DB `accounts_service_db`, routes `POST /users/me/sync`, `GET /users/me`, `GET /users` (directory search), `GET /users/lookup`, plus `/health` and `/metrics`. Reachable at `/api/accounts/*` through api-gateway, which forwards the JWT `picture` claim as `X-User-Picture` (both merged 2026-09-06). Identity is header-only, and only a non-empty provider value may overwrite a stored name, email or picture — a sign-in that omits one must not blank an existing profile.

**Provisioning gap, found and fixed 2026-09-09.** `POST /users/me/sync` is the *only* thing that creates a user row, and **nothing called it** — every doc said "the shell calls it after login", but no frontend ever did. The symptom was reported as "I couldn't even find a person to chat with": the directory was empty after six successful logins, because a login provisions nothing on its own. `GET /users/me` deliberately does not provision either — it 404s with `User not provisioned`.

Fixed by `shell-frontend`'s `AccountSyncService`, called from `AppComponent.ngOnInit` whenever a session is valid — **on every app start, not only after a fresh login**, because the call is an upsert and that is what makes it self-healing for sessions that predate it or were established while this service was down. Verified live: the POST returned 200 and the row appeared. Two consequences worth remembering:

- **A person is only findable once they have signed in at least once.** There is no way to invite or pre-create someone, so a two-account test needs both accounts to have visited the shell.
- **The directory search parameter is `q`, not `query`** — `GET /users?q=…&limit=…`. A wrong name is not a 400: the schema treats it as absent and the endpoint answers `{"data": []}`, which looks exactly like "no such user".

**Trigger (2026-09-06):** phase 0 of **`products/messenger-architecture.md`**. Messenger needs a user directory before anyone can start a conversation, which is what finally introduces this repo. Provisioning is `POST /users/me/sync` from the shell after login, upserting on the gateway-injected `X-Owner-ID` / `X-User-Email` / `X-User-Name` — deliberately not an extension of `events.gateway.auth.login`, which would push PII into a 90-day event log.

**Do not** implement **OPA-backed authorization** yet.

Instead:

- Build **accounts-service** persistence and APIs needed for onboarding, listing workspaces, memberships, and basic role checks **in-application** (e.g. service-layer checks against DB, or coarse RBAC middleware).
- Keep policy decisions **simple and localized** until OPA rollout is deliberate.
- Design modules (or bounded packages) so **policy evaluation can be swapped or delegated later** without rewriting schema.

Defer: Rego bundles, bundle CI, PEP integration in every downstream service, and “authorize everything via OPA” until the segment below is explicitly unlocked.

---

## Future — Open Policy Agent (OPA)

> **Activation rule:** enabling this segment is an explicit architecture decision — not part of Phase 1.

### Intent

Use **OPA** as (or beside) the **policy decision point (PDP)** for uniform **authorization** across services: conversations, files, admin actions, quotas, cross-tenant denies.

### Division of labour (target state)

| Component | Responsibility |
|-----------|----------------|
| **accounts-service** | **Facts**: tenants, memberships, roles, coarse attributes OPA queries or that callers pass as `input` after lookup |
| **OPA** | **Decisions**: allow/deny from Rego + `input` (subject, action, resource, tenant, structured claims) |
| **PEPs** | api-gateway, chatbot-service, file-service — enforce by calling OPA (or authz façade) **after** resolving identity |

accounts-service remains the **canonical store for membership-shaped facts** unless you later introduce a replicated read model for latency.

### Non-goals (even when OPA arrives)

- OPA replaces **authentication** — it does **not**; JWT issuance stays at **api-gateway**.
- OPA replaces **accounts DB** — it does **not**; policies **read** curated data, they don’t permanently own memberships.

### Implementation notes for later agents

1. Prefer **explicit `input`** contracts (documented schemas) shared between PEPs and Rego writers.
2. Version **policy bundles** independently of accounts-service deployments.
3. Never trust **tenant scoping from the browser alone** — always derive from JWT + membership (or signed token claims refreshed from accounts-service).

Until OPA lands, preserve **hooks** only as clean internal seams (interfaces, todo comments sparingly — prefer clear module names over noise).

---

