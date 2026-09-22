# Chatbot architecture

_Cross-service chat flow for chatbot-frontend and chatbot-service_

## Scope

Use this rule when changing the chat UI or `chatbot-service` behavior. For focused details, prefer the narrower rules:

- `lang/lang-angular.md` for general Angular conventions.
- `lang/lang-python-fastapi.md` for general Python / FastAPI conventions.
- `services/chatbot-frontend-architecture.md` for chatbot frontend product behavior, specs, routes, and hosted/standalone workflows.
- `services/chatbot-service-architecture.md` for chatbot-service business rules, message workflow, Redis Streams, ownership, and worker flow (NATS: pointer to `platform/chatbot-file-events.md`).
- `services/api-gateway-architecture.md` for auth, proxying, stream-token injection, and trusted headers.
- `services/file-service-architecture.md` for file metadata, Azure Blob SAS URLs, and direct upload/download flows (conversation cleanup: pointer to `platform/chatbot-file-events.md`).
- **`platform/chatbot-file-events.md`** — **canonical** end-to-end spec: conversation delete → orphan `file_ids` → file-service consumer (pull, DLQ). **Do not duplicate** this narrative in other rules.
- `platform/event-store-architecture.md` for event envelope, JetStream topology (`EVENTS` / `DLQ`), event-store ingest.

## Product goal

Build a production-style chat system: Angular client, Go API Gateway, FastAPI chatbot service, Postgres message history, async generation through Redis queue/worker, SSE token streaming to the browser, and **durable cross-service events** (NATS JetStream, **event-store**, orphan-safe file cleanup).

## Core chat flow

```
Browser
  -> POST /api/chatbot/v1/messages
     api-gateway validates Bearer JWT and injects X-Owner-ID
     chatbot-service persists the user message, enqueues Redis job
     api-gateway adds stream_token to the response
  <- { job_id, conversation_id, stream_token }

Browser
  -> GET /api/chatbot/v1/stream/{job_id}?stream_token=...
     api-gateway validates stream_token and injects X-Owner-ID
     chatbot-service reads Redis Stream chatbot:events:{job_id}
  <- SSE events with id:{redis_entry_id} and data:{chunk}

Worker
  -> BLPOP chatbot:jobs
  -> stream Gemini response into Redis Stream
  -> persist assistant message in Postgres
```

## Attachments, briefly

The browser uploads file bytes through `file-service` using Azure Blob SAS URLs before sending the chat message. Chat messages carry file references only, e.g. `file_id`, `name`, and `mime_type`; `chatbot-service` never receives raw upload bytes.

When the worker needs file content, it asks `file-service` for a download SAS URL using the trusted `X-Owner-ID` path, then sends Gemini REST parts with snake_case fields such as `inline_data` and `mime_type`.

## Conversation delete and attachments

**Canonical spec (single file, no duplicated prose elsewhere):** **`platform/chatbot-file-events.md`**. **Broker / envelope:** **`platform/event-store-architecture.md`**.

## Stream re-attach on revisit (built 2026-08-17)

Worker keeps generating when the user navigates away (job-based, detached), but revisiting the conversation shows nothing until done. The server side is ~90% there: chunks live in a Redis Stream and `GET /stream/{job_id}` already replays from `Last-Event-ID` "0", so a re-opened stream rebuilds the partial answer. Plan (3 repos, PR order chatbot-service → api-gateway → chatbot-frontend):

1. **chatbot-service** — on enqueue set `conv_active_job:<conversation_id> = job_id` (TTL = `job_meta_ttl_seconds`; no worker change — stale keys are filtered by the status check). New owner-checked endpoint `GET /conversations/{id}/active-job`: key → job meta → return `{job_id, user_message_id, status}` when status is pending/processing, else 204.
2. **api-gateway** — intercept that route's success response and inject `stream_token` (jti = job_id), same pattern as the POST /messages interception. Ownership stays service-enforced; the gateway never mints tokens for unverified jobs.
3. **chatbot-frontend** — on conversation load call active-job; when present, render the pending assistant bubble and `openStream(job_id, token)` — replay-from-0 rebuilds text so far, live chunks continue; existing done/error handling reused.

Tests: service endpoint (owner isolation, stale-key 204, pending vs processing), gateway interception, `ConversationService.activeJob` spec (job passthrough, 204 → null, id encoding).

**As built — three details the plan did not cover:**

1. **Duplicate-answer guard.** If the job finishes between the history load and the active-job lookup, the answer is in both history and the replayed stream. On `done`, when another bubble already carries the same `assistant_message_id`, the placeholder is dropped instead of renamed.
2. **204 has no body.** The gateway's token injection skips `204` and forwards it without `Content-Type`/`Content-Length`, so nothing tries to parse an empty body. Injection is shared by `POST /messages` and active-job via `streamTokenInjectingHandler`.
3. **Re-attach sets the pending visuals**: `busy` on, `pendingStage` from job status (`processing` → thinking, `pending` → queued), and the stream is tied to `cancelOutbound$` + `threadLoadSeq` so switching threads mid-replay cancels cleanly. A stream that 404s (expired) removes the placeholder silently.

