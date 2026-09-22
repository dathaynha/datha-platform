# messenger-service — architecture and design rules (built)

_Messenger durable domain state (Node TS + Fastify 5 + pg, :3005): conversations, messages, read state, call history_

> **Status 2026-09-08: BUILT — ADO repo, pipeline id 15, policies 31/32 (created 2026-09-08).** Phase 1 is **merged into `main`** (PR **!149**, 2026-09-09). Conversations, messages, read state, both publish paths, 40 vitest specs, a boot **from its own `.env`** (2026-09-08 — note `DATABASE_URL` has no default, so this service cannot start without one), and a live run against real Postgres + NATS all in place. The `platform-nats` topology change this needed (`events.messenger.>` on `EVENTS`) is made and reconciled. Nothing open from phase 1 — `.env` and the build-service grant are done and the code is on `main`. Built in phase 1 of **`products/messenger-architecture.md`**, alongside `realtime-service`.
>
> **Phase 2 call history is built (2026-09-09, unmerged):** migration `003_calls.sql`, this repo's **first JetStream consumer** (`messenger-service-calls`), and two read routes. **65 vitest specs**, up from 40. Verified live end to end — a call on the socket reached Postgres and came back out of `GET /calls` — and the projection was replayed twice with no duplicate rows. See **§ Call history (phase 2)**.

## Purpose

Owns everything in Messenger that must survive a restart: conversations, participants, messages, read state and (from phase 2) call history. It is a Fastify twin of `event-store` / `notification-service` / `accounts-service` and inherits their conventions wholesale — same plugin layout, same `X-Owner-ID` trust model, same migration runner, same RED metrics.

It is the **write path** for chat. The browser sends a message over REST and receives it over the socket held by `realtime-service`; those halves are deliberately different transports, for the reason in **`products/messenger-architecture.md` § Transport**: a WS write with no durability behind it has no retry story.

## Responsibility boundary

| Does | Does not |
|------|----------|
| Conversations, participants, messages, read watermarks | Hold sockets, presence or typing (that is `realtime-service`) |
| Publish `events.messenger.*` to JetStream `EVENTS`, and project `events.messenger.call.*` back into call history | Create streams or durables (`platform-nats` owns topology) |
| Publish live frames to core NATS `rt.owner.<owner_id>` | Push to browsers directly |
| Store attachment **file ids** on messages | Store attachment bytes (that is `file-service`) |
| Membership checks via `Authz.can()` | Own the user directory (that is `accounts-service`) |
| Project call history from `call.*` events (phase 2) | Track live call state (Redis in `realtime-service`) |

## Data model

Five tables, one migration per concern (`src/db/migrations/`), same runner as every sibling.

```sql
conversations
  id             UUID PK
  tenant_id      TEXT NOT NULL            -- accounts-service workspace id; one shared tenant in phase 1
  type           TEXT NOT NULL            -- 'direct' | 'group'
  direct_key     TEXT UNIQUE              -- sorted 'ownerA|ownerB' for direct, NULL for group
  title          TEXT                     -- group only; direct titles are rendered from participants
  created_by     TEXT NOT NULL            -- owner_id
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  last_message_at TIMESTAMPTZ             -- the last *message*: the preview's own timestamp
  last_activity_at TIMESTAMPTZ NOT NULL   -- message OR call: what the list sorts and pages on
  deleted_at     TIMESTAMPTZ

conversation_participants
  conversation_id UUID  → conversations(id) ON DELETE CASCADE
  owner_id        TEXT
  role            TEXT NOT NULL DEFAULT 'member'   -- 'member' | 'admin'
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  left_at         TIMESTAMPTZ
  last_read_at    TIMESTAMPTZ                      -- the read watermark
  muted_until     TIMESTAMPTZ
  PRIMARY KEY (conversation_id, owner_id)

messages
  id               UUID PK
  conversation_id  UUID → conversations(id) ON DELETE CASCADE
  sender_owner_id  TEXT NOT NULL
  kind             TEXT NOT NULL DEFAULT 'text'    -- 'text' | 'attachment' | 'system'
  body             TEXT NOT NULL DEFAULT ''
  attachment_file_id TEXT                          -- file-service id; bytes never live here
  client_message_id  TEXT NOT NULL                 -- caller-generated; the idempotency key
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  edited_at        TIMESTAMPTZ
  deleted_at       TIMESTAMPTZ
  UNIQUE (conversation_id, sender_owner_id, client_message_id)

call_history            -- phase 2, projected from events.messenger.call.*
  id, conversation_id, started_at, ended_at, outcome, participants JSONB
```

