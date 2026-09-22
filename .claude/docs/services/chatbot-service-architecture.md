# `chatbot-service` architecture and workflow

_Architecture, business workflow, and service rules for chatbot-service_

Generic Python / FastAPI best practices are in **`lang/lang-python-fastapi.md`**. This rule records chatbot-service-specific business rules, message workflow, Redis Streams (SSE), ownership, and worker flow. **Conversation delete → NATS → orphan file cleanup** is specified only in **`platform/chatbot-file-events.md`** — link there; do not copy that flow here.

## Stack

- FastAPI, SQLAlchemy (async + asyncpg), Alembic, Redis (queue + **Streams** for SSE), `google-generativeai` (Gemini).
- **NATS JetStream** — used for platform business events (e.g. conversation deleted). **Redis** remains the job queue and SSE transport. **Choreography and payloads:** **`platform/chatbot-file-events.md`**; **envelope and broker streams:** **`platform/event-store-architecture.md`**.

## Layout

- `app/routers/` — route handlers (thin).
- `app/schemas/` — Pydantic v2 models.
- `app/services/` — business logic.
- `app/dependencies/` — shared FastAPI `Depends()` helpers (e.g. `identity.py`).
- `app/core/config.py` — env / settings via `pydantic-settings`.
- `alembic/` — all schema migrations (never `create_all` on startup).

## Identity / ownership

The **api-gateway** validates JWTs and injects `X-Owner-ID` (e.g. `google_<sub>`, `entra_<oid>`) before proxying. **This service never parses JWTs.**

- Use `Depends(get_owner_id)` from `app/dependencies/identity.py` to read the header.
- Every query that touches user data **must** filter by `owner_id`.
- The `Conversation` model carries `owner_id`; always set it from `get_owner_id` on creation.

## Redis Streams (SSE)

- Worker writes chunks with `redis.xadd("chatbot:events:{job_id}", {"data": json}, maxlen=1000, approximate=True)`.
- Worker calls `redis.expire(stream_key, job_meta_ttl_seconds)` after every `xadd` for crash-safe TTL.
- Event types on the stream: **`claimed`** (worker picked the job — first event, renders nothing), `chunk`, **`retrying`** (`{attempt, max_attempts}` — provider blip before the first chunk, job still alive), `done`, `error`. The frontend stream watchdog (chatbot-frontend `MessageStreamService`) times out after 30 s without a first event / 90 s idle — SSE keepalive comments do not reset it. Never remove the `claimed` emit without syncing those timeouts.
- SSE endpoint reads with `redis.xread(streams={key: cursor}, count=50, block=30_000)`.
- Each SSE event must include `id: {entry_id}` so the browser can send `Last-Event-ID` on reconnect.
- `stream_token` is generated and injected by the **api-gateway** into every response that names a `job_id` (`POST /messages`, `GET .../active-job`, `POST .../retry-last`) — this service does not generate or validate stream tokens.

## NATS (conversation → files)

**Single source of truth:** **`platform/chatbot-file-events.md`**. Implement: `NATS_URL`, connect in **lifespan**, publish **`events.chatbot.conversation.deleted`** only **after** successful delete commit, non-blocking on broker failure — details and payload contract are **only** in that file.

**Publish outbox:** Postgres **`event_outbox`** + API drain loop (see **`platform/chatbot-file-events.md`**) — not JetStream DLQ. Also publishes **`events.chatbot.message.sent`** (user via API, assistant via worker outbox enqueue).

**Orphan reconcile CLI:** `python -m app.reconcile_orphans` (dry-run default) · `--execute` to publish. Standalone — does not require uvicorn. Spec: **`platform/chatbot-file-events.md`** (*Orphan reconcile*).

## Port

- API runs on **8050** (avoid 5060/5061 — Chrome blocks those as unsafe ports for `http://`).

## Key env vars

See **`.env.example`** for the full list. Critical names:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres (async API + worker) |
| `REDIS_URL` | Job queue + SSE Streams |
| `NATS_URL` | JetStream publish + outbox drain |
| `FILE_SERVICE_URL` | Worker fetches SAS download URLs (internal, `X-Owner-ID`) |
| `GEMINI_API_KEY` | Worker chat generation |
| `EVENT_OUTBOX_*` | Outbox poll batch / backoff when NATS was down |
| `CHAT_DEFAULT_MODEL` / `GEMINI_TITLE_MODEL` | Pinned model ids (see § Gemini model ids) |
| `CHAT_MODEL_ALLOWLIST` | Empty = Google `models.list`. If set it **must** contain `CHAT_DEFAULT_MODEL` |
| `GENERATION_RETRY_*` | Worker retry attempts / base delay / max delay (see § Generation retry) |

No `JWT_SECRET` — this service trusts **`X-Owner-ID`** from api-gateway only.

## Generation retry (built 2026-08-27)

