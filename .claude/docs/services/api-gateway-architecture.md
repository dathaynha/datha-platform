# api-gateway — architecture and design rules

_Architecture, responsibility boundary, and design rules for the api-gateway service_

## Purpose

Thin **auth + routing** layer written in **Go** (**chi** router, **slog** JSON logging). Sole owner of all identity provider credentials. Acts as an **IdP-agnostic token normalizer**: accepts tokens from any supported provider, validates them, and issues a single unified internal JWT for the **browser**. Downstream services trust **`X-Owner-ID`** injected after JWT validation — they do **not** share `JWT_SECRET`. Does **not** contain business logic.

## Responsibility boundary

| Does | Does not |
|------|----------|
| Proxy Google OAuth code exchange (injects `client_secret`) | Proxy large file upload bodies |
| Proxy Azure Entra PKCE code exchange (SPA; forwards `Origin`) | Store any user data |
| Parse IdP `id_token`, build prefixed `owner_id` | Know about chat, messages, or files semantics |
| Issue unified internal JWTs for all providers | Run business logic |
| Validate internal JWTs on authenticated routes | |
| Inject `stream_token` into every chatbot response carrying a `job_id` (`POST /messages`, `active-job`, `retry-last`) | |
| Route requests to downstream services with identity headers | |
| Publish **`events.gateway.auth.login`** on successful OAuth code exchange (optional `NATS_URL`) | Publish on token refresh (too noisy) |
| Expose `/health` endpoint | |

## Multi-provider auth model

### Unified user identity

Every internal JWT carries a prefixed `owner_id` that namespaces the provider:

```
google_<google_sub>         e.g. google_110234567890
entra_<azure_oid>           e.g. entra_aad89f23-4d1e-49f6-...
```

Use `oid` (not `sub`) for Azure — `oid` is stable across tenants for multi-tenant apps.

### Provider flows

| Provider | Endpoint | Gateway action |
|----------|----------|----------------|
| **Google** | `POST /auth/google/token` | Proxies OAuth token exchange to Google (`authorization_code`, `refresh_token`); injects `client_secret` for code exchange → parse ID token → issue internal JWT |
| **Azure Entra** | `POST /auth/entra/token` | Proxies PKCE exchange to Entra (`authorization_code`, `refresh_token`; no `client_secret`). **Forwards `Origin`**. Selects token endpoint from login pool → parse `id_token` → **tenant allowlist** → issue internal JWT |

Both endpoints are public (no Bearer required). Angular's `angular-oauth2-oidc` library uses `tokenProxyUrl` to route the token exchange here instead of directly to the IdP.

**`refresh_token` grant:** supported for Google and Entra (SPA silent refresh). Returns IdP tokens + internal JWT as `access_token`. **Does not** publish `events.gateway.auth.login` (publisher filters to `grant_type=authorization_code` only).

> **Entra note**: Azure SPA app registrations enforce that auth codes are redeemed via cross-origin requests (AADSTS9002327). The gateway forwards the `Origin` header from the incoming Angular request to satisfy this check.

### Entra tenant allowlist

After parsing the Entra `id_token`, the gateway checks `tid` against **`AZURE_ALLOWED_TENANT_IDS`** (comma-separated directory GUIDs). If unset, **`AZURE_TENANT_ID`** seeds a single allowed tenant. Reject sign-in with **403** when `tid` is not allowlisted (`config.EntraTenantAllowed`).

### Entra login pool (organizations vs consumers)

The SPA sends **`X-Microsoft-Login-Pool`** (`organizations` \| `consumers`) on the token proxy request (CORS-allowed). Fallback: form field `login_pool`. Gateway calls `auth.EntraTokenURLForLoginPool` — e.g. `…/organizations/oauth2/v2.0/token` or `…/consumers/oauth2/v2.0/token`. On successful auth-code login, optional event payload field **`entra_login_pool`** mirrors the pool used.

### ExternalUser — normalized identity from all providers

```go
type ExternalUser struct {
    OwnerID string // prefixed: "google_<sub>" | "entra_<oid>"
    Email   string
    Name    string
    Picture string
}
```

Use `oid` (not `sub`) for Azure — `oid` is stable across tenants for multi-tenant apps.