Indexes that the queries actually need: `messages (conversation_id, created_at DESC)` for thread paging, `conversation_participants (owner_id) WHERE left_at IS NULL` for the list, `conversations (last_activity_at DESC, id DESC)` — the tuple, because the keyset cursor compares both.

**Read state is a watermark, not a row per message.** `last_read_at` per participant answers both questions the product asks — "is this conversation unread" and "how far has the other person read" — in one column, and it cannot drift. Per-message receipt rows would cost one write per message per participant to render a single tick in the UI.

**A call is activity; a message is not the only kind.** `last_activity_at` is
advanced — forward only, `GREATEST` — by the message transaction *and* by the
call projection, and it is what the list orders and pages on. `last_message_at`
stays the preview's own timestamp. Bumping the message column from the call
projection would have been one line less and would have made its name a lie for
every activity type after it (migration `008_conversation_activity.sql`).

Two things fell out of making the sort key NOT NULL. The cursor is now the
tuple `(last_activity_at, id)`, because a timestamp alone silently **drops**
rows that share the boundary instant; and the walk no longer stops at the first
conversation nobody has written in, which the old nullable cursor could not page
past.

**Unread is derived, never stored.** A conversation is unread for an owner when `last_message_at > last_read_at` (or `last_read_at IS NULL`) and the last message is not their own. The badge is therefore a set of conversation ids computed on demand, which is exactly the set semantics **`products/messenger-architecture.md`** requires — a stored counter is the shape that corrupts permanently on one duplicated frame.

**Direct conversations are unique by `direct_key`.** `POST /conversations` with `type: 'direct'` is idempotent: the sorted owner-id pair collides on the unique index and the existing conversation is returned. Without it, two people opening each other simultaneously create two threads and neither sees the other's messages.

## REST API

Behind the gateway at `/api/messenger/*` (the gateway strips the prefix). Every route except `/health` and `/metrics` requires the gateway-injected `X-Owner-ID`; every route touching a conversation calls `Authz.can()` first.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | unauthenticated `{"status":"ok"}` |
| `GET` | `/metrics` | Prometheus exposition |
| `POST` | `/conversations` | `{ type, participant_owner_ids[], title? }`; idempotent for `direct` |
| `GET` | `/conversations?limit=&cursor=` | the caller's conversations, `last_activity_at DESC, id DESC`, each with participants, last-message preview, `lastCall` and `unread`. `cursor` is `<iso>\|<uuid>` |
| `GET` | `/conversations/:id` | detail; 404 (not 403) when not a participant |
| `PATCH` | `/conversations/:id` | group `title` only |
| `POST` | `/conversations/:id/participants` | add members (group, admin) |
| `DELETE` | `/conversations/:id/participants/me` | leave; sets `left_at` |
| `GET` | `/conversations/unread` | `{ conversation_ids[] }` — the badge resync after reconnect or tab focus |
| `POST` | `/conversations/:id/messages` | `{ body?, client_message_id, attachment_file_id? }` → 201, or 200 with the existing row on replay |
| `GET` | `/conversations/:id/messages?before=&limit=` | thread paging, newest first |
| `POST` | `/conversations/:id/read` | `{ message_id }` → advances the watermark, never rewinds it |
| `GET` | `/calls?limit=` | the caller's own call history across conversations, `started_at DESC` — **authorization is the query** |
| `GET` | `/conversations/:id/calls?limit=` | one thread's calls; 404 (not 403) when not a participant |