No worker change: `conv_active_job:<conversation_id>` is written at enqueue with the `job_meta_ttl_seconds` TTL, and status filtering plus a `conversation_id` match in the job meta discard stale keys.

### Chunk rendering is batched per frame (2026-08-17)

Throttled-network testing showed the catch-up burst rendering unevenly. Cause was render cost, not bandwidth: every SSE chunk ran its own signal update **and** its own `requestAnimationFrame` scroll, so a TCP-sized burst (or a replay backlog) meant dozens of state updates and forced layouts in one frame.

- `StreamChunkBatcher` (`helper/stream-chunk-batcher.helper.ts`) accumulates chunk text per bubble and applies it once per frame in a single `bubbles.update`.
- `scrollThreadToEnd()` is coalesced by an in-flight rAF handle — repeated calls in one frame collapse to one layout.
- `flushNow()` runs before `done` finalizes (so a missing `full_text` cannot lose buffered text); `cancelPending()` runs on `error`, thread switch, clear, and teardown, so buffered chunks never paint into a different thread.

Both fixes apply to normal streaming too, not just re-attach. Server-side replay coalescing and a snapshot+cursor endpoint were considered and rejected as unnecessary — the bottleneck was client render, and both would add API surface (a snapshot needs its cursor threaded through, and `EventSource` cannot send `Last-Event-ID`).

## Generation retry (built 2026-08-27)

A transient provider blip used to burn the user's whole turn: `gemini-flash-latest`
returned `503 UNAVAILABLE` ("model experiencing high demand") repeatedly during the
2026-08-27 verification, and each 503 became a terminal error bubble. The worker called
Gemini exactly once. Two layers now cover it, plus the model pin the same 503s argued for.

### Layer 1 — worker-side retry, inside the job

`chatbot-service` retries before publishing an error, so the SSE contract and stream
re-attach are unaffected. Rules, statuses, backoff, metrics:
**`services/chatbot-service-architecture.md`** § Generation retry.

The one constraint worth repeating across services: **retry only before the first
chunk**. Re-attach replays the Redis Stream from entry 0, so retrying after deltas were
published would duplicate text in the rebuilt answer.

`chatbot-frontend` renders the new `retrying` frame as a pending stage —
`pendingStage() === "retrying"` with `CHAT.PENDING_RETRYING` ("Service busy — retrying
(2/3)") — instead of a bubble that looks frozen. `MessageStreamService` must **not**
complete on `retrying`; only `done` and `error` end the stream.

Live confirmation the day it shipped: a retry job took `503 → 503 → 200`, backing off
0.9 s then 1.5 s. E2E covers the UI of it via the `liveSse` harness (retry progress on an
open stream, and exhausted retries falling through to the error bubble) — see
`testing/e2e-testing-strategy.md`.

### Layer 2 — user-visible "Try again"

For failures that survive the backoff.

1. **chatbot-service** — `POST /conversations/{id}/retry-last` re-enqueues the **existing**
   user turn (no second user message), deletes the dead assistant row, 409 while a job is
   running. Contract: **`services/chatbot-service-architecture.md`** § Generation retry.
2. **api-gateway** — `retryLastHandler` reuses `streamTokenInjectingHandler`, so the
   response carries a `stream_token` exactly like `POST /messages`.
3. **chatbot-frontend** — the error bubble carries `retryable`, and only the **newest**
   error bubble (while not busy) shows the `CHAT.RETRY` button. `retryLast()` posts, then
   opens the returned job's stream through the same `streamJobIntoNewBubble` path as a
   send. Client-side failures (attachment rejected, `POST /messages` never landed) leave
   `retryable` unset — `retry-last` would re-run an unrelated turn.

**Not a NATS redelivery.** Layer 1 is in-process attempts against Gemini and layer 2 is a
new job; neither touches `max_deliver`/DLQ, which stay owned by
**`platform/platform-nats-architecture.md`**.

### Model pin (shipped with layer 1)

`gemini-3.6-flash` (chat) and `gemini-3.5-flash-lite` (titles), pinned explicitly rather
than tracking `-latest`. Evidence table and the constants that must move together:
**`services/chatbot-service-architecture.md`** § Gemini model ids.

## Chat design rules

1. Persist the user message before enqueueing a job; persist the assistant message when streaming completes or fails.
2. Use Redis Streams for SSE chunks so reconnects can resume from `Last-Event-ID`.
3. Treat Postgres as the source of truth; Redis holds live queue and stream state only.
4. Always scope conversations and messages by `owner_id` from `X-Owner-ID`; do not parse JWTs in `chatbot-service`.
5. Propagate `X-Correlation-ID` through request handling, queued jobs, worker logs, downstream calls, and **NATS event envelopes** where applicable.
6. Keep the worker idempotent enough for at-least-once job delivery.
