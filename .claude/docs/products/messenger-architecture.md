# Messenger — product architecture (phase 1 complete, phase 2 next)

_Messenger product: chat, presence and WebRTC calling across the platform — repos, transport, shell integration, phases_

> **Status 2026-09-09: PHASE 1 COMPLETE AND MERGED** (15 PRs, !148-!162). Text chat, presence, typing, read receipts, the unread badge, the header popover **and attachments** all work end to end over `messenger-service` (:3005), `realtime-service` (:3004) and the gateway's `/api/messenger/*` + `/api/realtime/{token,ws}` routes. Exit criteria met: two clients exchange messages live with no polling (verified by the `RT_LIVE=1` integration test), the socket half holds no state that a reconnect cannot rebuild, and — as of 2026-09-08 — **the multi-instance criterion is verified** against a second instance on :3014 (see the phases table).
>
> **Nothing is open for phase 1.** Both new repos have ADO repos, pipelines (15/16), branch policies, `.env` files and the build-service grant; the `platform-nats` subject addition merged as !148. Phase 2 starts with coturn — see § Phases.
>
> **Deliberately not in phase 1:** conversation deletion and its orphan-file cleanup (needs the `file-service-messenger-cleanup` durable), group creation UI, and everything in phase 2 (WebRTC).

## Product shape

Messenger-style product on the platform: 1:1 and group text chat, presence, typing, read receipts, attachments, and **1:1 audio/video calls over raw WebRTC**. Group calling comes later through an SFU.

The stated purpose is **practising WebRTC**, which sets one constraint the rest of the platform does not have: phase 2 builds `RTCPeerConnection`, perfect negotiation and trickle ICE **by hand**. Reaching for LiveKit early would skip exactly what this product exists to teach.

## Repos

| Repo | Stack | Port | Owns |
|---|---|---|---|
| `accounts-service` | Node TS + Fastify 5 + pg | 3006 | users, directory, workspaces, memberships — spec already written: **`services/accounts-service-architecture.md`** |
| `realtime-service` | **Go** | 3004 | the browser's one persistent WebSocket: presence, typing, signaling relay, TURN credentials. Platform-level, not Messenger-only — **`services/realtime-service-architecture.md`** |
| `messenger-service` | Node TS + Fastify 5 + pg | 3005 | conversations, messages, receipts, call history. Durable domain state |
| `messenger-frontend` | Angular 21, MF **remote** | 4003 | product UI + the shell header widget |

Infra addition: **coturn** in `_local/docker-compose.yml` (3478/5349, relay range 49160-49200).

Reused unchanged: `api-gateway` (auth + routing), `file-service` (attachments), `notification-service` (missed calls), `event-store` (event log), `shared-frontend` (chrome), `platform-nats` (topology).

## Why `realtime-service` is separate, and Go

Durable domain state and ephemeral connection state have opposite scaling and failure profiles. Chat history wants Postgres, transactions and retries; ten thousand idle sockets want cheap concurrency and no database at all. Splitting them means a signaling deploy can never endanger message history, and each half scales on its own axis.

Go suits the socket half and costs no new toolchain: `api-gateway` already establishes `lang/lang-go.md` and the `stack-go-gotestsum` pipeline. The chat half stays a Fastify twin of `event-store` / `notification-service`, inheriting those conventions wholesale.

## Transport

| Path | Mechanism | Why |
|---|---|---|
| Send a message | **REST** → `messenger-service` | durable write, idempotent, retriable. Never a WS write path with no durability behind it |
| Receive a message | WS from `realtime-service` | |
| Presence, typing, SDP/ICE | WS, both directions | signaling is inherently bidirectional; SSE + POST costs an HTTP round trip per ICE candidate |
| Service → service | JetStream `EVENTS` | platform default, unchanged |
| Live fanout to sockets | **NATS core** `rt.owner.<owner_id>` | |

`messenger-service` publishes twice — JetStream for the record, core NATS for the wire. That is **not** two sources of truth: JetStream is the log, core is transport. A durable consumer would be actively wrong here, since it would redeliver stale chat frames on every socket reconnect.

**Learned from `notification-service`:** its SSE fanout is in-memory and single-instance by its own admission (`platform/platform-notifications.md`). `realtime-service` uses core NATS fanout from day one, so N instances need no sticky sessions and it never inherits that limit.

## Shell integration — header widget, not an app tile

The app launcher is for **destinations you navigate to**. Messenger is also an **ambient layer that must be live on every page** — ringing, unread badge, open socket — and no tile can carry that, which is why the header slot exists.

The two are not exclusive, and Messenger has both (dathq, 2026-09-06): the widget for the ambient half, plus a normal `environment.apps` entry, because the product has a real destination — the **Overview** page that documents the stack, matching every other frontend on this platform. The original rule here said "absent from `environment.apps`"; that conflated *ambient behaviour needs a slot* with *therefore it must not be a tile*.

Instead the remote exposes a **second federated module** and the shell renders it in a named header slot. Contract and failure behaviour: **`services/shell-frontend-architecture.md` § Header widget slots**.

```js
// messenger-frontend/webpack.config.js
exposes: {
  './Module':       './src/remote-entry.ts',        // routed product at /messenger
  './HeaderWidget': './src/header-widget-entry.ts', // icon + popover (standalone component)
}
```

