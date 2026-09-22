# realtime-service — architecture and design rules (built)

_Platform WebSocket service (Go, :3004): presence, typing, WebRTC signaling relay, TURN credentials_

> **Status 2026-09-08: BUILT — ADO repo, pipeline id 16, policies 33/34 (created 2026-09-08).** Phase 1 is **merged into `main`** (PR **!150**, 2026-09-09). Sockets, presence, typing, owner fanout and the gateway path are all live and verified end to end, **including across two instances** (:3004 + :3014, 2026-09-08 — the full `RT_LIVE` suite passed against the second instance while writes went to `messenger-service`, and killing it left the first serving). Boots from its own `.env` via `godotenv`, as `api-gateway` does; every var has a default, so it also boots with none — only `conversation.open` degrades. Socket tests drive a real WebSocket client against the real handler, and an `RT_LIVE=1` integration suite covers REST-write → core NATS → socket. **Phase 2 signaling is built (2026-09-09, unmerged):** the WebRTC relay, live call state, `call.*` events on JetStream and `GET /turn-credentials` all work and are verified live — see **§ Call state and events** and **§ TURN credentials**. **101 Go tests**, up from 53. The gateway route `GET /api/realtime/turn-credentials` is in place (api-gateway, same day). What phase 2 still needs elsewhere: the `messenger-service-calls` durable in `platform-nats`, the history projection in `messenger-service`, coturn in `_local`, and the browser half in `messenger-frontend`. **Phase 3 slice 1 (the room model) is MERGED 2026-09-14 as PR !180:** the pair became an invited set plus a joined set, `call.join` and `call.participant` were added, and signaling frames now carry a validated `to` — see **§ The room model and targeted signaling**. **138 Go test runs.** 1:1 behaviour is unchanged and was re-proven with the `calls` Playwright project against a restarted binary.

## Purpose

Owns **the browser's one persistent WebSocket** for the whole platform. Everything ephemeral rides it: presence, typing, unread deltas, message fanout, WebRTC signaling. It holds **no domain state** — no messages, no conversations, no history.

Platform-level on purpose, not Messenger-level. One socket per browser tab, whatever the product. Chatbot's SSE stream could later fold into it; that is not a phase-1 goal.

## Responsibility boundary

| Does | Does not |
|------|----------|
| Terminate authenticated WebSockets; one connection registry per instance | Store messages, conversations or call history |
| Presence (Redis TTL) and typing (in-memory, TTL) | Own the user directory (that is `accounts-service`) |
| Relay WebRTC SDP / ICE between participants of a call | Parse, rewrite or inspect SDP |
| Track live call state (Redis, TTL) and publish `call.*` events | Persist call history (`messenger-service` projects it) |
| Issue short-lived TURN credentials | Terminate or relay media itself (that is coturn / an SFU) |
| Fan out via **core NATS** `rt.owner.<owner_id>` | Create JetStream streams or durables (`platform-nats` owns those) |

## Why Go, and why not inside `messenger-service`

Durable domain state and ephemeral connection state scale and fail differently: Postgres, transactions and retries on one side; tens of thousands of idle sockets and cheap concurrency on the other. Keeping them apart means a signaling deploy cannot endanger message history.

Go fits the socket half and adds no toolchain — `api-gateway` already establishes `lang/lang-go.md` and the `stack-go-gotestsum` pipeline. Library: `github.com/coder/websocket` (formerly nhooyr) with `chi`, matching gateway conventions.

## Connection and auth

`WebSocket` cannot set headers, exactly like `EventSource`. Reuse the **stream-token pattern already built twice** (chatbot SSE, notification SSE) rather than inventing anything:

1. Browser calls `GET /api/realtime/token` (JWT-protected) → gateway mints a scoped token, `jti="realtime"`, **TTL 60-120 s**.
2. Browser opens `wss://…/api/realtime/ws?stream_token=…`.
3. Gateway **validates `Origin` against `CORS_ORIGINS`** — an upgrade request gets no CORS preflight, so this check is the only thing standing between the socket and any origin holding a stolen token.
4. Gateway verifies the token, strips it from the query, injects `X-Owner-ID`, proxies the upgrade.
5. Service reads `X-Owner-ID` only. No JWT code in this service, same as every other downstream.

Keep the token TTL short: it travels in a query string, and query strings land in access logs and proxy telemetry. It is needed only at connect.

Reconnect: client backs off 1-30 s (the notification SSE pattern), mints a **fresh** token each attempt, and resyncs state from the `ready` frame.

## Frame protocol

JSON, `{ "t": <type>, "id": <optional client id>, "d": <payload> }`. Small and explicit; no RPC framework.