Two independent layers. Cross-service narrative: **`products/chatbot-architecture.md`**
§ Generation retry.

**Layer 1 — worker-side, inside the job.** `app/worker.py` loops
`_attempt_generation` up to `generation_retry_attempts` (default 3).

- Retryable = `429/500/502/503/504` or an `httpx.TransportError`. Classification lives on
  `NormalizedGenerationError.retryable` in `services/generation_errors.py`, next to the
  parsing it depends on. `400/401/403/404` never retry — a bad model id or revoked key
  will not fix itself.
- **Only before the first chunk** (`not full_text`). Once deltas are in the Redis Stream a
  retry would duplicate text for a client replaying from entry 0, which is exactly what
  stream re-attach does. A mid-stream break fails as before.
- Backoff: full-jitter exponential from `generation_retry_base_delay_seconds`, capped by
  `generation_retry_max_delay_seconds` (8 s). `Retry-After` (header) and
  `google.rpc.RetryInfo.retryDelay` (429 body) win when present, capped the same way —
  a longer wait than the frontend's 30 s first-event watchdog would read as a hang.
- Emits `{"type": "retrying", "attempt": n, "max_attempts": m}` so the client shows
  progress instead of a frozen bubble.
- **Not NATS redelivery.** These are in-process attempts against Gemini; the job is
  consumed once. `max_deliver`/DLQ semantics stay owned by
  **`platform/platform-nats-architecture.md`**.
- Metrics: `JOBS_TOTAL` gains `retried` (one extra attempt) and `retry_exhausted` (still
  failed after retrying — also counted as `generation_failed`).

**Layer 2 — `POST /conversations/{id}/retry-last`.** Re-runs the last user turn; never
creates a second user message.

- Owner-checked before any Redis read (404). 409 while a job for the conversation is
  still `pending`/`processing` — via `claim_conversation_slot`, a Lua script that checks
  the `conv_active_job` pointer and takes it in one atomic call. A read-then-write guard
  left a window where two retries both saw an idle conversation; the script also stamps
  `status=pending` on the claiming job's meta, because a pointer whose meta is not yet
  written would look stale to a racing caller. Claimed only after every rejection path,
  so a 404/400 leaves no pointer behind. Proven against real Redis in
  `tests/test_claim_slot_redis.py` (8 simultaneous claims, exactly one winner).
- Retryable tail: newest row is a **failed assistant reply** (deleted here, so history
  keeps no dead bubble) **or** a **user message with no reply at all** (worker died
  before persisting). Anything else is 404.
- Re-attaches the user message's `MessageFile` rows so attachments survive the retry.
- Optional body `{"model": "…"}`; empty means the server default. Both this and
  `POST /messages` resolve ids through `services/chat_models.resolve_requested_model`.
- Does **not** re-publish `chatbot.message.sent` — the user turn was published on the
  original send.
- Enqueue for both routes goes through `services/job_enqueue.enqueue_generation_job`
  (job meta → `conv_active_job` pointer → `rpush`, in that order).

## Human-readable copy

See **`chatbot-service/CLAUDE.md`** for the full reference in prose form.

## Gemini model ids — verified 2026-08-27

Live check against Google (real key, local worker):

| Model id | Result |
|----------|--------|
| `gemini-flash-latest` (current `chat_default_model`) | `503 UNAVAILABLE` — "model experiencing high demand", repeatedly |
| `gemini-2.5-flash` | refused: *"no longer available to new users… use models/gemini-3.6-flash"* |
| `gemini-2.5-flash-lite` | refused: *"…use models/gemini-3.5-flash-lite"* |
| `gemini-3.6-flash` | streams fine |

`GET /models` returned 28 ids, so the allowlist is not the constraint.

**Decision (2026-08-27): pin explicit versions, no `-latest` aliases.** The alias is what
503'd, and layer-1 retry covers the transient case, so a bump is now a reviewed change
rather than a silent upgrade. Live re-confirmation the same day: a retry job against
`gemini-flash-latest` took two 503s before a 200.

- `core/config.py` → `DEFAULT_CHAT_MODEL_ID = "gemini-3.6-flash"`,
  `DEFAULT_TITLE_MODEL_ID = "gemini-3.5-flash-lite"` — the single source for the
  `Settings` defaults *and* the static picker fallback in `services/chat_models.py`.
- chatbot-frontend mirrors them in `src/constants/chat-page.constant.ts`
  (`DEFAULT_CHAT_MODEL_ID`, `FALLBACK_CHAT_MODELS`). These must move together.
- `MessageCreate.model` defaults to `""`, not a literal — a pinned default in the schema
  silently outranked `chat_default_model`.
- **A running instance keeps its `.env` values.** Mirror `.env.example` (`CHAT_DEFAULT_MODEL`,
  `GEMINI_TITLE_MODEL`, and an allowlist that contains the default) or the old alias
  stays in use.