The shell never imports Messenger code — it loads a descriptor from `environment.headerWidgets`. The boundary holds: **shell owns the slot, remote owns the content.** This is why the widget cannot live in the shell the way the notification bell does — the bell is chrome (it renders any service's events), Messenger is a product.

**The useful side effect:** loading the widget at login keeps the remote alive for the whole session, so its root-provided realtime store owns the socket from login onward rather than from the first visit to `/messenger`. That is what makes ring-from-anywhere and a live badge work at all. Preload on idle after first paint so login stays fast.

## UI

| Surface | Behaviour |
|---|---|
| Header icon | badge = unread **conversations**, capped at `9+`; click opens popover |
| Popover | ~20 recent conversations, presence dots, `+ New message`, `See all in Messenger`. **No search** — see below |
| Click a conversation | navigates `/messenger/t/:id` |
| Narrow screen | icon navigates straight to `/messenger`, no popover |
| `/messenger` | **Overview** (stack + flow diagrams, the education page every frontend has), then three-pane chat (list / thread / detail). `datha-sub-header` tabs: Overview, Chats, later Calls and People. The **composer lives inside the thread**, never in an unselected pane — as every mainstream messenger does |
| Message bubbles | Messenger-style: grouped runs with run-aware corner radii, one avatar per incoming run beside its last bubble, **the bubble holds content and nothing else** — no name, no time, no status |
| Call UI | full-bleed inside the remote: remote video, local PiP, mute / camera / device picker / hangup |
| Active call after navigating away | compact dock in the **shell overlay host** — timer, mute, hangup, return to call |
| Incoming call | ring UI in the same overlay host, so it works from any app |

**Bubbles carry no name or timestamp** (2026-09-10). A name *and* a time in
every bubble made a thread roughly twice as tall as its content. Messenger's
model rather than Slack's, because the layout is already asymmetric bubbles —
Slack's full-width rows with a persistent name gutter would fight it:

- **Name**: dropped entirely in a direct thread (the header already says who);
  shown only in a **group**, on the first bubble of a run.
- **Time**: always in the DOM as `<time datetime>` with a full `title`, but
  revealed on `:hover` **and** `:focus-within`, and mirrored to the inside edge
  for own messages. `visibility`, not `display`, so nothing reflows under the
  pointer. Hover-only would be invisible to keyboard and screen-reader users,
  hence the focus half and the title.
- **When was this, at a glance**: a centred separator whenever the gap from the
  previous message is over an hour or the day changes — what both references do
  once per-message stamps are gone.
- **Status never goes in the bubble.** Read state is a property of the
  *conversation* and is shown as the **readers' avatars** at the foot of the
  thread (Messenger's model — it also answers *who*, which is the only useful
  shape in a group), and **only while our own message is the newest**. A reply
  is itself proof of reading, so pinning the marker to the last own message
  parked "Seen" in the middle of the conversation with their newer reply below
  it. Nothing is shown for merely-sent. In-flight (`pending`) and `failed` are
  per-message but live in the trailing slot beside the bubble, sharing it with
  the timestamp. `ChatStore.readersOf` is the single source of that logic.
- **The trailing slot is out of flow**, anchored absolutely to the bubble.
  Held in the flex row it reserved the width of the timestamp it was hiding —
  63px of dead strip down the right that own bubbles could never cross
  (reported 2026-09-10). Absolute against the bubble hugs it at any width and
  shifts nothing on hover. Consequence for tests: the bubble's `scrollWidth`
  now legitimately exceeds its `clientWidth`, so anything measuring text
  overflow must measure `.message-body`, not `.message-bubble`.
- **Avatars fall back to an initial.** Google's `lh3.googleusercontent.com`
  pictures do not always load in a third-party context; images carry
  `referrerpolicy="no-referrer"` and an `(error)` handler, because a broken
  image icon beside a message is worse than no picture.
- **Runs break at a separator**, or the message above a "Yesterday" marker
  stays grouped with the ones below it and loses its avatar to a run it is no
  longer visually part of.

### Layout: why bubbles and not a single column

Slack and Discord put every message in one left-aligned column with a name and
avatar gutter; Messenger, WhatsApp, iMessage and Telegram alternate left/right.
Single column wins for long-form content, code, many participants and fast
vertical scanning, and it gives metadata an obvious home. Bubbles win for 1:1,
because position alone encodes identity.

Bubbles, for four reasons specific to this platform: Messenger here is the
**personal** product (sibling to chatbot, not to the event-store ops UIs) and
its content is short conversational text; phases 1 and 2 are entirely 1:1;
`chatbot-frontend` already uses left/right bubbles, so a single-column
messenger beside it would be the inconsistency; and phase 3's docked mini chat
windows are a Messenger-shaped decision already taken. The cost accepted:
attachment cards and future link previews are width-limited, and groups will
have to show name and avatar always (as WhatsApp and Telegram groups do).

**Revisit before phase 3** if Messenger becomes a team tool with long-form
posts, code blocks, threads or many participants — that is a migration, not a
tweak.

### Loading a thread: skeleton, not blur

A thread opened by URL knows its id before it knows anything else, so the
stage, the header name and the messages all arrive at different moments. Two
faults made that visible (both 2026-09-10): the stage waited for the
conversation **detail** even though the id was already set, flashing the "Pick
a conversation" pane on every reload; and `loadingThread` was flagged only
around the *messages* fetch, so a thread whose conversation was still loading
fell through to "No messages yet" — an empty thread rather than a loading one.
The stage is now gated on the id, and the loading flag covers the whole open.

The placeholder is a **skeleton** of the layout it is about to become — bubble
shapes in the right places, plus name and presence bars in the header. Not a
blur: blur-up (LQIP) needs a low-resolution version of the real thing to blur,
and there is no low-res version of a message you have not fetched. Apple's blur
is a *material* for layering translucent chrome over content, not a loading
state. Shimmer is a gradient sweep rather than a pulse, because a pulse reads
as broken, and it is disabled under `prefers-reduced-motion`.

### The call panel lives on `body`, not in the header

`CallDockComponent` is mounted by the header widget — that is what makes a call
survive navigation — but its **host element is re-parented to `document.body`**
in the constructor. The shell's toolbar carries
`backdrop-filter: blur(14px) …`, and a backdrop-filter **creates a containing
block for fixed descendants**, so `position: fixed; bottom: 1rem` resolved
against the *toolbar*: an incoming call rang in the top-right corner of the
screen (reported 2026-09-10). Re-parenting keeps the component owned by the
widget while its DOM escapes the containing block — cheaper than pulling the
CDK overlay across the Module Federation boundary for one panel.

Only the **shell** can catch this: the standalone remote has no toolbar and no
trap, so the regression test lives in `shell-frontend/e2e/specs/header-widget.spec.ts`
and asserts the dock is not `closest("p-toolbar")`.

**The dock is one row** — identity left, two **equal-size circular** controls
right. A labelled pill beside a small outlined circle is what made it look
thrown together. **Mute is not offered while dialling**: there is no microphone
stream to mute until the call connects, so the control did nothing.

**Muted is a filled danger button plus a slash drawn in CSS.** PrimeIcons 7
ships no `pi-microphone-slash` (nor `pi-phone-slash`), so asking for it drew an
**empty circle** — the muted state was invisible, and so was the end notice's
icon (reported 2026-09-10). `call-dock.component.spec.ts` now asserts every
`pi-*` in the dock resolves to a real glyph via its `::before` content, which
required adding `primeicons.css` to the **test** styles in `angular.json`; it
was only in the build styles. That check names the offender directly:
`pi pi-microphone-slash renders no glyph`.

**An incoming call is a centred modal**, over a dimmed backdrop, with the
Accept button focused and Escape to decline — it is asking a question, and
Messenger and Slack both present one this way. Everything else (dialling,
connecting, in a call, the end notice) stays a bottom-right dock, because it
must not block the app being used. The peer is hydrated via
`ChatStore.ensurePerson` on ring: a call can come from someone you have no
thread with, which otherwise rang as a raw `google_…` owner id.

### A local send must survive the first page landing

`appendToThread` drops rows for a conversation with no page loaded — correct
for an inbound socket frame, since opening it will fetch the page anyway.
It is **wrong for the user's own send**: the page may still be in flight, and
the response cannot contain a message that did not exist when it was
requested. Sends therefore pass `local = true` (seeding an empty thread), and
`setThread` **merges** anything absent from the fetched page instead of
overwriting, sorting by `createdAt`.

The same race has an **inbound** half: a `message.new` landing in that window
was dropped outright and lost until a reload, so `appendToThread` keeps frames
for the **open** conversation too (`local || activeId === conversationId`).

Both found 2026-09-10 by chasing two specs that had been written off as flaky.
The outbound one showed the attachment as the conversation's latest message in
the sidebar while the thread never displayed it; the inbound one failed 2 runs
in 12 with the thread holding only its original message. Unit specs in
`chat-store.service.spec.ts` pin both deterministically — a repeated pass is
evidence, not proof.

Note for anyone writing those specs: the merge dedupes on `clientMessageId`, as
it must in production, and the shared `message()` fixture defaults to a single
one — two rows built from it collapse into one unless given distinct ids.

### Other behaviours the majors have and we now match

- **Scroll follows only from the bottom.** Pinning on every new row yanked a
  reader out of the history they had scrolled up to read. Within 48px of the
  end counts as following; otherwise a **Jump to latest** button appears.
- **Composer grows** with the draft to its max height. `rows="1"` with no
  growth made the `max-h-32` unreachable, so a multi-line draft scrolled inside
  a single line.
- **`overflow-wrap: anywhere`** on message bodies. An unbroken token overflowed
  the bubble by 321px; hyphenated URLs happened to wrap and hid it.
- **Typing is animated dots**, and honours `prefers-reduced-motion`.
- **Separators say Today / Yesterday**, not a raw date.
- **The message list is `role="log"` with `aria-live="polite"`**, and the
  timestamp is revealed on `:focus-within` as well as `:hover`, so neither new
  messages nor times are mouse-only.

**Read state is not "did you send something"** (2026-09-10). A thread counts as
read on open, on window focus / tab visibility, on composer focus and on
typing — not only on send. The arrival path stays gated on `document.hasFocus()`
(a visible tab behind another app is not being read), and the *return* path is
the window `focus` + `visibilitychange` listener in `ChatStore`, which also
drives the `resyncUnread()` that was documented as running on tab focus and
never had a subscriber. `markReadUpToNewest` is idempotent per newest message
id, because typing now calls it on every keystroke.

**Popover has no search box** (2026-09-10). It is a glance surface: a search
input, a results state and an empty-match state inside a 320px panel is three
extra states for a list of ~20 rows that already fits. Searching lives one
click away behind *See all in Messenger*, where the page has room for the
directory too. The panel's arrow is also re-centred on the trigger in
`header-widget.component.ts` — PrimeNG anchors it to the target's *left* edge,
which only lines up when the panel is left-aligned, and this trigger sits at
the right of the header.

**A new conversation is created by its first message, not by picking someone**
(2026-09-10). Choosing a person from the directory routes to
`/messenger/chats/new/:ownerId` — a draft that writes nothing. The row is
POSTed by the first message or attachment, then the URL is *replaced* with the
real conversation id. Before this, a misclick in the directory put an empty
thread in **both** people's lists permanently. The draft is linkable and
survives reload because the person is in the URL rather than in memory, and it
offers no call button: there is no conversation to invite anyone into yet.
`createDirectConversation` is idempotent on the sorted participant pair, so a
double submit resolves to one conversation.

**Popover lists conversations only.** A People section would mean a second data source (`accounts-service` directory), a second presence subscription for users you are not talking to, and a second empty state, all inside a 400px panel. Presence still shows, as dots on the conversation avatars, from the socket already held. Directory and people search live on the **People tab**, where there is room.

**Badge counts unread conversations, not messages.** Less alarming, and materially more robust: the client holds a **set of unread conversation ids** and the badge is `set.size`. Every delta is a union or a delete, so duplicate frames are free and a dropped frame self-heals on the next event or reconnect — the same idempotency reasoning the notification projection already uses. A numeric counter corrupts permanently on one duplicated frame and gives no signal that it drifted. Five messages in one thread also cost zero badge frames after the first. Cleared when the thread is opened **and** the tab is focused; the full set is resynced on reconnect and on tab focus.

**Messenger unread never enters the notification pipeline.** `message.sent` stays unmapped in `notification-service`, exactly as chatbot's is. If it were mapped, one new message would light both the bell and the badge — the "two mechanisms reporting one event" problem the working agreement forbids. Only `call.missed` crosses over, because by then Messenger has nothing live left to show.

## Identity and authorization

**Provisioning:** the shell calls `POST /api/accounts/users/me/sync` after login; `accounts-service` upserts on the gateway-injected `X-Owner-ID` / `X-User-Email` / `X-User-Name`. Idempotent, and needs no gateway change.

Considered and rejected: extending `events.gateway.auth.login` with email, name and picture. It works, but `event-store` retains events for 90 days — that turns the event log into a PII store to save one HTTP call.

**Authorization is in-app for now**, as `services/accounts-service-architecture.md` phase 1 prescribes: membership checks against Postgres. The seam that makes OPA a swap rather than a rewrite is a single interface, `Authz.can(subject, action, resource)`, in both `messenger-service` and `realtime-service` — plus the `input` schema written down **before** any code, so Rego can later be authored against a contract that already exists:

```jsonc
{
  "subject":  { "owner_id": "google_1102…", "tenant_id": "…", "roles": ["member"] },
  "action":   "message.send | message.read | conversation.read | call.invite | call.join",
  "resource": { "type": "conversation | call", "id": "…", "tenant_id": "…", "participants": ["…"] }
}
```

When the OPA segment is unlocked, `can()` points at the sidecar and the schema does not move. Facts stay in `accounts-service`, decisions move to Rego — the division of labour that doc already specifies.

## Security rules

The parts where an expedient choice has a real cost, so they are rules rather than suggestions.

1. **TURN credentials must be short-lived.** coturn runs in `use-auth-secret` mode; `realtime-service` issues `username = <expiry_ts>:<owner_id>`, `password = base64(HMAC-SHA1(secret, username))`, TTL about five minutes, handed out per call. The static secret lives in that service's `.env` only and never reaches the browser. Long-lived TURN credentials shipped in a SPA bundle are a relay-bandwidth theft vector.
2. **WebSockets are not subject to CORS.** The browser sends no preflight on an upgrade, so the gateway must explicitly validate the `Origin` header against the existing `CORS_ORIGINS` allowlist before proxying. Skipping this leaves the socket reachable from any origin holding a stolen token.
3. **Keep the WS stream token short-lived** — 60-120 seconds, not the hour used for the SPA JWT. It travels in the query string because `WebSocket` cannot set headers, and query strings land in access logs and proxy telemetry. It is needed only for the moment of connect.
4. **The server stamps identity on every relayed frame.** `realtime-service` never trusts a client-supplied `from`, and relays a signaling frame only after confirming the sender is a participant of that call.
5. Media is DTLS-SRTP encrypted end to end by the WebRTC spec, including when relayed — coturn forwards ciphertext it cannot read. A property to preserve, not to work around.

## Gateway changes

| Change | Note |
|---|---|
| Routes `/api/accounts/*` ✅ **done 2026-09-06**, `/api/messenger/*` | ordinary proxy entries. The accounts route ships with `X-User-Picture` injection so avatars are not blank — the gateway had the `picture` claim all along and never forwarded it |
| `GET /api/realtime/token` | JWT-protected, mints a scoped stream token with `jti="realtime"` — the pattern already built twice (chatbot SSE, notification SSE) |
| `/api/realtime/ws` upgrade-capable proxy | Go's `httputil.ReverseProxy` handles Upgrade natively; must validate `Origin`, disable response buffering, and set no read timeout on the hijacked connection |
| `GET /api/realtime/turn-credentials` | proxied to `realtime-service`; JWT-protected |

No new auth primitive is introduced anywhere.

## Events

Standard envelope (**`platform/event-store-architecture.md`**); `service` is `messenger-service` or `realtime-service`.

| Subject | Published by | Consumed by |
|---|---|---|
| `events.messenger.conversation.created` | messenger-service | event-store |
| `events.messenger.message.sent` | messenger-service | event-store (deliberately unmapped for notifications) |
| `events.messenger.conversation.deleted` | messenger-service | event-store, file-service (attachment cleanup) |
| `events.messenger.call.started` / `.ended` / `.missed` | realtime-service | event-store, messenger-service (call history projection), notification-service (`call.missed` only) |

Topology PRs needed in `platform-nats` (that repo owns every durable — critical-behaviors #7):

- `messenger-service-calls` on `EVENTS`, filtered to `events.messenger.call.*` — call history is a **projection**, therefore replayable; idempotent on envelope id like every other consumer.
- `file-service-messenger-cleanup` if attachments follow the delete choreography in **`platform/chatbot-file-events.md`**. Copy that story rather than inventing a second one.

`notification-service` needs **no** topology PR — its `EVENTS` durable has no filter subject and its mapping is service-side config.

## Media topology

| Participants | Approach |
|---|---|
| 2 | **P2P mesh**, no media server. STUN plus coturn for TURN. The phase-2 build, and the actual WebRTC practice |
| 3-4 | mesh still tolerable; uplink cost grows as N² |
| 5+ | **SFU** — LiveKit self-hosted. Deferred past phase 3 (see § Phase 3), because the phase's own exit criterion is a **4-way** call and mesh reaches that |

Perfect negotiation (polite / impolite peer) from the start; it removes the whole class of glare bugs rather than patching them later.

## Phases

| # | Content | Exit criteria |
|---|---|---|
| **0** ✅ | `accounts-service` phase 1 + directory; gateway route + avatar (!136); header-slot registry in shell; `messenger-frontend` skeleton at 4003 (Chats empty state + header widget). `SHELL_CONTEXT` needed no work — the shell already provided it at root and the widget needs nothing the contract lacks | sign in → your user row exists; empty widget renders in the header; shell still boots with the remote stopped — **all verified live 2026-09-06** |
| **1** ✅ | `messenger-service` + `realtime-service`; text chat, presence, typing, receipts, attachments, popover + badge | two browsers exchange messages live with no polling — **verified**. The **multi-instance criterion is verified too, 2026-09-08**: a second `realtime-service` was started on :3014 and the whole `RT_LIVE` suite (6 scenarios, including REST-write → socket, presence and typing authz) passed against **instance #2** while every REST write still went to `messenger-service` — so fanout really does reach whichever instance holds the socket, with no sticky sessions and no shared connection table. Killing #2 left #1 serving, suite still green. What is still unverified: the **browser's** reconnect through the gateway, because minting a session JWT needs the HS256 secret in `api-gateway/.env` — a file agents never read. `replaySubscriptions()` is covered by unit specs only |
| **2** ✅ | **WebRTC 1:1** — raw `RTCPeerConnection`, perfect negotiation, trickle ICE, coturn, call dock, ring, call history, `call.missed`. **Slice 1+3 done 2026-09-09 (unmerged):** `realtime-service` has the signaling relay, live call state, `call.*` JetStream events and `GET /turn-credentials`, all verified live — details in `services/realtime-service-architecture.md`. **Slice 2 done the same day:** the gateway route `GET /api/realtime/turn-credentials`, plus a per-connection rate limiter in `realtime-service`. **Slices 4+5 done the same day:** the `messenger-service-calls` durable in `platform-nats` (reconciled; the `EVENTS` stream already carried `events.messenger.>`, so no stream change was needed) and the history projection plus two read routes in `messenger-service` — verified live from socket to `GET /calls`, and replayed twice with no duplicate rows. **coturn done the same day** — `_local/docker-compose.yml` runs it in `use-auth-secret` mode, opt-in, and coturn was proven to accept a credential this platform minted and to reject a forged one. **`call.missed` → bell done too** (`notification-service` mapping + `NOTIFICATIONS.CALL_MISSED.*` in `shell-frontend`), verified live: an unanswered call put a bell row on the **callee**. **The browser half landed 2026-09-09 too** — `WebrtcCallService` (glare resolved by owner id, trickle ICE with a candidate queue, cached TURN fetch), `RingAudioService` (synthesised ring plus the gesture unlock autoplay demands), and the **call dock mounted in the header widget** so a call survives navigation. Along the way it exposed and fixed a phase-0 gap: nothing had ever called `POST /users/me/sync`, so the directory was empty and nobody could find anyone — see `services/shell-frontend-architecture.md` § Account provisioning. **A real two-party call is VERIFIED 2026-09-10** — the `calls` project passes both specs, four consecutive runs, against the live stack: ICE connects, the duration ticks, the call survives leaving Messenger by client-side routing, hangs up cleanly, and a declined call reaches the caller. Getting there exposed three defects in the *suite* (it had never been run): `page.goto` for the navigation step tore down the SPA and the peer connection; the target route mounted a remote that was not running; and it never waited for the **callee's** socket, so the ring fanned out to nobody. Details in `platform/platform-backlog.md`. **Still outstanding: the cross-network relay criterion**, which needs `TURN_EXTERNAL_IP` plus a router port-forward. **The call dock belongs in the already-mounted header widget**, not a routed component — that is what satisfies "navigate to `/chatbot` mid-call", and it means **no shell-frontend change at all** | navigate to `/chatbot` mid-call and audio never drops — **verified 2026-09-10**. **Closed 2026-09-11 with one criterion carried forward, and that criterion was SATISFIED 2026-09-13:** a laptop (home FTTH behind CGNAT) and a phone on 5G connected **through a TURN relay** — nominated pair `prflx ↔ relay` over UDP, `succeeded`, RTT 121 ms, 9.6 MB received with **zero** packet loss on both audio and video. It needed no `TURN_EXTERNAL_IP` and no port-forward (impossible here — the router's WAN is a private `10.138.78.140`), but it did need a **hosted relay** and therefore fixed-credential support in `realtime-service`. Evidence and the relays probed: `platform/platform-backlog.md` |
| **2.5** | **1:1 video** — camera tracks, real SDP renegotiation, video call UI; plus **call rows in the thread**. Scoped out of phase 2 by an inconsistency in this document, not by a decision — see § Phase 2.5 | a 1:1 video call connects, the camera toggles **mid-call** without dropping audio, and every call leaves a row in the conversation |
| **3** | **Group chat UI** (slice 0, done 2026-09-14), then group calls over a **mesh**, then docked mini chat windows (same overlay host). Screen share already shipped in 2.5 | 4-way call stable |
| **4** | OPA rollout platform-wide, `accounts-service` as the facts store | Rego bundle deployed, `can()` swapped, no schema change |

## Phase 2.5 — 1:1 video and call rows

Planned 2026-09-11, after dathq tested the audio call and asked for FaceTime-style
video and for calls to appear in the chat the way Messenger does.

**Why this is its own phase rather than part of 3.** This document has said from
line 1 that the product is *"1:1 **audio/video** calls over raw WebRTC"*, and
§ UI has always specced the call panel as *"remote video, local PiP, mute /
camera / device picker / hangup"*. But `WebrtcCallService` carries the comment
*"Audio only in phase 2; video and screen share arrive with the SFU"*, and phase
3's row lists only **group** calls. So 1:1 video fell through the gap between two
rows — an inconsistency in the plan, not a decision anyone made. An SFU is for
3+ participants; a 1:1 video call is the same `RTCPeerConnection` with a second
track and needs nothing from phase 3.

### Slice 0 — measure the audio before changing it 🔧 (instrumented 2026-09-11)

**Two of the three suspects are now eliminated by dathq, not by argument.** He
called with **headphones on and the far end muted**, which rules out the
acoustic feedback loop, and confirmed on 2026-09-11 that those headphones are
**wired** — so the Bluetooth HFP/SCO narrowband path is out too. The remaining
candidates are the network path, the capture settings, and CPU contention from
two peer connections on one laptop, and none of them can be told apart by
reasoning.

So the measurement is built rather than described: `helper/call-diagnostics.ts`
reduces an `RTCStatsReport` to exactly the fields that separate those causes,
`WebrtcCallService.diagnostics()` samples it, and the dock logs one line every
5 s **in development builds only**. Remove that probe once the question is
closed — it exists to answer one thing, not to ship a logger.


dathq reported audio that connects both ways but is *not clear* (2026-09-11).
Same machine, two browser contexts, **headphones on, far end muted** — which
rules out the acoustic feedback loop that is otherwise the first suspect.

Do not touch constraints until a call has been measured. `pc.getStats()` during
a live call answers it in one step:

- `inbound-rtp`: `packetsLost`, `jitter`, `concealmentEvents` → network vs capture
- `candidate-pair` (the nominated one): `relay` vs `host`, and the protocol —
  colima does not forward published UDP ports, so a local relay pair is **TCP**,
  which adds jitter that looks exactly like a bad mic
- `codec`: confirm Opus and its `clockRate` — a Bluetooth headset flipped into
  HFP/SCO to open its microphone drops to a narrowband path, and the result is
  muffled in **both** directions because both peers share the one device
- `media-source`: `echoCancellation` / `noiseSuppression` / `autoGainControl` as
  actually applied, since `{ audio: true }` (`webrtc-call.service.ts`) relies on
  browser defaults rather than asking

Only then decide between explicit constraints, a codec preference, or "this is a
one-laptop artefact and disappears across two machines". Changing three things
at once and declaring it fixed is what this slice exists to prevent.

### Slice 1 — media kind, end to end ✅ (2026-09-11)

**Built across three repos, all suites green:** `realtime-service` 10 packages,
`messenger-service` 69 specs (up from 65), `messenger-frontend` 92 (up from 88).
`platform-nats` needed nothing, as predicted. Every new assertion was proven to
fail against the pre-change code first.

`Call` (`realtime-service/internal/calls/calls.go`) has no media field, so
nothing downstream can tell an audio call from a video one.

- `Call` gains `Media string` (`audio` | `video`), resolved server-side from the
  invite and stamped on every `call.*` event, the same rule already used for
  `CallerID` / `CalleeID`
- `call.invite` and `call.incoming` carry it, so the callee's ring UI can say
  *"Incoming video call"* and pre-arm the camera permission prompt
- `calls` table gains `media TEXT NOT NULL DEFAULT 'audio' CHECK (media IN
  ('audio','video'))` — migration `004_calls_media.sql`. The default is what
  keeps the existing rows valid and the projection replay-safe
- No `platform-nats` change: `events.messenger.>` already carries these subjects
  and only the payload grows

### Slice 2 — capture and render ✅ (2026-09-11)

**Verified live 2026-09-11**: a real two-party **video** call between two
browser contexts connects, renders both streams, minimises and hangs up. Driven
headed and screenshotted rather than assumed — which is how two layout defects
were found that every unit spec had passed over.

**The call UI is Meet's shape, not Messenger's** (reworked 2026-09-11 after
dathq called the first pass ugly). Messenger opens a video call in a separate
browser **window**; we cannot, because a new document destroys the
`RTCPeerConnection` and surviving navigation is a phase-2 guarantee. So it is
Slack's model instead: a video call **expands in place** over a blurred scrim,
with the identity chip and a rounded control bar floating over the picture, and
**minimises back to the dock** without dropping the call. Audio calls never
expand — a voice call has nothing to look at, so a full-screen panel would only
be in the way. An incoming ring never expands either; it already has its own
centred treatment, and it shows **no video stage at all** — nothing flows until
the call is accepted, so a stage there is a black rectangle. Messenger and
FaceTime both show the avatar alone.

**Call controls are inline SVG, not the icon font** (2026-09-11). PrimeIcons
ships no slashed microphone or camera, and the CSS slash drawn over the plain
glyph looked exactly as bolted-on as it was. A stroke set gives real "off"
glyphs and one weight across every control, and the glyph spec now checks both
kinds: an icon-font class that does not exist has no `::before` content, and an
`<svg>` with no geometry is the same failure in a different costume.

**Two defects only a screenshot caught**, both after the suites were green: the
"Audio is blocked by the browser" warning **latched** — set when autoplay was
refused on attach, never cleared when playback started a beat later, so it sat
in red for the whole call. It now clears on the element's `playing` event. And
the expand control was still an icon-font glyph while everything beside it was
SVG.

⚠️ **Specificity trap, hit on the first attempt.** `:not()` and `:has()` each
contribute their argument's specificity, so `.call-dock:not(.is-ring):has(.call-stage)`
(0,4,0) silently outranked `.call-dock.is-stage` (0,2,0) and the expanded call
rendered at the **compact** 22rem width. The compact rules now exclude
`.is-stage` explicitly rather than the stage selector being escalated. Nothing
errored and every spec passed — only a screenshot showed it.


**A missing camera must never fail a video call.** Meet, Zoom, Teams and
Messenger all let you join without one: your tile shows an avatar and you still
see the other person, because *receiving* video needs no camera at all. So
`openLocalMedia` asks for the camera, and on any failure retries with audio
alone and adds a **`recvonly` video transceiver** — without which the offer
carries no video and a missing webcam would silently blind *both* sides. If the
audio-only retry fails too it was never a camera problem, and the original
cause is rethrown and surfaced by name.

The first attempt at this disabled the video-call button on a camera-less
device. That was wrong, and dathq said so: it removes a call that would have
worked. Degrade, never refuse — `hasCamera` now only greys out the in-call
camera toggle and changes a hover hint.


**Built.** 101 specs. The remote `<video>` is muted and sound stays on the
service's own detached `<audio>`, so the autoplay unlock stays in one place —
and a spec pins it, because the first implementation used a bare `muted`
attribute, which Angular sets **after** element creation and which therefore
leaves the DOM property `false`. The peer would have been audible twice.

- `AUDIO_ONLY` becomes a pair of constraint sets; video asks for a sane frame
  size rather than whatever the camera defaults to
- Remote `<video>` full-bleed, local PiP, both `playsinline` and the local one
  `muted` — an unmuted local preview is an instant feedback loop
- Camera toggle and a device picker beside the existing mute control
- The call dock keeps a thumbnail when the user navigates away, so the existing
  "call survives leaving Messenger" guarantee still visibly holds

### Slice 3 — real renegotiation ✅ (2026-09-11)

⚠️ **Ending a share is not the mirror image of starting one.**
`replaceTrack(null)` stops frames but leaves the m-line, so the receiver's
`<video>` sits on the **last frame it received** — stopping looked like nothing
happened (2026-09-11). `removeTrack` ends it properly, but then the receiver
has a second problem: `removeTrack` fires **`mute`**, not `ended`, and a peer
merely switching their camera off fires `mute` too. The two are
indistinguishable as events. What separates them is the transceiver's
`currentDirection` — a removed track renegotiates the m-line out of receiving,
a disabled camera leaves it receiving a muted track — and that value is only
trustworthy **after** the exchange is applied, so it is checked at the end of a
renegotiation rather than off the event.

**A shared screen is a SECOND video track, never a replacement for the
camera.** This was the real defect behind three rounds of layout complaints: a
share swapped out the camera track, so a tile could hold a face *or* a screen
but never both — and once two people shared, neither could see the other at all
(dathq, 2026-09-11, with a Meet screenshot showing **four** tiles: two
presentations and two people). No arrangement of two sources can produce four.

That needs the peer to tell a second video track apart from a camera, which
nothing in WebRTC says on its own. `call.renegotiate` therefore carries
`screen_stream_id` — the msid of the stream carrying the screen — relayed
opaquely by `realtime-service`, which no more understands "screen" than it
understands SDP. The id and the track can arrive in either order, so both paths
re-file whatever is currently known.

The stage is then two regions: **presentations**, side by side and equal when
there are two, and **the people**, who shrink to a strip when someone is
presenting but never disappear. Verified live with all four tiles carrying
video at once.

**Superseded:** an earlier pass made the stage a grid of equal tiles, one per
participant. That arrangement was tried first and is wrong for
this product: with **both** people sharing a screen it can only ever show one
of them properly and drops the other into the corner where an avatar belongs
(dathq, 2026-09-11). Equal tiles also removes the swapping logic entirely —
each element always carries its own side's stream, so nothing can end up the
wrong way round. `grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr))`
puts two tiles side by side wherever there is room and stacks them when there
is not.

**A self-view is mirrored; a shared screen never is.** An unmirrored camera
preview reads as someone else's camera, but mirrored text is unreadable.

**A tile with no picture shows an avatar, never the words "No camera"** — body
text in a video tile reads as an error. Initials for both sides; the store
knows our own name, so our tile gets a real one too.

**Once a call has carried video it keeps the stage.** Dropping back to the
compact audio dock the moment a share ended yanked the panel out from under
both people. Meet keeps the layout and shows avatars, and so do we: the ended
stream is cleared so nothing renders a frozen frame, but `media` stays `video`
until the call ends or someone minimises it.

**Both sides may share at once** and both screens are fully visible, measured
side by side at equal size with live video in each. Which tile is "the
presentation" is not knowable here — nothing in the protocol says whether an
incoming track is a camera or a screen, and the server never parses SDP — so
every tile is simply a participant, which needs no such distinction.

**Limit worth stating:** one peer connection carries **one video track each
way**, so the stage tops out at two sources. Sending a camera *and* a screen at
once needs a second video track per peer, and a real multi-tile grid only earns
its keep with more than two participants — both belong with the SFU in phase 3.

⚠️ **`object-fit: cover` is wrong for a shared screen.** It crops to fill,
which flatters a face and silently cuts the edges off whatever someone is
presenting. The expanded stage uses `contain`; the compact dock keeps `cover`,
because a thumbnail has no room to letterbox.

It paid for itself immediately: **screen sharing** is `getDisplayMedia` plus
`replaceTrack` on an existing video sender, or `addTrack` on an audio call —
which fires `onnegotiationneeded` and goes through the same collision guards as
any other track change. The browser's own "stop sharing" button fires `ended`
on the track and must be honoured, or the UI claims to still be sharing a
screen the browser has already taken back.


**Built, option 2 as recommended.** `call.renegotiate` relays a mid-call offer
or answer; the browser runs the full perfect-negotiation rules —
`onnegotiationneeded`, a `makingOffer` flag, and politeness decided by owner id
so both peers reach the same verdict without asking each other. A call becomes
video when a video **track** arrives, rather than via a second flag the two
sides have to agree about separately.

**This is the slice with actual risk, and the one worth doing by hand.** Today
the perfect-negotiation rule is applied at *glare* level only — two simultaneous
invites, resolved by comparing owner ids (`webrtc-call.service.ts`). There is no
`onnegotiationneeded` handler and no frame for a second offer: `call.answer` is
answer-once.

Turning a camera on mid-call is exactly a renegotiation. Two ways:

1. **Negotiate video up front only.** No renegotiation, much less code — but the
   camera can never be turned on during a call, which is the thing that was asked
   for.
2. **Full perfect negotiation.** Add `onnegotiationneeded`, the `makingOffer` /
   `ignoreOffer` guards and `setRemoteDescription(rollback)` on the impolite peer,
   plus a renegotiation frame the relay already knows how to authorize.

**Recommend 2.** This product exists to practise WebRTC, and glare-on-renegotiation
is the part of the pattern that is genuinely hard. Doing 1 first and 2 later means
writing the state machine twice.

### Slice 4 — calls in the thread ✅ (2026-09-11)

**Built, merged client-side** — the open question is answered that way for now:
the merge is presentation, and rebuilding a shipped route's paging contract to
carry two kinds of row costs more than this earns. Worth revisiting if the
thread ever pages backwards, which is where paging two lists in step stops
being cheap. Call rows carry a synthetic message anchor so one sorted list holds
both kinds; separators are re-derived **after** the merge, because a call can
become the row a day boundary falls on.

The data is already there and nothing renders it: `messenger-service` runs the
history projection and serves `GET /calls` and `GET /conversations/:id/calls`,
with `end_reason` and `duration_seconds` per row.

- A system row in the timeline, merged by timestamp with messages — not a bubble.
  Messenger, WhatsApp and iMessage all render this as a centred line with an icon
- Copy follows `end_reason` + `media`: *"Video call · 4:12"*, *"Missed call"*,
  *"Call declined"*, and the callee's missed row offers a call-back
- Open question for dathq: fetch these on thread open and merge client-side, or
  have `GET /conversations/:id/messages` return them as one ordered timeline.
  The second is cleaner to page and is how the majors do it; it is also a change
  to a route phase 1 already shipped

### Slice 5 — testing on two machines (last, after the features are built)

dathq's sequencing, 2026-09-11: build every 2.5 feature first, then do the
two-machine pass.

**One setup, two network conditions.** An earlier draft of this plan proposed a
separate no-tunnel LAN setup for media quality and a tunnel setup for the relay
criterion. dathq pointed out they collapse into one, and he is right — the
tunnel setup is a strict superset, and it needs *fewer* hacks than the LAN one
(HTTPS removes the insecure-origin flag, a real redirect URI removes the
`localStorage` paste).

The reason they collapse: **the tunnel carries the app load and the signaling,
never the media.** WebRTC media is peer-to-peer whatever origin served the page,
so the media path is decided purely by where machine 2 sits:

| Machine 2 is on | ICE picks | What it tests |
|---|---|---|
| the same wifi | direct **host** candidates, TURN unused | audio/video quality with the network taken out of it — two real mics and cameras, no shared Bluetooth device, no two peer connections on one CPU |
| a **phone hotspot** | **relay** through coturn | the cross-network relay exit criterion left open by phase 2 |

Run the wifi condition first. If audio is clean there and bad on the hotspot, it
is the relay path; if it is bad on both, it is capture. That distinction is the
whole point of doing two conditions, and it costs one wifi toggle rather than a
second setup.

**Before any of it**, the free check on a single machine: swap the Bluetooth
headphones for **wired** ones and redial. If the muffling disappears it was
HFP/SCO dropping to narrowband, there is no bug, and the rest of this slice is
only needed for the relay criterion.

#### Setup

dathq has used **free Cloudflare quick tunnels with random URLs** before, and
that is enough — a quick tunnel's URL is stable for the life of the
`cloudflared` process.

1. **Three origins, not one.** The browser fetches `remoteEntry.js` from :4003
   and calls the gateway on :8080 directly, both cross-origin from the shell, so
   tunnelling the shell alone leaves a broken page
2. `--host 0.0.0.0` on both frontends — they bind `127.0.0.1` today (verified
   with `lsof`, 2026-09-11), so nothing outside the machine can reach them
3. `allowedHosts` for each dev server, which otherwise rejects a request whose
   `Host` header it does not recognise. Always forgotten, and it fails in a way
   that looks like the tunnel is broken rather than the app
4. An environment variant pointing `baseUrl`, `redirectUri` and the remote
   entries at the tunnel hostnames — `environment.ts` hardcodes `localhost` for
   all of them — plus the gateway's allowed origins
5. Only the **shell** URL needs registering as a Google redirect URI. With a
   random quick-tunnel URL that is one console edit per tunnel restart. A named
   tunnel on an owned domain removes even that, worth it only if this becomes
   routine
6. Sign in normally on machine 2 with the second Google account. No
   `localStorage` seeding and no Chrome flags — the whole reason to prefer this
   over a LAN IP

ngrok is the alternative, not a companion — running both is two things to
debug. Its free tier gives one static domain but only one endpoint, which does
not cover three ports.

⚠️ A tunnel publishes the gateway to the internet for as long as it runs. That
is the one condition that makes the `JWT_SECRET` pasted on 2026-09-10 actually
matter — **rotate it before the first tunnel run**, not after.

### Repos touched

`messenger-frontend` (most of it), `realtime-service` (media kind + the
renegotiation frame), `messenger-service` (migration, projection, read routes),
and this document. **Not** `platform-nats`. PR order is the usual one:
platform-nats → backends → api-gateway → remotes → shell-frontend.

### Testing

The existing `calls` Playwright project already drives two browser contexts with
fake media devices, so video is a constraint change rather than new harness. The
renegotiation slice needs the test that matters: **toggle the camera mid-call and
assert audio never drops** — the exit criterion, written as a spec. Per the
working agreement it must be proven to fail against the pre-renegotiation code
first.



## Phase 3 — group chat, then group calls

Planned 2026-09-14. The row above used to read "group calls via SFU", which
skipped a prerequisite and pre-picked a media topology. Both were revisited
before any code was written.

### What was already there, and unreachable

`messenger-service` shipped the **whole** group surface in phase 1 — create with
a title, rename, add participants, leave, `MAX_GROUP_PARTICIPANTS=50`, and an
authz split between admin actions and member ones. It had **no caller**: the
only create path in `messenger-frontend` hard-coded `{ type: "direct" }`, so
four working, tested endpoints could not be reached from the product.

That is the shape of defect worth naming: not a bug in either half, but a
missing seam between them that no test on either side could see. A group call
is impossible without a group conversation, so phase 3 opens with the UI, not
with media.

### Mesh before SFU — dathq's call, 2026-09-14

The exit criterion is **"4-way call stable"**, and § Media topology has always
said mesh is tolerable at 3-4. So the SFU was never forced by the criterion.

| | Mesh (chosen) | LiveKit SFU |
|---|---|---|
| Connections per peer | N-1 | 1 |
| Uplink per peer | N-1 × own video | 1 × own video |
| Browser code | the `RTCPeerConnection` stack already built and debugged | replaced by `livekit-client` |
| Signaling | this platform's socket | a second plane alongside it |
| Ceiling | ~4 | 50+ |

Mesh wins here on the thing this product exists for: phase 2 hand-built perfect
negotiation, trickle ICE and the glare guards precisely as WebRTC practice, and
adopting an SFU client SDK would delete that. The SFU becomes its own later
phase — and by then the **room model** (which mesh needs too) already exists, so
it is a media swap rather than a rewrite.

⚠️ Behind CGNAT a self-hosted LiveKit has the same reachability problem coturn
has, so an eventual SFU phase needs a hosted instance to be testable from here.

### Slices

| # | Content | Repo |
|---|---|---|
| **0** ✅ | Group chat UI: create, member list, rename, add people, leave, group avatars — **MERGED !179, 2026-09-14** | `messenger-frontend` |
| **1** ✅ | Room model: invited set + joined set, `call.join`, `call.participant`, targeted signaling with a validated `to`, mesh cap, **reconnect** (disconnect-driven leave + session takeover) — **MERGED !180, 2026-09-14** | `realtime-service` |
| **2** ✅ | `call_participants` projection, nullable `callee_owner_id`, per-person group missed events — **MERGED !181 + !182, 2026-09-15** | `realtime-service`, `messenger-service` |
| **3** ✅ | Mesh in the browser: `Map<ownerId, PeerLink>`, N-tile grid, group call button, group call history, and the per-tab `session_id` from `sessionStorage` — **4-way call verified 2026-09-15**, the phase exit criterion | `messenger-frontend` |
| **4** ✅ | Docked mini chat windows — **MERGED !189, 2026-09-17**. Phase 3 complete | `messenger-frontend` |

⚠️ **Slice 1 added an authorization surface**, and this is the part to read
before touching it. Mesh signaling frames carry a **target owner id**, where a
1:1 call derived the peer — and deriving it is exactly what made ringing a
stranger impossible. So the naming is validated instead: the sender must be in
the call's invited set, a named target must be in it too and must not be the
sender, and an absent target is derived only when the call has exactly two
people. The invited set is resolved from conversation membership at creation and
**never widened**. Full design in
`services/realtime-service-architecture.md` § The room model and targeted
signaling.

Two mesh-specific leaks are guarded with tests proven to fail against the
unguarded relay: a candidate **broadcast to the room** hands one pair's network
paths to a third party, and a candidate targeted at **yourself** is echoed
straight back to the sender.

A group holds 10 (lowered from 50 on 2026-09-16, a product cap while the
platform is unpaid) and a mesh survives about 4, so `MAX_CALL_PARTICIPANTS`
(default 4) refuses a call in a larger conversation at invite time.

**Who offers in each mesh pair is the lexicographically lower owner id**
(Matrix MSC3401's rule), not "whoever was there first" — two people joining in
the same instant each see the other as the newcomer. It reuses the comparison
perfect negotiation already makes in `webrtc-call.service.ts`, so there is no
second ordering concept to keep in step.

### Slice 0 — what shipped (2026-09-14)

`messenger-frontend` only; no backend change was needed, which is the point.

- **Compose dialog gained a group mode.** Picking one person is still a single
  click that **writes nothing** — the conversation is created by the first
  message — because a group cannot work that way and the two must not be
  conflated. WhatsApp and Signal make the same split.
- **`messenger-avatar-stack`** renders a conversation's faces: one for a direct
  thread, two overlapping for a group. Capped at two deliberately — at the
  2.25rem the list uses, a third face is smaller than the letter inside it.
- **Group details dialog**: member list with admin badges, rename, add people,
  leave. Admin controls are hidden to match the server, which is the actual
  enforcement — the UI hiding is a courtesy.
- **A group reports a member count, not a presence.** Presence is a property of
  a person; a dot fed by "the first other participant" would claim something
  about whoever happened to be listed first.
- **The directory now resolves this user too.** `hydratePeople` had always
  excluded self, so the member list rendered the viewer's own row as a raw
  `google_…` id while every other row had a name.

Two defects were found by **looking at it**, not by a passing suite — see
`.claude/rules/working-agreement.md` for the generalised rules:

1. Adding a "New group" row above the search box made it the dialog's first
   focusable element, so **PrimeNG's own `focusOnShow` beat the manual focus**.
   Caught by an existing spec; fixed with `[focusOnShow]="false"` so one
   mechanism owns focus.
2. Both search boxes feed **one `distinctUntilChanged` stream**, so searching
   a word, closing the dialog, and searching the same word again silently
   returned nothing. Pre-existing; the second box only made it easy to hit.

Calling was still refused in a group at slice 0, so the thread offered no call
button there until slice 3 — see § Slice 3.

### Slice 0 — the conventions, and where they come from

dathq asked for "best practice, follow the big apps" (2026-09-14). The field was
surveyed rather than guessed at, and it does not agree on everything — where it
splits, the split itself was the answer.

**A group is named, and needs one other person** — dathq's call, 2026-09-14,
after trying both models in the running app: *"I like the force name with the
ability to create a group with 2 people better."*

The field divides on what a group *is*, and the two camps are each internally
consistent — which is the part that matters:

| | WhatsApp, Telegram, Signal (**chosen**) | Messenger, Slack, Teams, iMessage |
|---|---|---|
| What a group is | a first-class object with its own identity | an ad-hoc multi-person conversation |
| Minimum others | **one** | **two** — with one it is just the direct chat |
| Group name | **required** | **optional**, derived from members' names |

The pairing is one decision, not two. A required name is what *lets* a group
hold a single other member: it has an identity of its own, so it is never
confusable with the direct chat with that person. Leave the name optional and
the derived title is that one person's name — identical to the DM — which is
why the other camp needs two others instead.

⚠️ **Taking one rule from each camp is a bug**, and this build shipped it for
about an hour: a one-other minimum *and* an optional name produced a group
indistinguishable from the DM, which dathq reported with a screenshot. When a
field splits like this, take a whole camp.

`messenger-service` accepts a null title and a single participant, and still
does — "named, one other" is a product rule enforced in the compose dialog, not
a service constraint. The derived member-name title therefore stays as the
fallback for anything created through the API without one, and there is a spec
for that path.

**The header opens the details.** WhatsApp, Telegram and Messenger all do this.
The icon button stays as the visible affordance; the header is the target
people actually reach for.

**Participant names are colour-coded** (WhatsApp, Telegram). Derived from the
owner id in `helper/sender-tone.ts`, never from position in the participant
list, which reorders as people join and leave — a name that changes colour is
worse than no colour. Six hues, re-picked for the dark theme rather than
reused. Note the platform's ids all share a `google_` prefix, so a hash reading
only the first characters puts everyone on one colour: it looks like it works
and carries nothing.

**The list preview names the speaker** — "Alice: ship it?" — in groups only.
Universal across WhatsApp, Telegram, Messenger and Slack: in a thread with five
people a bare line says nothing about who is being replied to. A direct thread
keeps the arrow marking your own message instead, since there is only one other
person it could be from.

**The typing indicator is phrased by count**: one name, two names joined, then
"Several people are typing…". A joined list with a singular verb — "A, B is
typing…" — is what you get for free, and a group is exactly where it shows.

**Leaving is confirmed with a named action and a Cancel**, inline rather than in
a second modal over the first. A button that means something different on its
second press is a trap, which is what the first implementation did.

**A group's picture is the same for everyone.** It first rendered the *other*
members' faces, so in a three-way group each person saw a different pair — a
picture of everyone-but-you rather than of the group (dathq, 2026-09-14). It now
composites **all** participants, this user included, sorted by owner id so the
order cannot drift with whatever the participant list happens to return. Capped
at two faces: at the 2.25rem the list uses, a third is smaller than the letter
inside it.

This follows from the camp. A first-class group has an identity of its own — a
name everyone sees, and therefore a picture everyone sees. Viewer-relative
composites belong to the Messenger/Slack model, where the group *has* no
identity of its own and is described by who is in it. A direct thread is the
opposite case and still shows the counterpart only: there the tile answers "who
is this with", and your own face is not the answer.

**Deferred:** a **set** group photo, which is what Messenger and WhatsApp fall
back *from*. It needs a column on `conversations` plus an upload path through
file-service, so the composite is the default rather than the only option. Do
it when groups get real use.

**Selecting people is one component.** `modules/shared/person-chips` is shared
by creating a group and adding to one, because they are the same act — and they
had already drifted: the add-people panel shipped with only a row highlight, so
the moment the list scrolled you could not see who you had picked. Same
reasoning as `person-avatar`: one component, or three copies of the same rules.

**Not possible, and not faked:** removing *another* member. `messenger-service`
has `DELETE /participants/me` only, so an admin cannot remove someone. Worth a
route when groups get real use.

**Slice 2 note on repos.** The plan said `messenger-service` + `platform-nats`.
`platform-nats` needed **nothing**: the EVENTS stream already carries
`events.messenger.>` and the `messenger-service-calls` durable filters
`events.messenger.call.>`, which group events already match. `realtime-service`
did need a change, to publish who actually joined — the invited set alone cannot
say who missed the call. Worth reading the topology before inheriting a
planning-table entry.

**Still missing, and it is backend work:** `MessageKind` has carried `"system"`
since phase 1 and **nothing emits it** — a third capability declared on both
sides and implemented on neither. Every mainstream client writes "X added Y",
"X left", "X named the group Z" into the thread, and those events are exactly
what makes a group's history readable. It belongs with slice 2, where
`messenger-service` is already being opened.

### The call stage — one focused source, 2026-09-16 (MERGED !188)

Built after dathq used a three-way call with two screens shared and reported
"way too many dark space", then asked for "GG meet with personal pin". They are
one problem: the stage split itself between presentations, and two 16:10
sources in half-width cells are mostly letterbox.

- **One source holds the stage** — the pinned one, else the first shared
  screen. The rest sit with the people, one click away. Meet, Zoom and Teams
  all do this; equal tiling is an *opt-in* layout in Meet, not its default.
- **A screen tile takes the shape of its source**, read from the track's
  `videoWidth/videoHeight` and re-read on `resize`. `object-fit: contain`
  stays: cropping a shared screen hides the edge of somebody's code.
- **Pin is a *source*** (`{ownerId, kind}`), not a person — with two screens up
  "pin Dat Ha" cannot say which. **Local only**: it never reaches the wire, so
  `LiveCall` is untouched. Spotlight (the shared kind) needs a host concept
  this product does not have and is deliberately unbuilt.
- **A third state, "people"**, so a presentation can be taken off the stage
  entirely — Meet's "unpin the presentation to look at the people". A *new*
  share takes the stage back; a share merely ending does not.
- **The strip scrolls.** Four people may all share at once, so it can hold
  seven tiles; measured at 1268px of tiles in a 619px strip before the fix.
- **A speaking ring**, sampled per link from `getSynchronizationSources()`.
  A mesh has no server to name the active speaker, so each client works it out
  from its own inbound levels. Drawn as an `outline`, not a border, so nothing
  reflows three times a sentence.

⚠️ The 49-tile grid maths that Meet-style guides describe does **not** apply
here and should not be copied: it solves an SFU's problem. The mesh caps at
four, so the people grid is never more than 2×2.

### Slice 3 — the mesh in the browser ✅ (2026-09-15)

`messenger-frontend` only. `WebrtcCallService` went from one
`RTCPeerConnection` to `Map<ownerId, PeerLink>`, and a 1:1 call is now that map
with one entry rather than a separate code path — two mechanisms for one job is
how the expanded dock came to render at the compact width through 135 passing
specs (§ Phase 2.5).

**Reconcile, never a delta.** `call.participant` carries the **whole** joined
set, precisely so a client that missed a frame re-syncs — core NATS is
fire-and-forget. So every announcement recomputes links = joined set minus
self; `owner_id` and `state` feed the wording only. It also has to ignore
announcements for a call this tab has not joined: the fanout goes to everyone
*invited*, deliberately, so a still-ringing tab can watch the room fill up.

**Who offers: `Initiator`, the lexicographically lower owner id**, computed on
both ends from the joined set. The server never enforces it — it does not parse
SDP.

**The non-initiator must not fire its own first offer.** Adding local tracks
raises `onnegotiationneeded` on *both* ends of a fresh pair, and a group call is
already `active` by then, so the 1:1 guard ("not until active") lets both sides
offer into a collision on every single pair. The gate is per link: offer only
when we are that pair's initiator, or once its remote description exists. A
second gate skips a link with an offer already in flight.

**Handlers are attached before tracks are added**, because in a group that
`onnegotiationneeded` *is* the first offer, and a handler attached afterwards
misses the only event that would open the pair. A browser queues the event and
would forgive the order; nothing else would tell us.

**Links are built lazily from signalling too.** A peer's candidate or offer can
arrive before the announcement that they joined — different subjects, no
ordering between them — so candidates are queued per sender and an inbound
offer builds the link on demand, checked against the invited set first.

**One capture, one audio element per link.** `getUserMedia` runs once per call
and its tracks are added to every connection; playback is one detached
`<audio>` *per peer*, because three peers sharing one element means hearing
exactly one of them.

**A failed pair is one tile, not the call.** In a 1:1, ICE failure ends the
call; in a group it marks that person unreachable and leaves everyone else
talking.

**The size limit is not duplicated here.** `MAX_CALL_PARTICIPANTS` is
realtime-service's configuration, so the call button is offered in any group and
a conversation too large is refused at invite time — the client surfaces that
refusal instead of copying the number and going stale the day it is tuned. This
needed the client to start handling `error` frames at all: they answer the frame
that caused them and carry no call id, so one is claimed only while an outgoing
call is still ringing with no server id yet.

**`session_id`** is `sessionStorage`, per tab, surviving a reload — never
`localStorage`, which is shared by every tab of a window and would make two tabs
look like one, defeating the exact discriminator slice 1 built.

✅ **Auto-rejoin was built, found racy, and deleted the same day** — replaced by
click-to-join. See § Rejoining an ongoing call. What follows is why it existed.

⚠️ **Sending the session id is necessary and not sufficient**, which this slice
originally got wrong. Slice 1's note said the client owed it "the `session_id`
itself"; in fact the live call lived only in an in-memory signal, so a reloaded
tab had no idea it had been in a call and never sent `call.join` — the server's
takeover path had no caller. dathq found it by refreshing mid-call
(2026-09-15). The client half is now the **Join button** on the thread's
ongoing-call banner — see § Rejoining an ongoing call for why an automatic
rejoin was built, found to be a race, and deleted the same day. **Group calls
only:** a 1:1 is ended by `releaseCalls` the moment the socket closes, so
surviving a reload there needs a server-side grace period and a `reconnecting`
state on the wire — deliberately left as its own slice, because the trade
(every network blip freezing the other person's panel) is worth deciding on its
own.

Verified as a **real four-way call** (the phase exit criterion, and the mesh's
cap) across four browser contexts against the live stack: twelve directed media
streams over six connections, every tile measured for frames and for staying
inside the stage. Two defects came out of looking at it that no assertion about
classes could have seen — three tiles left an empty quadrant, and the trailing
tile now centres the way Meet, Teams and Zoom do.

### Where the call UI actually lives

Two halves, two hosts, and conflating them is a mistake worth not repeating
(2026-09-15): the call **buttons** are thread chrome in `messenger-frontend`, so
they render wherever the thread does — including standalone at **:4003** — while
the call **dock** was mounted only inside `HeaderWidgetComponent`, which only the
**shell** renders. `WebrtcCallService` is root-provided in the remote, so the
engine is present in both. Since 2026-09-15 the standalone layout mounts the
dock too, so both hosts have it; the split is still the thing to keep straight,
because it is what made the bug below invisible.

Until 2026-09-15 that left :4003 with a working call *button* and no call *UI* —
pressing it rang the other person for real and left this side with nothing to
look at and no way to hang up. **Fixed by mounting the dock in the standalone
layout**, never by hiding the button: a remote has to work without the shell,
which is the whole point of the architecture (dathq). Detail, and the
re-parenting bug the fix uncovered, in
`services/messenger-frontend-architecture.md` § Dual mode.

### Rejoining an ongoing call — click, don't guess (built 2026-09-15)

**dathq's call, and it is the right one:** *"for messenger they dont auto get
in. They click on the going on call on the chat."* The thread shows a call in
progress and you press Join.

The auto-rejoin built earlier in slice 3 — remember the call in
`sessionStorage`, re-send `call.join` on the socket's `ready` frame — is a race
by construction. It needs the socket open, capture reacquired, and the takeover
won, and each is a place it fails **silently**. Three separate failure modes
were found and fixed in one session (media awaited before the join, so the frame
hit a socket that had moved on and `RealtimeService.send` drops those without a
word; capture failing on a machine where several tabs contend for one
microphone, which abandoned the whole restore; and a lost takeover race whose
`answered_elsewhere` the restoring tab swallowed) — and **it still dropped him**,
with no named cause. Every automated test passed throughout, because fake
devices never lose a microphone race and a single-tab test never meets a rival.

Click-to-join has no race, and needs **no server change**: a live call is
already in the read model (`answered_at` set, `ended_at` null → status
`active`), and the thread already loads those rows into `ChatStore.callHistory`.
It is also strictly more capable — today, missing the ring means never being
able to join that call at all, which no mainstream client accepts.

What was built:

- the thread renders a **banner** under its header — `thread-live-call`, with a
  Join button — for any call in this conversation with no `ended_at` that this
  tab is not already in. A banner rather than a timeline row: the call has not
  happened in any past tense, and a row for it would sort to whenever it
  started, which on a long call is a long way from where anyone is looking;
- pressing it calls `WebrtcCallService.joinOngoing`, which sends the `call.join`
  that already existed and already did the right thing;
- `ChatStore.ongoingCall` is the selector, fed by the history fetch the thread
  already does and kept fresh by `call.participant`, which carries the whole
  joined set and so replaces the headcount rather than incrementing it. That
  frame names only a call, so the conversation comes from the `call.incoming`
  that rang — without which the banner never appears for anyone who let it ring
  out, which is the commonest way of wanting it;
- **effectively group only** — a 1:1 is ended by `releaseCalls` the moment a
  socket closes, so there is never an ongoing 1:1 row to join;
- the auto-rejoin is **deleted**, not kept alongside. Two mechanisms for one job
  is how this rots.

What stays is the server-side `session_id` takeover from slice 1: it is what
makes pressing Join after a reload reclaim your *own* place rather than collide
with your dead connection. That half was always sound.

Known costs, both better failure modes than vanishing: the projection lags
JetStream slightly, so a just-started call takes a beat to appear (the refetch
retries at 0/600/1500/3000 ms); and a call that dies without a projected event
leaves a stale row, where Join gets `call_gone` and the banner clears quietly.

Verified against the live stack (`e2e/specs/call.spec.ts`, "a reloaded tab joins
the ongoing call from the thread"): three people in a video call, one reloads,
and the assertion that matters most is that **nothing rejoins on its own** —
the banner appears and the dock stays hidden until Join is pressed. ⚠️ That run
is still the fake-device configuration that hid the auto-rejoin bug; the
difference is that click-to-join has no race for it to hide — the join rides a
click on a socket the page has held since load, and capture failing costs the
microphone rather than the place (pinned by a unit spec).

## Testing

Unit tests per repo as usual (`vitest` for the Fastify service, `gotestsum` for Go, karma for the remote). Real call coverage is Playwright with **two browser contexts** and `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`; it belongs in a nightly tier, never a PR gate. The PR tier mocks signaling and asserts state-machine transitions, which is where the regressions actually live.

**Built 2026-09-09** as the `calls` Playwright project in `messenger-frontend` (`e2e/specs/call.spec.ts`), and it is the one suite here that mocks nothing:

```
E2E_JWT_SECRET=<api-gateway JWT_SECRET> pnpm exec playwright test --project=calls
```

- It targets the **shell** (:4000) because `/chatbot` only exists there, so the mid-call navigation criterion is only real against the shell. Not because the dock is the shell's: the remote mounts its own and calling works standalone at :4003 (see § Where the call UI actually lives).
- It needs the gateway's **actual** HS256 secret, because the seeded token is verified for real; the suite refuses to run with the placeholder rather than failing obscurely later. Agents never read a backend `.env`, so this run is dathq's.
- The default `chromium` project `testIgnore`s it, so the PR gate never picks it up.
- It asserts the duration **advances** after navigating to `/chatbot`, not merely that the dock is still rendered — a dock frozen at 0:04 would pass a visibility check with the call already dead.

### Slice 4 — docked mini chat windows ✅ (MERGED !189, 2026-09-17)

`messenger-frontend` only. The server needed nothing: a connection's open
conversations are already a **set** (`conn.conversations`, a `map[string]struct{}`),
so `conversation.open` for three threads at once was supported the whole time.

**What actually blocked it was that every thread derivation was `active`-scoped.**
`ChatsPageComponent` held about a dozen computeds — rows, typists, seen-by,
title, presence, faces, member count, callable, ongoing call — all reading
`store.activeConversationId()`, and the store matched with `activeMessages`,
`activeCalls`, `activeTypists`, `markActiveRead` and a **single** `loadingThread`
boolean. A mini window is a second simultaneous thread, so the choice was to
copy those derivations into the dock or to make them take a conversation id.
Copying is the mistake this codebase has paid for three times already (the shell
header widget's own preview rule, four copies of the auth interceptor, the
thread's own call-label rule), so the derivations moved into
**`modules/chats/thread-view.ts`** — `threadView({ store, realtime,
conversationId })` returns the signals, and the page and every window consume
the same factory.

**Socket subscriptions are refcounted.** `openConversation` used to close the
previous thread outright. With windows that is wrong in both directions: the
page and a window can show the *same* conversation, where the first to close
would unsubscribe the other and silently stop its typing indicators and live
messages; and two windows can show different ones, which the old shape could not
represent. `ChatStore.openThread(id, holder)` / `closeThread(id, holder)` keep a
holder set per conversation and send `conversation.open` once, `conversation.close`
only when the last holder lets go.

**Three windows, and the cap is two limits at once.** Three 20rem windows plus
gaps is about 66rem, which fits a laptop beside the call dock. It is also what
keeps a reconnect inside realtime-service's budget: `conversation.open` draws on
the tighter token bucket (`stateBurst = 5`, refilling at 0.5/s) and the socket
re-sends one frame per remembered thread on connect — three windows plus the
chats page's own open thread is four. Opening a fourth closes the oldest rather
than refusing the newest.

**Two entry points, because a remote must work without the shell.** The shell's
header widget now docks a conversation instead of navigating to `/messenger`,
which is the whole point — the widget is reachable from every page of the
platform and taking someone away to answer one message costs them what they were
doing. That path does not exist at :4003, so the conversation list grew a
hover-revealed dock button too. The e2e suite drives the **standalone** one for
exactly that reason.

**Layout decisions.** The strip is `fixed` bottom-right, growing leftwards,
mounted in the same two hosts as the call dock and re-parented to `body` in
`afterNextRender` (the shell toolbar's `backdrop-filter` is a containing block
for `position: fixed`). Both corner overlays share **`--messenger-dock-width`**,
declared once in `styles/base.scss`: the call dock sizes itself with it and the
strip offsets itself by it, so neither has to measure the other. The strip sits
at `z-30`, below the call stage's `z-40` scrim, so an expanded call covers the
windows without anything here knowing the stage exists. Below 40rem the strip is
not rendered at all — two 20rem windows do not fit beside each other, and
Messenger's answer at that width is chat *heads*, a different feature. A window
whose conversation is the chats page's **active** thread is dropped from the
strip rather than closed: it is already on screen full-size, and navigating away
brings it back.

⚠️ **Two defects that only a screenshot found**, both after a green suite. The
per-message timestamp is absolutely positioned past the bubble's edge, and at
318px it overflowed the scroller by 11px and put a horizontal scrollbar under
every window — fixed by reserving the strip on **incoming** rows only, since an
own row's stamp sits on the left where the avatar gutter does not exist. And a
group's header carries five buttons (details, audio, video, minimise, close),
which at 2rem each left the title as "Proje…" and wrapped "2 members" onto two
lines. Measured, not guessed: `scrollWidth` vs `clientWidth` named the first in
one step after two wrong theories about bubble max-width.

**The audit after it was built found three things, all mine.** The five
back-compat wrappers left on `ChatStore` were dead once every caller had moved,
and only the spec still referenced them. `ChatDockService.closeAll()` had no
caller at all. And the persisted window list used a single `localStorage` key,
so the next person to sign in on that browser had the previous person's
conversations restored into their dock — fixed by keying the entry on the owner
id rather than by hooking logout, which would have coupled the feature to the
auth service and thrown the first user's windows away when they came back. Both
rules are in `.claude/rules/working-agreement.md`.

## Observability

`realtime_service_ws_connections`, `realtime_service_ws_frames_total{type,direction}`, `realtime_service_signaling_relay_total{outcome}`, `realtime_service_call_setup_total{outcome=connected|failed|timeout}`, `realtime_service_ice_failures_total`, `realtime_service_calls_reaped_total` (calls ended because no instance was holding them — steady zero is healthy), `realtime_service_turn_credentials_issued_total`; `messenger_service_http_*` RED. Prometheus targets 3004/3005/3006 in `platform-observability`. `correlation_id` carried through, as everywhere else.

## Concerns

- **Scope is real.** Four new repos; phase 0-1 alone is roughly eight PRs. If calling should arrive sooner, phase 1 can ship 1:1 conversations only — no groups, receipts or attachments.
- **TURN is not optional** in the real world: without a relay, 10-20% of calls fail behind symmetric NAT and corporate firewalls.
- **Ring audio needs a user gesture** — browsers block autoplay. Unlock an `AudioContext` on the first interaction after login.
- **`getUserMedia` needs a secure context.** localhost already is one, so local development is unaffected; it matters only the day calls are tested between two machines.
- **Presence fan-out is quadratic if done naively.** Clients subscribe only to the owners currently visible in their list, never to everyone.
- **The shell gains a dependency it must survive.** With `messenger-frontend` down, the header slot renders nothing and the platform is otherwise untouched — that behaviour is a requirement, and belongs in the shell's own tests.
- **`accounts-service` grows the moment "who may see whom in the directory" is asked.** Solo-workspace auto-provision keeps phase 0 small.

## Creating the repos

`realtime-service`, `messenger-service` and `messenger-frontend` are new ADO repos. Each needs the full setup in **`ci/bot-review-pipelines.md` § New repo — ADO setup checklist** — including the build-service **Contribute to pull requests** grant, which is UI-only and is the one step whose absence is invisible until the first PR half-fails.

## Related rules

- **`services/realtime-service-architecture.md`** — WS protocol, presence, signaling relay
- **`services/accounts-service-architecture.md`** — identity, tenancy, the OPA activation rule
- **`services/shell-frontend-architecture.md`** — header widget slots, `SHELL_CONTEXT`, overlay host
- **`platform/platform-notifications.md`** — why `message.sent` stays unmapped
- **`platform/chatbot-file-events.md`** — the attachment cleanup choreography to copy
- **`platform/platform-nats-architecture.md`** — durable ownership, `max_deliver`