**The `ready` frame carries presence only — the client fetches its own unread set** (dathq, 2026-09-08). This service holds no domain state, so the alternative was calling `messenger-service` on every connect; that would have made a socket unable to become `ready` while the chat service was down, and added a service-to-service hop to every reconnect. Instead the client reads `GET /api/messenger/conversations/unread`, an endpoint it already hits on tab focus, and whose flags the conversation list it loads at startup already carries. The badge stays a set of ids resynced on reconnect either way.

| Direction | Type | Payload |
|---|---|---|
| S→C | `ready` | `{ presence[], server_time }` — sent on every (re)connect. **No unread ids**: the client fetches those from `messenger-service` itself, per the decision above |
| S→C | `message.new` | the message envelope |
| S→C | `unread.added` / `unread.cleared` | `{ conversation_id }` — set semantics, never a counter |
| C→S | `typing.start` / `typing.stop` | `{ conversation_id }` |
| S→C | `typing` | `{ conversation_id, owner_id, until }` |
| C→S | `presence.subscribe` | `{ owner_ids[] }` — only what is visible on screen |
| S→C | `presence` | `{ owner_id, state: online\|away\|offline, at }` |
| C→S | `conversation.open` / `conversation.close` | `{ conversation_id }` — **where authorization happens**, see below |
| C→S | `presence.away` | tab hidden; `offline` is never client-reported |
| C→S | `call.invite` | `{ conversation_id, sdp?, media? }` — **no `to` field on purpose**, see § Call state and events. `sdp` is **required for a 1:1 call and refused for a group**: the offer rides the ring when there is one peer to offer to, and a mesh has none. `media` is `audio`\|`video`; **absent means audio**, so a client older than phase 2.5 keeps working, and anything else is refused with `bad_frame` rather than coerced |
| C→S | `call.answer` | `{ call_id, sdp }` — callee only, 1:1 only; refused in a group with `bad_frame` |
| C→S | `call.join` | `{ call_id }` — the general way in, and deliberately **without SDP**: a mesh is negotiated pair by pair afterwards. Allowed in a 1:1 **since 2026-09-16**, because `call.answer` replies to an offer and somebody who signed in mid-ring never received one |
| C→S | `call.renegotiate` | `{ call_id, sdp, to? }` — a **mid-call** offer or answer, e.g. a camera turned on, and in a group also the **first** offer of each mesh pair. One frame type for both halves: the SDP's own `type` says which, and this service does not parse SDP. Refused before the call is answered |
| S→C | `call.renegotiate` | `{ call_id, sdp, from, to }` — relayed to one participant, `from` stamped server-side |
| C→S | `call.ice` | `{ call_id, candidate, to? }` — `to` **required in a group**, optional in a 1:1 where the peer is derived. See § Targeted signaling |
| C→S | `call.hangup` | `{ call_id, reason? }` — `reason` limited to `hangup`, `declined`, `busy`, `ice_failed` |
| S→C | `call.ringing` | `{ call_id, conversation_id, callee_id?, media, participants[] }` — the invite's answer, to the **inviting connection only**. `callee_id` is empty for a group; `participants` is the invited set, sorted |
| S→C | `call.incoming` | `{ call_id, conversation_id, from, sdp?, media, participants?[] }` — to every tab of every invited person, **and re-sent on connect for any live call the newcomer is invited to and has not joined**. **`sdp` is absent for a group call and for that connect-time ring**, and a client must key on its absence — not on the participant count — to reply with `call.join` rather than `call.answer`. `media` is what lets the ring say "incoming video call" and warm the camera permission **before** the callee accepts |
| S→C | `call.answered` | `{ call_id, from, sdp }` |
| S→C | `call.ice` | `{ call_id, candidate, from, to }` |
| S→C | `call.participant` | `{ call_id, owner_id, state: joined\|left, participants[] }` — one arrival or departure, to **everyone invited** (including whoever is still ringing). `participants` is the full joined set after the change, not a delta |
| S→C | `call.ended` | `{ call_id, reason, from? }` — reasons above plus `missed`, `answered_elsewhere` and `empty` |
| both | `ping` / `pong` | 25 s keepalive, matching the notification SSE cadence |

**Every relayed frame is stamped server-side.** A client-supplied `from` is ignored, and a signaling frame is relayed only after confirming the sender is a participant of that call. SDP is opaque to this service: relay it, never parse it.

**Membership is checked once per opened conversation, not per keystroke.** This service holds no domain state, so it asks `messenger-service` (`GET /conversations/:id` with `X-Owner-ID`) when a client sends `conversation.open`, then subscribes that connection to `rt.conv.<id>`. A `typing.*` frame is refused unless the connection already holds that authorized subscription — so the hot path costs nothing and a client still cannot publish into a thread it is not in. The answer is cached for 30 s (allow **and** deny, so a denial loop cannot hammer messenger-service).