The read watermark is set **from the message row inside the UPDATE**, never from a timestamp the caller round-tripped through TypeScript: `timestamptz` carries microseconds and a JS `Date` does not, so a value that has been through the driver comes back truncated and leaves the last message looking newer than the watermark — the badge then never clears. The general rule now lives in **`lang/lang-typescript-fastify.md` § Postgres timestamps**; it cost a live debugging session on 2026-09-08 because the unit tests fake the pool and cannot see driver truncation.

**Not a participant returns 404, not 403.** A 403 confirms the conversation exists, which leaks the id space to anyone who can enumerate uuids.

## Transport — publishing twice

Every durable write publishes to **both** buses, and that is one source of truth with two consumers, not two:

| Bus | Subject | Purpose |
|---|---|---|
| JetStream `EVENTS` | `events.messenger.conversation.created`, `events.messenger.message.sent`, `events.messenger.conversation.deleted` | the record — retained, replayable, ingested by `event-store` |
| **core NATS** | `rt.owner.<owner_id>` (one publish per participant) | the wire — `realtime-service` instances holding that owner's socket forward the frame |

Core NATS is fire-and-forget on purpose: a dropped live frame self-heals on the client's next resync, and durability already lives in Postgres and JetStream. A durable consumer on the fanout path would redeliver stale chat frames on every socket reconnect — **`services/realtime-service-architecture.md` § Fanout** makes the same point from the other side.

The publish happens **after** the transaction commits. Publishing inside it means a rolled-back write can still have been announced; publishing after means the worst case is a message that exists but arrives late, which the client's resync already covers.

**Therefore a publish failure must not fail the request.** The row the caller asked for is already durable, so a 500 would report a lost message that in fact exists — and the client would retry a write that needs no retry. Both publishes are wrapped in `src/services/announce.ts`: an error log plus `messenger_service_event_publish_total{outcome="error"}` / `messenger_service_fanout_publish_total{outcome="error"}`. A broken bus then shows up in Grafana rather than in a user's missing history. This is the same reasoning as the pipeline colour rule in the working agreement — a step that did not do its job stays visible.

**`events.messenger.>` had to be added to the `EVENTS` stream subjects** — done in `platform-nats/topology.ts` on 2026-09-08, reconciled locally, and merged as PR !148 on 2026-09-09. Before that, JetStream answered `no responders` for `events.messenger.conversation.created` and every envelope was dropped, loudly, per the paragraph above; afterwards both envelope types were read back out of the stream with the correct shape. **No durable is needed for phase 1** — `messenger-service-calls` only exists once phase 2 publishes `call.*`.

`message.sent` stays **unmapped** in `notification-service` — see **`platform/platform-notifications.md`**. Only `call.missed` (phase 2) crosses into the bell.

## Call history (phase 2)

**Group calls, slice 2 (MERGED !182, 2026-09-15).** `calls` was shaped for a pair, and a
group call has no answer for `callee_owner_id`. Rather than overload it:

- `callee_owner_id` is now **nullable** — a 1:1 call fills it, a group call
  leaves it NULL and is described by its participants.
- **`call_participants`** (`migration 006`) holds one row per person the call
  *rang*, with a `joined` flag separating being rung from being on the call.
  "Who missed it" is exactly `joined = false`, and someone who joined and
  dropped out early still counts as having been on it.
- `joined` fills **monotonically** (`joined OR EXCLUDED.joined`), like every
  other column here, so a redelivery or an `ended` overtaking its `started`
  cannot un-join anybody. Verified against real Postgres, not only against the
  SQL text the specs assert on.
- `GET /calls` reads through the participants table **as well as** the
  caller/callee columns: rows projected before phase 3 have no participant rows
  at all, and dropping the old predicate would silently empty everyone's
  history.
- Both list routes hydrate `participantOwnerIds` and `joinedOwnerIds` via a
  lateral join, so a call and its participants can never be read from two
  different moments. A pre-phase-3 row returns empty arrays rather than
  changing shape.

⚠️ The specs here **fake the pg pool and assert on SQL text**, so they catch a
clause going missing and prove nothing about whether Postgres accepts it — see
`.claude/rules/working-agreement.md` on doubles that mirror rather than run.

