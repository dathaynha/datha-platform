# realtime-service

The platform's **one persistent WebSocket** (Go, port **3004**): presence, typing, live message fanout, and — from phase 2 — WebRTC signaling and TURN credentials. Reached through **api-gateway** at `/api/realtime/ws`.

It holds **no domain state**. Messages and conversations belong to `messenger-service`; this service forwards frames and tracks who is connected. Full design: **`services/realtime-service-architecture.md`**.

## Development

```bash
cp .env.example .env      # then point REDIS_URL / NATS_URL / MESSENGER_SERVICE_URL at your locals
go mod vendor             # vendor/ is gitignored, like node_modules
go run -mod=vendor ./cmd/realtime
```

Needs Redis and NATS from `_local/docker-compose.yml`. Identity is the gateway-injected `X-Owner-ID` header and nothing else — there is no JWT code here.

Connect directly while developing (the gateway is not required for the socket itself):

```bash
websocat -H 'X-Owner-ID: google_alice' ws://localhost:3004/ws
```

## Frame protocol

JSON, `{"t": <type>, "id": <optional client id>, "d": <payload>}`.

| Direction | Type | Payload |
|---|---|---|
| S→C | `ready` | `{ owner_id, server_time, presence[] }` — **no unread ids**: the client reads those from `messenger-service`, which keeps this service stateless |
| S→C | `message.new`, `unread.added`, `unread.cleared`, `receipt.read`, `conversation.created` | forwarded verbatim from `rt.owner.<owner_id>` |
| C→S | `presence.subscribe` | `{ owner_ids[] }` — only the owners visible on screen; answered immediately with their current state |
| C→S | `presence.away` | tab hidden. `offline` is never client-reported — it is TTL expiry |
| S→C | `presence` | `{ owner_id, state, at }` |
| C→S | `conversation.open` / `conversation.close` | `{ conversation_id }` — **the membership check**, asked once per opened thread |
| C→S | `typing.start` / `typing.stop` | `{ conversation_id }` — allowed only on an opened conversation |
| S→C | `typing` | `{ conversation_id, owner_id, until, stopped }` — `owner_id` is stamped by the server |
| both | `ping` / `pong` | 25 s keepalive |

Three rules behind that table:

- **The server stamps identity.** A client-supplied `from` is never trusted or echoed.
- **Authorization happens at `conversation.open`**, not per keystroke: a typing frame is refused unless the connection already holds an authorized subscription to that conversation.
- **Malformed or unknown frames get an `error` frame, never a disconnect** — a socket may be carrying a call.

## Routing and scale

Every instance subscribes to `rt.owner.<owner_id>` for each owner it holds a socket for, so **the subscription set is the routing table**: no sticky sessions, no shared connection table, and N tabs of one owner cost one subscription. Core NATS is fire-and-forget by design — a dropped live frame self-heals on the client's next resync, and durability lives in Postgres plus JetStream.

## Presence

`presence:<owner_id>:<conn_id>` in Redis, TTL 45 s, re-armed every 15 s. Per connection rather than per owner, so closing one of five tabs does not mark you offline. An owner is `online` if any connection is, `away` if all are, `offline` once the keys expire.

## Tests

```bash
go test ./... -count=1 -cover        # what bot-review runs, via gotestsum
```

The socket tests drive a **real WebSocket client against the real handler** (`internal/wsapi/server_test.go`) with the bus and Redis faked at their interfaces — frame protocol, authorization refusals, presence transitions and disconnect cleanup are all exercised over the wire rather than asserted on internals.

## CI — bot review

PRs targeting `main`: `azure-pipelines/bot-review.yml` extends `stack-go-gotestsum.yml` from `platform-pipelines` (pinned tag). See **`ci/bot-review-pipelines.md`**.