## Internal JWT claims

```
sub      = owner_id (e.g. "google_110234567890") — provider inferred from prefix (google_ | entra_)
email    = user email
name     = display name
picture  = profile picture URL (Google; often empty for Entra)
iat, exp
```

**No `provider` claim** in the JWT — downstream services use prefixed `sub` / `X-Owner-ID` only. **`provider`** appears in the **`events.gateway.auth.login`** payload, not in the Bearer token.

### ⚠️ The frontend's `owner_id` is in the **access token**, never the `id_token`

The token response returns **two different subjects**, and only one of them is
an `owner_id`:

| Token | `sub` | Use |
|-------|-------|-----|
| `access_token` (**gateway-minted**) | `google_<sub>` / `entra_<oid>` — **the `owner_id`** | Bearer on every API call; the value services see as `X-Owner-ID` |
| `id_token` (**the IdP's, passed through untouched**) | the raw provider subject, **no prefix** | `angular-oauth2-oidc` identity/OIDC validation, display name, email |

The gateway deliberately preserves the provider's `id_token` so the Angular
OAuth library can still validate identity, which means
`oauthService.getIdentityClaims().sub` is **not** an `owner_id` and matches no
participant, sender or presence key anywhere in the platform.

Getting this wrong fails *silently* rather than loudly — nothing 401s, the id
simply never equals anything. In `messenger-frontend` it shipped as three
unrelated-looking bugs at once (found 2026-09-10): a direct conversation showed
the **same** name to both people (the "which of these two is me?" test answered
"neither", so the UI picked the first participant for everyone), your own
typing indicator was echoed back at you, and your own messages were rendered as
though the other person had sent them.

Frontends must read `sub` from the **access token** —
`messenger-frontend/src/helper/owner-id.ts` (`ownerIdFromAccessToken`) is the
reference implementation. Resolve it inside the service that needs it rather
than having each component pass it in: the header widget never called
`setOwnerId` at all, so the store believed it was nobody from login onwards.

## Identity header injection (X-Owner-ID)

After JWT validation, the proxy **injects** the user identity as trusted headers before forwarding — downstream services never parse a JWT:

| Header | Value | Example |
|--------|-------|---------|
| `X-Owner-ID` | `claims.Subject` (prefixed owner_id) | `google_110234567890` |
| `X-User-Email` | `claims.Email` | `user@example.com` |
| `X-User-Name` | `claims.Name` | `Dat Ha` |
| `X-User-Picture` | `claims.Picture` | `https://lh3.googleusercontent.com/…` (usually empty for Entra) |

**Critical**: the proxy **strips** any client-supplied `X-Owner-ID`, `X-User-Email`, `X-User-Name`, `X-User-Picture` before injecting the validated values, preventing header spoofing. Every header added here must be added to the strip list in the same edit — an injected header that is not stripped first is a spoofing hole, not a convenience.

Downstream services read only `X-Owner-ID` to scope data — zero JWT code in any service.

## SSE stream_token

`EventSource` (browser native API) cannot set custom headers — it cannot pass `Authorization: Bearer`. The gateway solves this with a short-lived **stream token**:

1. `messagesHandler` intercepts `POST /api/chatbot/v1/messages`, forwards to `chatbot-service`, captures the response. `activeJobHandler` (`GET /conversations/{id}/active-job`, for stream re-attach) and `retryLastHandler` (`POST /conversations/{id}/retry-last`) are the same `streamTokenInjectingHandler` — **every chatbot response that names a `job_id` must be routed through it**, and registered *before* the `/api/chatbot/*` wildcard or the wildcard swallows it. A 204 (nothing running) passes through untouched.
2. On 2xx, it calls `auth.SignStreamToken(jobID, ownerID, secret, ttl)` — an HS256 JWT with `sub=ownerID` and `jti=jobID`.
3. The token is injected into the response JSON as `stream_token`. `Content-Length` is recalculated.
4. `streamHandler` receives `GET /api/chatbot/v1/stream/{jobID}?stream_token=<token>`.
5. It calls `auth.VerifyStreamToken(token, jobID, secret)` — validates signature, expiry, and `jti == jobID`.
6. The extracted `ownerID` is placed in the request context via `middleware.WithOwnerID`; the proxy `Director` picks it up and sets `X-Owner-ID` on the upstream request.
7. `stream_token` is stripped from the query before forwarding upstream.

The notification stream reuses the same machinery with a **fixed scope instead of a job id**: `GET /api/notifications/stream-token` (JWT-protected) signs a token with `jti="notifications"`; public `GET /api/notifications/stream` verifies it and proxies to notification-service (`platform/platform-notifications.md`).

## Messenger routes (phase 1, added 2026-09-08)

| Route | Auth | Notes |
|---|---|---|
| `/api/messenger`, `/api/messenger/*` | Bearer JWT | ordinary proxy; `/api/messenger` is stripped, so `/api/messenger/conversations` → `/conversations` on `messenger-service` (:3005) |
| `GET /api/realtime/token` | Bearer JWT | mints a stream token with `jti="realtime"` and **TTL 90 s** (`REALTIME_STREAM_TTL_SECONDS`), the third use of the pattern after chatbot and notification SSE |
| `GET /api/realtime/ws` | stream token in the query | upgrade-capable proxy to `realtime-service` (:3004); validates `Origin`, verifies the token, strips it from the query, injects `X-Owner-ID` |
| `GET /api/realtime/turn-credentials` | Bearer JWT | plain proxy to `realtime-service`, which signs a five-minute TURN credential for the injected `X-Owner-ID`. **Listed explicitly, not as `/api/realtime/*`** — a wildcard would also expose that service's `/health` and `/metrics`. Added 2026-09-09 (phase 2) |

Three things about that last row are load-bearing:

- **`Origin` is validated here because a WebSocket upgrade gets no CORS preflight.** The browser sends no `OPTIONS` and honours no `Access-Control-Allow-Origin`, so the CORS middleware that guards every other route does nothing for the socket. Without this check, any page on the internet holding a stolen stream token could open it. An **absent** `Origin` is allowed: browsers always send one on an upgrade, so a request without it is a non-browser client, which is not the threat.
- **The token TTL is 90 s, not the JWT's hour.** It travels in a query string, and query strings land in access logs and proxy telemetry; it is only needed at the moment of connect. The client mints a fresh one on every reconnect attempt.
- **`MESSENGER_SERVICE_URL` and `REALTIME_SERVICE_URL` default rather than being required.** Adding a required var breaks every existing `.env` on the next pull — which is exactly how the gateway failed to boot on 2026-09-06 when `ACCOUNTS_SERVICE_URL` was added. Unset now logs a warning and falls back to the localhost port.

`CORS_ORIGINS` gained `4002`/`4003` in `.env.example`: it is now also the socket's origin allowlist, so any frontend that opens the socket directly must be listed.

## Routing

| Pattern | Strips | Upstream |
|---------|--------|----------|
| `/api/chatbot/*` | `/chatbot` | `chatbot-service` |
| `/api/files`, `/api/files/*` | strip `/api` prefix | `/files`, `/files/*` on file-service |
| `/api/event-store`, `/api/event-store/*` | strip `/api/event-store` | `/events`, `/dlq`, … on event-store (JWT today; **admin role later** — see `platform/platform-nats-architecture.md` future table) |
| `/api/accounts`, `/api/accounts/*` | strip `/api/accounts` | `/users/me/sync`, `/users`, `/users/lookup` on accounts-service (`services/accounts-service-architecture.md`) |

Path strip ensures each upstream keeps its own `/api/v1/...` routes unchanged.

## Design rules

1. **Prefixed `owner_id`**: always build `owner_id` as `<provider>_<stable_id>` before issuing the internal JWT (`google_<sub>` / `entra_<oid>`).
2. **Stream token scoping**: `stream_token` binds `job_id + owner_id`; `VerifyStreamToken` must reject tokens where `jti != expectedJobID`.
3. **Strip upstream CORS headers**: the gateway is the sole CORS owner; strip all `Access-Control-*` headers from upstream responses in `ModifyResponse`.
4. **Recalculate Content-Length** when modifying a proxied response body (e.g. injecting `stream_token`) — stale `Content-Length` causes browsers to truncate the body.
5. **Correlation IDs**: attach `X-Correlation-ID` (generate if absent) on every proxied request; log method, path, status, duration, and correlation ID.
6. **Never leak upstream errors**: proxy `ErrorHandler` returns `{"error":"upstream unavailable"}` only; log the real error server-side.
7. **Config via env only**: no config files committed with real values.
8. **ResponseWriter wrappers must forward `Flush()` and `Unwrap()`** (see `middleware.responseRecorder`): a wrapper that only embeds `http.ResponseWriter` hides the flusher, the reverse proxy can't flush, and SSE responses stall in the 4 KB write buffer (badge/toast dead, chatbot tokens arriving in bursts — found 2026-08-03).
9. **NATS publish is non-blocking**: after internal JWT is issued on **`grant_type=authorization_code`**, publish **`events.gateway.auth.login`** (standard envelope — **`platform/event-store-architecture.md`**). If `NATS_URL` is unset or broker is down, log and still return the token response. **No outbox** in gateway (low volume). **No `gateway.auth.logout`** — SPA logout is client-only unless a logout API is added later.

## Platform events (gateway)

| Subject | When | Payload (minimum) |
|---------|------|---------------------|
| `events.gateway.auth.login` | Google/Entra code exchange succeeds → internal JWT issued | `provider` (`google` \| `entra`), `grant_type`; Entra: optional `entra_tenant_id`, `entra_login_pool` |

Ingested by **event-store** on stream **`EVENTS`**. Broker topology: **`platform/platform-nats-architecture.md`**.

## Key env vars

| Var | Purpose |
|-----|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth client id (required for exchange; boot validates secret/upstreams, not client id) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `AZURE_CLIENT_ID` | Azure Entra SPA app (client) id |
| `AZURE_ALLOWED_TENANT_IDS` | Comma-separated Entra **tenant GUIDs** (`tid` from `id_token` must match). If unset, **`AZURE_TENANT_ID`** is the only allowed tenant |
| `AZURE_TENANT_ID` | Home / default tenant GUID — seeds allowlist when `AZURE_ALLOWED_TENANT_IDS` is omitted |
| `JWT_SECRET` | Sign/verify SPA internal JWTs **and** stream tokens (**gateway only** — not in downstream `.env`) |
| `JWT_TTL_SECONDS` | Internal JWT + stream token lifetime (default `3600`) |
| `CHATBOT_SERVICE_URL` | Upstream base URL for chatbot-service |
| `FILE_SERVICE_URL` | Upstream base URL for file-service |
| `EVENT_STORE_URL` | Upstream base URL for event-store (ops query + DLQ replay) |
| `ACCOUNTS_SERVICE_URL` | Upstream base URL for accounts-service (users, workspaces, directory) |
| `NATS_URL` | Optional JetStream URL for `gateway.auth.login` publish (e.g. `nats://localhost:4222`) |
| `CORS_ORIGINS` | Comma-separated allowed origins (include shell + remote dev ports, e.g. 4000, 4001) |
| `PORT` | Listen port (default `8080`) |

## Repo map

- `cmd/gateway/main.go` — entrypoint; registers all routes, `messagesHandler`, `streamHandler`
- `internal/auth/google.go` — Google token exchange + ID token parsing
- `internal/auth/entra.go` — Entra PKCE proxied exchange + ID token parsing (forwards `Origin`; login pool token URL)
- `internal/auth/idtoken.go` — shared Google ID token claim parsing
- `internal/auth/jwt.go` — `ExternalUser`, `IssueToken`, `VerifyToken`
- `internal/auth/jwt_common.go` — internal JWT HMAC helpers (SPA + stream token)
- `internal/auth/stream_token.go` — `SignStreamToken` / `VerifyStreamToken` (scoped SSE tokens)
- `internal/proxy/proxy.go` — reverse proxy; path rewriting, header injection, CORS stripping
- `internal/middleware/auth.go` — JWT auth middleware; `WithOwnerID` / `OwnerIDFromContext` for stream routes
- `internal/middleware/correlation.go` — `X-Correlation-ID` propagation
- `internal/middleware/logger.go` — structured request logging
- `internal/config/config.go` — env loading and validation
- `internal/events/` — platform envelope + `gateway.auth.login` publish
- `internal/natsclient/` — optional JetStream connect