Calls happen on the socket; this service only keeps **the record**. `realtime-service` publishes `events.messenger.call.{started,ended,missed}` to JetStream `EVENTS`, and the `messenger-service-calls` durable projects them into a `calls` table. That table is **derived and rebuildable** — deleting the durable and reconciling replays the stream into the same rows, which is how the projection was verified.

```sql
calls
  id               UUID PK                  -- the call id realtime-service generated
  conversation_id  UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE
  caller_owner_id  TEXT NOT NULL
  callee_owner_id  TEXT NOT NULL
  media            TEXT NOT NULL DEFAULT 'audio' CHECK (audio | video)   -- 004, phase 2.5
  started_at       TIMESTAMPTZ NOT NULL
  answered_at      TIMESTAMPTZ              -- NULL = never answered (missed or declined)
  ended_at         TIMESTAMPTZ
  end_reason       TEXT CHECK (hangup | declined | missed | busy | ice_failed)
  duration_seconds INTEGER NOT NULL DEFAULT 0
```

- **The upsert is order-independent, not merely idempotent.** Every column fills monotonically — `COALESCE` on the timestamps and reason, `GREATEST` on the duration — because a `nak` requeues one message while the loop moves on, so an `ended` can overtake its `started`. Both orders converge on the same row, and a redelivery changes nothing. Proven live: 10 projections, 3 rows.
- **`media` is the one column the upsert never updates** (`004_calls_media.sql`, phase 2.5). Every event of one call carries the same kind, so the first write wins and neither a redelivery nor an out-of-order `ended` can flip it. Its `DEFAULT 'audio'` is what makes the column backward compatible in both directions: rows projected before 2.5 were all audio calls, and an event published without a `media` field still projects. An unrecognised value is read as `audio` rather than passed through — the `CHECK` would reject it and stall the durable on a message that can never succeed.
- **`status` is derived, never stored.** A column would be a second source of truth for `answered_at` and `end_reason`. `callStatus()` computes `ringing | active | completed | missed | declined`; an unanswered call that ended for *any* reason reads as `missed`, so a caller cancelling mid-ring shows correctly on the callee's side.
- **A malformed or foreign event is ignored and acked, not retried.** Only a *failed write* earns a `nak`, and only an exhausted `max_deliver` earns the DLQ (`events.dlq.messenger_service.calls`). Non-uuid ids are checked here rather than left to fail the insert and cycle through the DLQ for nothing, and `answered_elsewhere` — a live-socket reason the `CHECK` would reject — is discarded.
- **A call for a deleted conversation is terminated, not DLQ'd.** Its rows cascaded away with the conversation, so no retry can succeed.
- **`GET /calls` needs no membership lookup.** A row is yours only if you were one of the two participants, so the `WHERE` clause *is* the authorization. The thread-scoped route goes through `authorizeConversation` like every other conversation route.
- This is the service's **only** JetStream consumer; everything else it does with NATS is publishing. The durable is owned by `platform-nats` (critical-behaviors #7) and the consumer waits for it to exist rather than creating it.

### Calls that never reported an ending (2026-09-15)

`ended_at` is written by exactly one thing: projecting a `call.ended` event. And
that event is published by realtime-service — **the process most likely to be
the thing that died**. An instance killed mid-call publishes nothing, its Redis
record expires in silence, and this row claims the call is in progress *forever*.
The thread reads that row and offers a Join button for a call that has been over
for days. dathq found it the general way round: *"the data is wrong when there's
a bug happen."*

realtime-service now reaps calls whose instance has stopped heartbeating, which
handles the common case properly and promptly. **This is the layer underneath**,
for the case where the event never arrives at all — NATS down, the consumer
stopped, the message dead-lettered — where no amount of care on the publishing
side helps. It depends on nothing but the clock, which is the point of having
it.

The rule is one function, `settleStaleCall`, applied in two places:

- **At read time**, in `listConversationCalls` / `listOwnerCalls`. Cannot fail
  to run, so a reader is never wrong in the window before the sweep. One
  comparison for the overwhelming majority of rows.
- **Durably**, by `plugins/call-sweep.ts` at boot and every
  `CALL_SWEEP_INTERVAL_SECONDS`. Read-time alone would leave the database
  permanently wrong, which matters for anything that aggregates rather than
  renders. A failed sweep is logged and not fatal — every reader already applies
  the same bound.

Both write the same values because they share the rule; a `CASE` in each query
would have been a second place for it to drift.

Three decisions worth keeping:

- **`CALL_MAX_LIFETIME_SECONDS` (6 h) must be ≥ realtime-service's
  `CALL_TTL_SECONDS` (4 h)**, which is the longest a call can legitimately live.
  Shorter and this service declares a real call over while people are on it.
- **`expired` is its own end reason** (migration `007_call_expiry.sql`), not
  folded into `hangup`: somebody pressing a button and nobody ever telling us
  are different facts, and only one of them is a completed call. It is
  deliberately absent from `END_REASONS`, the list an *event* may assert — it is
  this service's own conclusion, never a producer's claim.
- **`duration_seconds` stays 0.** Nobody knows how long they talked, and
  inventing six hours would poison every total built on that column.

The bound reaches the **wire**, not just `status`: the frontend's ongoing-call
banner keys off `endedAt`, so a status-only fix would have left the Join button
exactly where it was.

## Attachments (phase 1)

Bytes never touch this service. The browser uploads straight to Azure Blob through a **file-service** SAS URL (prepare → PUT → confirm, per **`services/file-service-architecture.md`**) and the message stores the `file_id` only. Messenger uploads set `origin: "messenger"` on prepare, because file-service defaults that column to `chatbot` and its orphan reconcile deletes exactly that origin — an unlabelled messenger upload would eventually be swept.

**Reading an attachment is brokered here**, by `GET /conversations/:id/messages/:messageId/attachment`:

```
reader → messenger-service   authorize: is this owner a participant?  (404 if not)
       → file-service        GET /files/:fileId/download-url as the UPLOADER
       ← { name, download_url, expires_at }
```

The reason is a boundary, not a convenience: **file-service scopes every read by `X-Owner-ID`**, which is right for a file manager and wrong for a chat attachment — the person who needs to open it is usually not the person who uploaded it. Conversation membership is the correct authorization and only this service knows it. So the reader is authorized here, and file-service is then asked *as the uploader* over the private network. file-service stays chat-blind, and no list of conversation ids leaks into it.

Two consequences worth keeping:

- **The filename lives in the message body.** A recipient cannot read the file's metadata from file-service at all, so the body carries the name and the bubble renders from it — no metadata round trip, and the conversation list preview has something to show.
- **The URL is minted on demand**, never at render time: a SAS link is short-lived, so one embedded in a rendered thread would be stale by the time anyone clicked it.

`messenger_service_attachment_grants_total{outcome}` counts the results. `FILE_SERVICE_URL` configures the hop.

**Not built:** conversation deletion, and therefore the `conversation.deleted` → orphan cleanup choreography in **`platform/chatbot-file-events.md`**. When it arrives it copies that story rather than inventing a second one, and needs the `file-service-messenger-cleanup` durable in `platform-nats`.

## Authorization

`Authz.can(subject, action, resource)` in `src/services/authz.ts`, implementing the `input` schema fixed in **`products/messenger-architecture.md` § Identity and authorization**. Phase 1 answers from Postgres membership; phase 4 points the same function at an OPA sidecar without moving the schema. Actions used here: `conversation.read`, `conversation.write`, `message.send`, `message.read`.

## Env vars

