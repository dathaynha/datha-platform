# api-gateway

Thin **Go** auth + routing layer for the chatbot playground. Owns Google OAuth credentials, issues internal JWTs for the browser, validates Bearer tokens at the edge, injects **`X-Owner-ID`**, and proxies to downstream services (`chatbot-service`, `file-service`, `event-store`). Downstream services do **not** use `JWT_SECRET`.

Default port: **8080**.

---

## Prerequisites

- [Go 1.22+](https://go.dev/dl/)

---

## First time setup

```bash
cp .env.example .env
# Fill in GOOGLE_CLIENT_SECRET, JWT_SECRET, CHATBOT_SERVICE_URL
```

Download dependencies and copy them into the local `vendor/` folder:

```bash
go mod tidy
go mod vendor
```

---

## Run locally

```bash
go run -mod=vendor ./cmd/gateway
```

The gateway starts on `http://localhost:8080`. Verify:

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

---

## Build binary

```bash
go build -mod=vendor -o bin/gateway ./cmd/gateway
./bin/gateway
```

---

## Docker

```bash
docker build -t api-gateway .
docker run --env-file .env -p 8080:8080 api-gateway
```

---

## Key routes

| Method | Path                                                | Auth | Description                                                                      |
|--------|-----------------------------------------------------|------|----------------------------------------------------------------------------------|
| `GET`  | `/health`                                           | —    | Health check                                                                     |
| `POST` | `/auth/google/token`, `/auth/entra/token`           | —    | OAuth code exchange; optional `events.gateway.auth.login` when `NATS_URL` is set |
| `ANY`  | `/api/chatbot/*`                                    | JWT  | Proxied to `chatbot-service`                                                     |
| `ANY`  | `/api/files`, `/api/files/*`                        | JWT  | Proxied to `file-service`                                                        |
| `GET`  | `/api/event-store/events`                           | JWT  | event-store query API (list)                                                     |
| `GET`  | `/api/event-store/events/{id}`                      | JWT  | event-store single event by UUID                                                 |
| `GET`  | `/api/event-store/dlq`, `/api/event-store/dlq/{id}` | JWT  | DLQ listing / detail                                                             |
| `POST` | `/api/event-store/dlq/{id}/replay`                  | JWT  | DLQ replay (admin role later)                                                    |

---

## Tests

From the repo root (the root has no Go files — use `./...`):

```bash
go test ./... -count=1 -cover
```

`-count=1` disables Go’s test cache (no silent `(cached)`). `-cover` prints per-package coverage on each `ok` line.

With vendored deps locally:

```bash
go test -mod=vendor ./... -count=1 -cover
```

Detailed report:

```bash
go test ./... -count=1 -coverprofile=coverage.out
go tool cover -func=coverage.out   # summary per function
go tool cover -html=coverage.out     # opens browser heatmap
```

CI bot-review runs the same `go test ./... -count=1 -cover` step.

---

## Environment variables

See **`.env.example`** for the full list with descriptions.

**Events:** set `NATS_URL` (and run NATS + `platform-nats reconcile`) to publish `gateway.auth.login` on sign-in. Token refresh is not published. Query via event-store: `GET /events?type=gateway.auth.login`.

---

## How proxying works

The browser only talks to the gateway. For authenticated API calls, the gateway validates the JWT, injects trusted identity headers, and forwards the request to the upstream service.

```text
Browser → Gateway (:8080) → chatbot-service / file-service / event-store
Browser ← Gateway (:8080) ← upstream response
```

Example — list conversations:

```text
1. Browser:     GET /api/chatbot/v1/conversations
                Authorization: Bearer <internal-jwt>

2. Gateway:     Authenticate middleware verifies JWT
3. Gateway:     Reverse proxy (internal/proxy/proxy.go) forwards to chatbot-service:
                - strips /chatbot from the path → /api/v1/conversations
                - sets X-Owner-ID, X-Correlation-ID (strips any client-supplied identity headers)
                - strips upstream CORS headers on the way back

4. chatbot-service responds; gateway returns JSON to the browser
```

Upstream base URLs come from env (`CHATBOT_SERVICE_URL`, `FILE_SERVICE_URL`, `EVENT_STORE_URL`). Route table and path rewriting: see **`.claude/docs/services/api-gateway-architecture.md`** (Routing, Identity header injection, Design rules).