That cache is why **message content is routed per owner, not per conversation**: a stale allow on a typing indicator is a tolerable failure, a stale allow on message text would not be.

**A malformed or unknown frame gets an `error` frame back, never a disconnect.** Dropping the socket over a bad frame would also drop a call in progress. A frame for a call that has already ended answers `call_gone` for the same reason: both peers may send a final frame, and the second arrives after the state is gone.

**Redis lives in one place.** Presence and live call state are both TTL'd key-value data, so `internal/kv` owns the single client and each consumer (`presence`, `calls`) declares its own narrow interface over it — one pool, and test fakes that need no server. `presence.RedisStore` moved there in phase 2.

## Presence

Redis (already in `_local` infra, already used by chatbot-service):

- `presence:<owner_id>:<conn_id>` → the connection's reported state, **TTL 45 s**, re-armed every 15 s. Per connection rather than per owner, so closing one of five tabs does not mark the person offline: an owner is `online` if any connection is, `away` if all are, `offline` once the keys expire.
- A `presence.subscribe` is answered **immediately** with each owner's current state. A subscription carries only transitions, so without that first answer the dots render nothing until someone happens to change state.
- Transitions publish core NATS `rt.presence.<owner_id>`; instances holding a subscriber for that owner forward it.
- Clients subscribe to the owners **currently visible** in their list. Subscribing to everyone makes fan-out quadratic.
- `away` is client-reported (tab hidden); `offline` is TTL expiry. Never trust a client `offline` — a crashed tab cannot send one.

## Fanout and horizontal scale

Every instance subscribes to core NATS `rt.owner.<owner_id>` for each owner it currently holds a socket for. `messenger-service` publishes there after a durable write. Consequences worth stating:

- **No sticky sessions.** Any instance may hold any socket.
- **No shared connection table.** The subscription set *is* the routing table.
- Core NATS is fire-and-forget by design: a dropped live frame is corrected by the next `ready` resync, and durability already lives in Postgres plus JetStream.

This is the deliberate correction of the known limitation in `platform/platform-notifications.md`, where SSE fanout is in-memory and single-instance.

## Call state and events

Live call state (`call:<id>` → participants, status) lives in Redis with a TTL — it is ephemeral by nature. The **record** is events:

- `events.messenger.call.started` / `.ended` / `.missed` → JetStream `EVENTS`, standard envelope. The stream already carries `events.messenger.>`, so **call events needed no topology change** — only the `messenger-service-calls` durable does.
- `messenger-service` projects call history from them through the `messenger-service-calls` durable; `notification-service` maps `call.missed` to a bell notification with no topology change (both built 2026-09-09).
- `entity_id` is the call, so a projection can key on it while the event still attributes to a person like every other platform event. **`owner_id` is the person the event is about, which differs by type**: the caller for `.started`/`.ended`, the **callee** for `.missed` — because notification-service turns `owner_id` into whose bell rings, and the caller must not be told they missed their own call. **`correlation_id` is the call id**: a socket frame carries no request header, so every event of one call correlates with itself.
- `.started` fires **when a call is answered, not when it is dialled** — an invite nobody picks up produces `.missed` instead, so history has no half-open rows. A *declined* call produces `.ended` with no preceding `.started`, which the projection must upsert rather than assume ordering.

Ringing never goes through the notification pipeline: it needs sub-second delivery and its own accept/decline affordance, so it rides the socket. A **missed** call is the only crossover.

Decisions worth not relitigating (all 2026-09-09):

- **The callee is resolved from conversation membership, never from the frame.** `call.invite` deliberately has no `to` field: this is the one place where a client-chosen recipient would turn the socket into a way to ring strangers. `chatauth` therefore returns the participant list, not just a boolean, and a conversation with more than two participants is refused with `not_supported` rather than half-supported — group calling is phase 3.
- **The call id is generated server-side** and confirmed to the inviting connection with `call.ringing`. Accepting a client-chosen id would let two clients collide, deliberately or otherwise.
- **An invite rings every tab the callee has open, and exactly one may answer.** The winner is decided by an atomic `SETNX` on a separate `call:<id>:answered` lock key rather than by the call record, because two tabs can answer milliseconds apart. The losers get `call.ended` with reason **`answered_elsewhere`**, so the UI says that instead of "call failed". That frame goes to the whole owner subject, so **the winning tab receives it too and must ignore it** — the client knows, because it holds that call's `RTCPeerConnection`.
- **A client may not assert every end reason.** `hangup`, `declined`, `busy` and `ice_failed` come from a client; `missed` and `answered_elsewhere` are server conclusions and are refused with `bad_frame`. A caller forging `missed` would write a history row saying the other person ignored them.
- **Hanging up while still ringing is a `declined`, not a `hangup`** — the distinction is what the callee's history row says.
- **Renegotiation is relayed, never interpreted** (phase 2.5). `call.renegotiate` is authorized exactly like `call.ice` — participant check, `from` stamped, SDP passed through — so this service never learns that a camera was added, only that the peers want to re-agree. It is deliberately **not** `call.answer`: that frame is answer-once and drives ringing→active, so reusing it would restart a call that is already up. Refused while the call is unanswered, because a second exchange would race the answer's own description.
- **A call's media kind is server-stamped from the invite, like every other call fact** (phase 2.5). `Call.Media` lives on the Redis record and is copied onto `.started`/`.ended`/`.missed`, so `messenger-service` can project it into `calls.media` and a history row can say "Video call" instead of inferring it from a duration. It is **how the call was set up**, not what is flowing right now — a mid-call camera toggle is renegotiation, and whether that promotes the recorded kind is phase 2.5 slice 3's decision, not settled here.
- **`ice_failures_total` is client-reported.** The server relays opaque candidates and cannot observe an ICE failure, so it arrives as `call.hangup{reason:"ice_failed"}`.