| Var | Purpose |
|-----|---------|
| `PORT` | listen port (default `3005`) |
| `DATABASE_URL` | Postgres — `messenger_service_db` |
| `NATS_URL` | JetStream publish + core NATS fanout + the call-history consumer |
| `NATS_CONSUMER_MAX_DELIVER_MESSENGER_SERVICE_CALLS` | default `3`; **must match** platform-nats reconcile for that durable |
| `CONVERSATIONS_PAGE_SIZE` | default `30`, cap on `?limit=` |
| `MESSAGES_PAGE_SIZE` | default `50`, cap on `?limit=` |
| `MAX_GROUP_PARTICIPANTS` | default `10` (was 50 until 2026-09-16). A **product** cap while the platform is unpaid, deliberately *not* aligned with realtime-service's `MAX_CALL_PARTICIPANTS` (4) — a mesh call is peer-to-peer and costs nothing to host, while group chat is useful at sizes calling never reaches. 5 was rejected: one above the call cap makes every group look callable and fail by one |
| `CALLS_PAGE_SIZE` | default `50`, cap on `?limit=` for both call routes |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional; gates OTLP logs as elsewhere |

`CALL_MAX_LIFETIME_SECONDS` (default 21600) and `CALL_SWEEP_INTERVAL_SECONDS`
(default 900) bound an unfinished call — see § Calls that never reported an
ending. The first must be at least realtime-service's `CALL_TTL_SECONDS`.

## Metrics

`messenger_service_http_requests_total` / `_duration_seconds` (RED, route-pattern labels), plus `messenger_service_messages_sent_total{kind}`, `messenger_service_fanout_publish_total{outcome}`, `messenger_service_read_receipts_total`, `messenger_service_conversations_created_total{type}`, `messenger_service_calls_projected_total{outcome=projected|ignored|invalid|orphaned|dlq}`. Prometheus target :3005 in `platform-observability` (added 2026-09-08, with :3004 and the long-missing :3006). `X-Correlation-ID` adopted as the Fastify request id and stamped onto every published envelope.

## Design rules

1. **REST writes, socket reads.** Nothing durable is ever accepted over a WebSocket.
2. **Publish after commit**, JetStream for the record and core NATS for the wire — never a durable consumer on the fanout path.
3. **Idempotent sends** on `client_message_id`; a retry returns the original row, never a duplicate message.
4. **Read state is a watermark** that only moves forward.
5. **Unread is derived** as a set of conversation ids. No counters anywhere.
6. **Direct conversations are unique** by sorted `direct_key`.
7. **Attachment bytes belong to `file-service`** — this service stores ids and copies the delete choreography in **`platform/chatbot-file-events.md`** rather than inventing a second one.
8. **Non-participants get 404**, never 403.
9. **`platform-nats` owns topology** (critical-behaviors #7); this service connects, publishes, and binds one durable it did not create. The `messenger-service-calls` consumer waits for that durable to exist rather than adding it.
10. **Authorization behind `Authz.can()`**, so OPA is later a swap.

## Testing

`vitest` per **`testing/unit-testing-strategy.md`**: service-layer units with the pg pool and NATS clients faked at the seam, route tests through `app.inject()`. The cases worth writing first are the ones with a real invariant behind them — replayed `client_message_id`, the watermark refusing to rewind, `direct_key` collision returning the existing conversation, and a non-participant getting 404.

**Faked pools do not prove SQL.** All 31 specs that existed at the time passed while the watermark bug was live (the suite is 40 now), because a fake pool returns whatever the test says it returns. Anything whose correctness lives in the statement — `GREATEST`, `ON CONFLICT`, a `LATERAL`, timestamp precision — has to be exercised against a real Postgres before it is called verified. The phase-1 build did that by hand (`curl` against :3005 with `X-Owner-ID` headers); a repeatable integration tier is worth having before the surface grows.

## Related rules

- **`products/messenger-architecture.md`** — the product, phases, transport table, security rules
- **`services/realtime-service-architecture.md`** — the socket half this feeds
- **`services/accounts-service-architecture.md`** — identity, tenancy, the OPA activation rule
- **`platform/event-store-architecture.md`** — envelope shape and `EVENTS` retention
- **`platform/platform-notifications.md`** — why `message.sent` stays unmapped
- **`platform/chatbot-file-events.md`** — attachment cleanup choreography to copy
- **`lang/lang-typescript-fastify.md`** — Fastify + strict TS conventions
