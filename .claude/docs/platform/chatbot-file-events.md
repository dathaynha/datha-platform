# Chatbot ↔ file NATS events (canonical)

_Single source of truth — NATS choreography for conversation delete → orphan file_ids → file-service cleanup (DLQ, pull consumers). Applies when editing chatbot-service, file-service, or event-store. Do not duplicate this narrative in service rules or cursor files; link here only._

**This file is the only place** the end-to-end **conversation delete → orphan files → file-service** story is spelled out. **`services/chatbot-service-architecture.md`** and **`services/file-service-architecture.md`** must **link** here, not copy paragraphs, so edits cannot drift. **`event-store/`** ingest consumes the same subjects — keep ingest behavior aligned with this choreography when those events change.

**Also read:** **`platform/event-store-architecture.md`** — standard event **envelope**, **`EVENTS` / `DLQ`** streams, dev limits, pull-consumer defaults, event-store ingest (no duplicate tables here).

**Broker topology:** **`platform/platform-nats-architecture.md`** — `pnpm reconcile` after NATS is up; services connect only.

## Product rule (orphan-only)

When a user deletes a conversation, **only `file_id`s that are not referenced by any other conversation for that owner** may be removed in file-service. A file still linked elsewhere **must not** appear in the published list.

Files remain **user-owned**; orphan-only cleanup avoids breaking other threads that reuse the same attachment UUID.

## End-to-end flow

1. **`DELETE /conversations/{conversation_id}`** (chatbot-service): before ORM/session delete of the conversation, **query orphan `file_id`s** — present on `message_files` for messages in **this** conversation, and **not** present on any `message_files` row tied to messages in **another** conversation for the same **`owner_id`** (via `messages` → `conversations.owner_id`). Use **`NOT EXISTS`** (or equivalent); **deduplicate** UUIDs.
2. **Delete** the conversation; cascade removes `messages` / `message_files`. **Commit** successfully.
3. **Publish** to JetStream subject **`events.chatbot.conversation.deleted`** using the **standard envelope** from `platform/event-store-architecture.md`:
   - `type`: `chatbot.conversation.deleted`
   - `service`: `chatbot-service`
   - `entity_id`: conversation UUID (string)
   - `owner_id`: from **`X-Owner-ID`**
   - `correlation_id`: from **`X-Correlation-ID`**
   - `payload` **at minimum:** `{ "conversation_id": "<uuid>", "file_ids": ["…"] }` — **orphan list only**; empty `file_ids` is valid.
4. Respond **204** immediately — **do not** wait for file-service or Azure.
5. **file-service** runs a **pull** durable consumer (suggested name **`file-service-conversation-cleanup`**) filtered to **`events.chatbot.conversation.deleted`**. For each `file_id` in `payload.file_ids`: enforce **`owner_id`** matches envelope, then run existing **soft-delete + blob removal**; emit **`events.file.file.deleted`** per successful delete (standard envelope, `payload.origin` carrying the file's own origin). Handler must be **idempotent** (duplicate JetStream delivery, already-deleted row → log / no-op, **ack**).
6. **Mandatory DLQ:** on final failure after **`max_deliver`** (see **`platform/platform-nats-architecture.md`**), **publish** to **`events.dlq.>`** (stream **`DLQ`**), then **ack**. Never infinite redelivery without a recorded sink.

## chatbot-service implementation notes

- **`NATS_URL`** in settings and **`.env.example`**; connect in app **lifespan** (alongside Redis).
- **Publish only after** the conversation delete **commits**. Never publish on failed delete.
- **Non-blocking publish:** if NATS is down, **log** and still return **204**; HTTP contract is with Postgres (same spirit as file-service publish on confirm).
- **Publish outbox (not DLQ):** when JetStream publish fails or NATS is disconnected, rows go to Postgres **`event_outbox`** (`pending` → API drain loop → **`EVENTS`**). This is **retry**, not `events.dlq.>`. DLQ remains for **consumer** exhaustion after `max_deliver` only.
- **`events.chatbot.message.sent`:** emitted for user messages (API) and assistant messages (worker enqueues outbox); ingested by event-store like other `events.chatbot.>` subjects.

## Orphan reconcile (manual / scheduled)

When **`conversation.deleted`** never reached JetStream (legacy pre-outbox, or API was down before outbox existed), orphan blobs may remain in file-service. **Not DLQ** — same subject and consumer as normal delete.

**CLI:** `python -m app.reconcile_orphans` (dry-run) · `python -m app.reconcile_orphans --execute` (publish).

| Layer | Behavior |
|-------|----------|
| **Outbox sweep** | Drain pending **`event_outbox`** rows (backup when API was not running). |
| **Orphan scan** | For each known **`owner_id`**, list file-service files with **`?origin=chatbot`** only (explicit **`origin = chatbot`** — **`NULL` is never touched**); if **`file_id`** not in chatbot **`message_files`** and file older than **24h**, publish **`events.chatbot.conversation.deleted`** with sentinel **`conversation_id`** `00000000-0000-0000-0000-000000000001` and `payload.reconciliation: true`. **Never** reconcile files with another **`origin`** or unknown **`NULL`**. |

**Owners scanned:** distinct `conversations.owner_id` plus `owner_id` from **`event_outbox`** `conversation.deleted` envelopes (covers some deleted-all-conversations cases).

**file-service** accepts **`GET /internal/files?origin=chatbot`** with **`X-Owner-ID`** (internal only — not proxied via api-gateway). Consumer remains idempotent.

**Schedule:** manual locally; **ADO cron ~daily** later with `--execute`. No extra env kill switch — dry-run is the default.

## file-service implementation notes

- **In-process consumer** (not a separate repo service unless you later extract it): JetStream **pull** durable, explicit **ack**, bounded **fetch**; broker **`max_deliver`** via **platform-nats**; file-service app DLQ uses **`NATS_CONSUMER_MAX_DELIVER_FILE_SERVICE_CONVERSATION_CLEANUP`**. **Startup:** retry **`js.consumers.get`** with backoff until the durable exists (NATS / platform-nats reconcile may lag app boot).
- **Ownership:** every delete path uses **`WHERE owner_id = …`** from the envelope — never trust payload alone without matching envelope `owner_id` to the file row.
- **`origin` column:** set on **`POST /files/prepare`** (default **`chatbot`**; optional body **`origin`** or future **`X-Calling-Service`** mapping). Orphan reconcile lists **`?origin=chatbot`** only — other origins are never deleted by chatbot cleanup.
- **Other publishers** on this service (`events.file.file.uploaded` / `deleted`) stay documented in **`services/file-service-architecture.md`**; only **conversation-deleted consumption** is fully specified **here**.

## event-store

`events.chatbot.conversation.deleted` and `events.file.file.*` are ingested by **event-store** from stream **`EVENTS`** per **`platform/event-store-architecture.md`**. **DLQ** messages are **not** ingested as normal business rows.