## The room model and targeted signaling (phase 3 slice 1, 2026-09-14)

A 1:1 call has two fields and a derived peer. A mesh does not, so slice 1
replaced the pair with a **room**: an invited set, a joined set, and frames that
name their target.

**Two sets, deliberately kept apart.**

- `Call.Participants` is the **invited set**, resolved from conversation
  membership when the call is created and **never widened afterwards**. It is
  the entire authorization surface for signaling.
- `call:<id>:members`, a Redis **hash** keyed by owner id, is who has actually
  joined. Mutable, and each join or leave is one atomic `HSETNX`/`HDEL`.

Keeping them apart is what holds the hot path at one read: relaying a candidate
needs only the invited set, and a real ICE gather emits dozens of candidates in
a second or two. It is also why membership is a hash rather than an array on the
call record — a read-modify-write of a participant list races for real, and two
people joining in the same tick would lose one of them.

**The join race is per owner, not per call.** The 1:1 answer lock was one
`SETNX` on `call:<id>:answered`, which decides which of *one person's* tabs
wins. In a group three people may accept at once and each must win their own,
so the hash field is the owner id — the same first-wins semantics, one key
instead of two, and winning the race and being recorded as present become the
same fact. The losing tabs still get `answered_elsewhere`.

### Reconnecting, and why it is server-side

A place in a call is held by a **connection**, and connections die — a reload, a
flaky network, a closed laptop. Two rules make that survivable, and they are a
pair: neither works alone.

**A closing socket takes itself out of every call it was in** (`releaseCalls`).
Before this a dropped tab sat in the call as a participant nobody could hear
until the Redis TTL, and in a mesh that is everyone else waiting on a peer that
is gone rather than one person. A 1:1 call ends outright, carrying the reason a
hang-up would have carried, so the surviving peer sees the same frames either
way instead of a frozen tile.

**A session may take its own place back** (`HJoin`). A reloaded tab arrives as a
*new connection carrying the same session*, which is the one case where "someone
already holds this" means "you do". `session_id` is client-generated and stable
per browser tab across a reload — `sessionStorage` is exactly that primitive.
It is **optional**: without one a client gets plain first-wins, and a reload
simply waits for its old socket's close, which is the common ordering anyway.

The two rules close the race in **both** orderings, which is why neither is
sufficient by itself:

| Ordering | What happens |
|---|---|
| Old socket closes, then the tab rejoins | Field removed, the new connection wins outright |
| Tab rejoins, then the old close is processed | Same session takes the field over; the stored `conn_id` is now the new one, so the late close is a **conditional no-op** |

That second row is why removal is conditional on `conn_id`: an unconditional
`HDEL` there evicts a live tab from a call it is sitting in. `LeaveIfHeldBy`
answering false is the normal outcome for a superseded connection, not a
failure.

**The takeover must not become last-writer-wins.** An invite rings every tab a
person has open, so a *second* tab joining must still lose — otherwise a call in
progress moves to the wrong window. The discriminator is the session, not the
connection: same session is a reload, different session is a second tab. An
empty session never matches another empty one.

Both halves are atomic Redis scripts (`internal/kv/redis.go`), because a
read-then-write lets a reload and a second tab interleave on the same field —
and the whole point of the primitive is that exactly one connection holds a
person's place at any instant.

### Targeted signaling — the authorization surface this adds

Until now the peer was **derived**, and deriving it is exactly what made ringing
a stranger impossible. A mesh has to let the client name its target, so the
name is checked instead (`resolveTarget` in `internal/wsapi/calls.go`):

1. the sender must be in the call's invited set;
2. a named `to` must be in it too, **and must not be the sender**;
3. an absent `to` is derived, and only a two-person call can derive one — in a
   group it is `bad_frame`.

Rule 3 is what keeps every client written before the mesh working with no change
at all: it sends no `to` and gets the behaviour it always had. The 1:1 e2e suite
is the proof and was run against this code unchanged.

Two failure modes are guarded explicitly because neither is visible from a
green suite: a candidate **broadcast to the room** leaks one pair's network
paths to a third party, and a candidate targeted at **yourself** is echoed
straight back. Both have tests that were proven to fail against the unguarded
relay.

**Who offers in each pair: the lexicographically lower owner id**
(`calls.Initiator`). This is Matrix MSC3401's full-mesh rule — *"for any two
participants, the one with the lexicographically lower user ID is responsible
for calling the other"* — and it is deliberately **not** "whoever was already in
the room offers to the newcomer": two people joining in the same instant each
see the other as the newcomer, so arrival order is not knowable to both sides
while owner ids are. It settles who *starts*; a genuine collision is still
resolved by perfect negotiation in the browser, which is a separate rule and
already built (and already uses the same lexicographic comparison, so there is
no second ordering concept).

The server never enforces the pairing — it cannot, since it does not parse SDP.
It publishes the joined set with every `call.participant` frame, and both ends
compute the same answer from it.

### Leaving is not hanging up

In a 1:1 they are the same act. In a group they are not, so `call.hangup` from a
group participant removes that person, announces `call.participant{state:left}`
and leaves everyone else talking. The call ends only when it is spent:

- **nobody left joined** → ends with the reason the last person gave;
- **active, and fewer than two joined** → ends with `empty`, a server reason no
  client may assert. A mesh of one is a person looking at themselves.
- **still ringing** → exempt. One invitee declining must not cancel the ring for
  everyone else still being called.

### The cap

`MAX_CALL_PARTICIPANTS` (default 4) is a **mesh** limit — every peer holds N-1
connections and uplinks its own video N-1 times — not a policy one. A group
conversation holds 50 (`MAX_GROUP_PARTICIPANTS` in `messenger-service`), so
calling in one larger than the cap is refused at **invite** time with
`not_supported` and a message naming both numbers.

Note that the invite cap makes the join-time cap unreachable through normal use:
a call can never be created with more invitees than the mesh holds. The
`ErrFull` path on join is defensive, covered at registry level, and would only
fire if the cap were lowered while a call was live.

### Closing a call when the process holding it dies (2026-09-15)

`releaseCalls` ends a call when a socket drops, and it walks the connections
this process tracks **in its own memory**. That is the right place for a socket
dropping and exactly the wrong place for the process itself dying. An instance
killed, crashed or rolled during a deploy took the only closer of its calls with
it: the Redis record expired an hour later in silence — **expiry publishes
nothing** — so `call.ended` was never emitted and `messenger-service`'s
projection kept `ended_at NULL` **forever**. The thread then offered to join a
call that had not existed since Tuesday. dathq named the pattern rather than the
instance: *"the data is wrong when there's a bug happen."*

The fix is not fewer crashes. It is making the closing of a call reachable by
somebody other than the process that started it:

- **Instance liveness.** Every instance heartbeats `rt:instance:<id>`
  (`INSTANCE_HEARTBEAT_SECONDS`, TTL `INSTANCE_TTL_SECONDS`) and stamps its id
  on every member it writes. The TTL is several beats on purpose: a missed beat
  under load must not declare a healthy instance dead and tear down live calls.
  **Being slow to reap is harmless; reaping a live call is not.**
- **The member hash cannot answer this alone.** Its fields are armed with the
  *call's* TTL, so after a crash they are still there holding connections that
  no longer exist — "has no members" stays false until the whole call expires.
  That is why liveness is a separate key rather than an inference.
- **`FindOrphans` requires *every* member to be dead.** One survivor means
  somebody is still sitting in the call, and their own socket close will end it
  through the ordinary path with the right reason. A member with no instance id
  (written before this existed) counts as alive — refusing to reap is the safe
  direction.
- **`Registry.End` is a claim, not a command.** It consumes the call record
  first and reports whether *this* caller removed it. A call can be ended by a
  hang-up, by the last socket closing and by another instance reaping it, and
  those can coincide; without the claim the same call publishes `call.ended`
  twice and the projection writes two history rows. `endCall` now claims before
  it announces.
- **`realtime_service_calls_reaped_total`** counts what it ends. A steady zero
  is the healthy state and a rising line says instances are dying mid-call —
  which is the thing worth alerting on, since the calls themselves are already
  being cleaned up. Without it the mechanism works silently and nobody learns
  that it had to.
- The reaper runs **at boot and on `CALL_REAP_INTERVAL_SECONDS`**. Boot is the
  one that matters: the commonest orphan by far is a call this very service was
  holding before it was restarted.

Orphans end as `hangup` rather than a reason of their own — what a stranded
participant experienced is a call that stopped, and inventing an `orphaned`
end-reason would force a migration in `messenger-service` for a distinction
nobody reading their own call history wants drawn. The operational truth is in
the log line, which names the stranded members.

⚠️ **This is layer one of two.** It cannot help when the *event* never arrives
at all — NATS down, the consumer stopped, the message dead-lettered — so
`messenger-service` bounds an unfinished row by time as well. See
`services/messenger-service-architecture.md` § Calls that never reported an
ending.

### One call per conversation (2026-09-15)

A conversation holds **at most one live call**, claimed atomically in
`Registry.Create` as `call:conv:<conversationID>` via `SET NX GET EX`. A second
invite is refused with `call_exists`, and the refusal **carries the existing
call's id** — because the only useful answer to "a call is already happening
here" is to join that one, which is what the client does with it.

dathq asked what happens when a third person presses Call during a call, and the
answer was bad enough to be worth writing down. There was no check at all, so a
second call was created, everybody already talking was rung again, and the
browser's **glare** rule did the damage: written for two people dialling each
other in a 1:1 — where somebody must yield — it made whoever sorted lower hang
up the call they were *in* to take the new ring. Each person decided
independently, so the group could split across two calls; and a departure that
left one person behind ended their call as `empty`. **One press could empty a
room.** Every mainstream client (Messenger, Teams, Slack, WhatsApp) makes this
impossible by construction, and so does this now.

Three details are load-bearing:

- **The claim is inside `Create`, not in `handleInvite`.** A check-then-create
  leaves a gap in which two simultaneous invites both find the conversation free
  — which is exactly the case this exists for. `SET NX` is one round trip, so
  one wins and the loser is handed the winner's id.
- **A claim whose call is gone is taken over, not obeyed.** The slot is armed
  for its call's lifetime, so an instance dying between ending a call and
  releasing the key would make that conversation uncallable for the rest of the
  TTL — a worse failure than the one being prevented. `claimConversation`
  verifies the named call still exists and steals the slot when it does not.
- **`Activate` re-arms it** from `CALL_RINGING_TTL` to `CALL_ACTIVE_TTL`, and
  `End` deletes it alongside the call and its hashes. A claim expiring under a
  live call would let a second call be created in a conversation that is plainly
  busy; a claim outliving its call is the stale case above.

Verified against the real server, because `SET NX GET` is Redis **7.0+** and a
Go fake cannot tell you that: Redis 7.4.9, first `SET k v NX GET EX 45` returns
nil (the win), the second returns the holder and does not overwrite, TTL armed.

### The record of who was on a call (slice 2, MERGED !181, 2026-09-15)

Two sets are not enough for history, because the member hash answers *who is
here now* and loses somebody the moment they leave. A person who joins a
four-way call and drops out early was still on it. So a third, **append-only**
set — `call:<id>:joined` — records everyone who ever joined, is read before
`End` clears it, and rides the event as `joined_ids` alongside the invited
`participant_ids`.

`joined_ids` is sent **even when empty**, deliberately: absent and empty mean
different things to a projection, and "nobody picked up" is a fact rather than
missing information.

**A group's missed call is published once per person who did not answer**, each
naming that person in `owner_id` and `missed_owner_id`. Before this a group
missed call carried an empty `owner_id`, and notification-service skips any
envelope without one (`consumer.ts`) — so it was not a bad row, it was **nobody's
bell ringing at all**. A 1:1 missed call still attributes to the callee, unchanged.

### What is left for the client half

The server side of reconnecting is complete. What slice 3 owes it is the
`session_id` itself: a value stable per tab across a reload, which in a browser
means `sessionStorage` (`localStorage` would be shared by every tab of the
window and would make two tabs look like one, which is precisely the case the
discriminator exists to tell apart). Until it is sent, reconnect degrades to
close-then-rejoin rather than breaking.

This also **closes two phase-2 limitations**: a caller who closes the tab while
ringing now releases the callee immediately instead of leaving them ringing to
the 30 s timeout, and a dropped socket mid-call ends a 1:1 rather than leaving
state to the TTL. The instance-local ring timer is still not survivable across
an instance dying mid-ring — that one needs a durable scheduler and is still not
worth it.

Unanswered invite times out at 30 s (`CALL_RING_TIMEOUT_SECONDS`) → `call.missed`, and both sides are released so the caller's ringback stops too.

**Known limitation:** that timer lives on the instance that took the invite. If that instance dies mid-ring the call is never marked missed — the Redis TTL still reclaims the state and nobody is left in a call, so the loss is one history row. Making it survivable needs a durable scheduler, which is not worth it for an event meaning "nobody picked up". The same applies to a caller who closes the tab while ringing: no `call.hangup` is sent, so the callee rings until the timeout, exactly as it would on a network drop.

## Rate limiting

Every connection carries **two token buckets** (`internal/wsapi/ratelimit.go`, built 2026-09-09). Before phase 2 nothing capped inbound frame rate at all — `typing.start` already published to NATS unbounded — and `call.invite` made it cheaper to abuse, because each one allocates a Redis key plus a 30 s ring timer.

| Bucket | Burst | Refill | Applies to |
|---|---|---|---|
| `frames` | 120 | 40/s | **every** inbound frame |
| `state` | 5 | 0.5/s | `call.invite`, `call.join` and `conversation.open` |

Two buckets rather than one because the costs differ by orders of magnitude. **`call.ice` is legitimately bursty** — a real ICE gather emits dozens of candidates in a second or two, and every one must relay — so a single bucket wide enough for trickle ICE would be far too generous for the frames that allocate. Conversely the tight bucket cannot be the only one, or flooding a cheap type would go uncapped: every frame is charged to `frames` **first**, so draining it limits the expensive types too.

- **Per connection, not per owner.** No shared state is needed, and `WS_MAX_CONNECTIONS_PER_OWNER` already bounds how many buckets one person can hold. With a 30 s ring timeout and 0.5/s refill, concurrent ringing calls per owner settle around 75 — bounded, with no distributed counter.
- **A refused frame gets one `rate_limited` error per second**, however many are dropped. Answering frame for frame would turn an inbound flood into an outbound one. The socket is never closed — it may be carrying a call.
- **Idling banks nothing beyond the burst**, so a quiet connection cannot save up an allowance and spend it at once.
- Hand-rolled rather than `golang.org/x/time/rate`: that package is not vendored here, and a token bucket is forty lines. Revisit only if a second limiter is ever needed.
- Metric: `realtime_service_frames_rate_limited_total{bucket,type}`.


## TURN credentials

`GET /turn-credentials` (via gateway, JWT-protected) returns `{ data: { ice_servers, ttl, relay } }` — `ice_servers` goes straight into `RTCPeerConnection`.

coturn runs in `use-auth-secret` mode. The service computes `username = <expiry_ts>:<owner_id>`, `credential = base64(HMAC-SHA1(TURN_STATIC_SECRET, username))`, TTL about five minutes, issued per call. **The static secret lives in this service's `.env` only and never reaches the browser** — long-lived TURN credentials in a SPA bundle are a relay-bandwidth theft vector. The expiry inside the username is what makes the grant self-limiting: coturn recomputes the HMAC from the username it is handed and rejects anything past that timestamp, with no shared state.

### Two credential schemes

**HMAC (preferred, the default).** coturn's `use-auth-secret` mode, described
above: a signed, expiring, owner-bound credential.

**Fixed pair (`TURN_USERNAME` + `TURN_PASSWORD`), added 2026-09-13.** When both
are set they are served verbatim and `TURN_STATIC_SECRET` is ignored. Every
hosted relay authenticates this way, and without it this platform could not use
one at all — which mattered the moment a real cross-network call was attempted
from a CGNAT connection, where a self-hosted coturn cannot be reached by the
far peer and no port forward can fix it (see `platform/platform-backlog.md`).

It is the **weaker** scheme on purpose and is warned about on every boot: the
credential never expires and is not tied to an owner, which is precisely the
relay-bandwidth theft vector the HMAC design avoids. It is appropriate only for
a provider that issues one credential for everybody, and **never** for our own
coturn. Half a pair — a username with no password — falls back to signing
rather than shipping a broken credential.

Proven end to end on 2026-09-13 against `global.relay.metered.ca`: the fixed
credential reached the browser unchanged, the relay allocated
(`typ relay 172.104.172.212`), and a laptop↔phone video call ran over that pair
with zero packet loss.

- **Unconfigured TURN is a supported state, not a failure.** With no `TURN_STATIC_SECRET` or no `TURN_URLS` the endpoint serves **STUN only** and says so with `relay: false`, which is enough for two tabs on one machine and fails behind symmetric NAT. Half-configured (a secret with no URLs, or the reverse) is treated as unconfigured and **warned about at startup**, so it is not discovered when a call fails to relay.
- `Cache-Control: no-store` is set: credentials are per-owner and expire in minutes, so a cache anywhere on the path would hand one owner's grant to another.
- The scheme's HMAC-SHA1 is **not a design choice** — it is what the coturn REST API defines. The Go import carries a `//nolint:gosec` saying so. The unit test asserts against a credential computed *outside* Go, so it proves interoperability with coturn rather than agreement with our own code.

**Local coturn (2026-09-09).** `_local/docker-compose.yml` runs `coturn/coturn:4.6-alpine` in `use-auth-secret` mode, opt-in (`docker compose up -d coturn`) because every published UDP relay port is a separate forward through the colima VM. **`.env.example` ships every WebRTC value filled in, including the secret** — locally it is not one: `datha-local-turn-secret` is the literal fallback baked into the compose file, so copying the example gives a working relay with no manual step (decision 2026-09-09; an `_local/.env` was tried and deleted as dead weight). Deployed environments generate their own and keep it in Key Vault. The two sides must match or nothing relays, and a mismatch is **silent** because two peers on one machine always connect directly — `docker inspect datha_platform_coturn --format '{{json .Args}}'` is the five-second check. Details and the failure modes: `always-apply/local-environment.md` § Docker.

**Interop is proven, and so is the relay itself.** A credential minted by `GET /turn-credentials` was fed to `turnutils_uclient` inside the container and coturn **allocated**; the same username with a forged signature produced **zero** allocations. Then real Chrome, with `iceTransportPolicy: "relay"` so host and reflexive candidates are discarded outright, connected **relay↔relay** through coturn and moved **17 KB of media each way** (2026-09-09). So the HMAC scheme is accepted, checked, and carries traffic.

Two caveats from that measurement:

- **Only the TCP transport works locally.** Offered only `transport=udp`, Chrome gathers no relay candidate at all; offered only `transport=tcp`, it connects and media flows. The cause is host→VM UDP forwarding, not coturn — its UDP listener answers from inside the container. Details and the real fix in `always-apply/local-environment.md` § Docker. Calling is unaffected, because Chrome picks the working transport itself.
- **Cross-network relay is still unverified**, and needs `TURN_EXTERNAL_IP` plus a router port-forward — a container otherwise advertises an address only the host can reach.

## Env vars

| Var | Purpose |
|-----|---------|
| `PORT` | listen port (default `3004`) |
| `REDIS_URL` | presence, typing, live call state |
| `NATS_URL` | core fanout + JetStream publish of `call.*` events |
| `TURN_STATIC_SECRET` | coturn `use-auth-secret` shared secret — **never** sent to a client |
| `TURN_URLS` | comma-separated `turn:`/`turns:` URLs handed to the browser |
| `STUN_URLS` | comma-separated `stun:` URLs |
| `TURN_CREDENTIAL_TTL_SECONDS` | default `300` |
| `CALL_RING_TIMEOUT_SECONDS` | unanswered invite → `call.missed` (default `30`) |
| `CALL_TTL_SECONDS` | ceiling on live call state in Redis (default `14400`). Cleanup after a crashed instance, **not** a call-duration limit — a call ending normally deletes its own state |
| `MAX_CALL_PARTICIPANTS` | how many people one call may hold, caller included (default `4`). A **mesh** limit, not a policy one — a group conversation holds 50 |
| `WS_MAX_CONNECTIONS_PER_OWNER` | multi-tab guard (default `5`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional, gates OTLP logs as elsewhere |

## Metrics

`realtime_service_ws_connections`, `realtime_service_ws_frames_total{type,direction}`, `realtime_service_signaling_relay_total{outcome}`, `realtime_service_call_setup_total{outcome=connected|failed|timeout|declined|hangup|busy}` (`connected` means *signaling* completed — ICE can still fail after it), `realtime_service_ice_failures_total` (client-reported), `realtime_service_turn_credentials_issued_total{outcome=ok|stun_only|error|unauthorized}`, `realtime_service_frames_rate_limited_total{bucket,type}`. Prometheus target :3004 in `platform-observability`. `X-Correlation-ID` propagated onto every published event.

## Design rules

1. **No domain state.** If it must survive a restart, it belongs in `messenger-service` or an event.
2. **Never parse SDP.** Relay opaque payloads; media negotiation is the browsers' business.
3. **Server stamps identity**, always; membership is checked before any relay. **And identity extends to the other party** — the invited set of a call is derived from conversation membership, never accepted from the frame. A mesh lets a client *name* which invited person a frame is for, and that name is validated against the invited set on every single frame; it never widens it.
4. **Set semantics for unread**, never counters — duplicates then cost nothing and drops self-heal.
5. **Core NATS for live frames, JetStream for the record.** A durable consumer here would redeliver stale frames on reconnect.
6. **`platform-nats` owns topology** — this service connects only (critical-behaviors #7).
7. **Authorization behind `Authz.can()`** with the `input` schema in `products/messenger-architecture.md`, so OPA is later a swap and not a rewrite.

## Related rules

- **`products/messenger-architecture.md`** — the product this serves, phases, security rules
- **`services/api-gateway-architecture.md`** — stream-token pattern, header injection, CORS ownership
- **`platform/platform-notifications.md`** — the single-instance SSE limitation this design corrects
- **`platform/platform-nats-architecture.md`** — durable ownership
- **`lang/lang-go.md`** — Go conventions
