# messenger-frontend — architecture

_Angular 21 Module Federation remote for the Messenger product: routed UI at `/messenger` plus the shell header widget_

Product plan, transport and phases live in **`products/messenger-architecture.md`** — this file covers only what is specific to the frontend repo. Angular conventions: **`lang/lang-angular.md`**. Folder scaffold: **`services/platform-frontend-conventions.md`**.

## Shape

| | |
|---|---|
| Port | **4003** (standalone `pnpm start`, or hosted by the shell at `/messenger`) |
| Federation name | `messenger` |
| Gateway base | `/api/messenger` → `messenger-service` (phase 1; unused by the phase-0 skeleton) |
| Unit tests | `pnpm test` (karma headless) |
| E2E | `pnpm e2e` (Playwright, auth seeded, no backend) |

## Two exposes, one remote

```js
exposes: {
  "./Module":       "./src/remote-entry.ts",        // routed product, MessengerRemoteEntryModule
  "./HeaderWidget": "./src/header-widget-entry.ts", // standalone component, DEFAULT export
}
```

`./HeaderWidget` is **default-exported** — the shell's contract for a header slot, so onboarding stays config-only (**`services/shell-frontend-architecture.md` § Header widget slots**).

Rules that follow from the widget being loaded *outside* this remote's routes:

1. **It registers its own translations — narrowly.** Neither `AppModule` nor `MessengerRemoteEntryModule` runs when the shell loads only the widget, so `HeaderWidgetComponent` calls `registerRemoteTranslations` itself, but only for the **active language**, only the **`MESSENGER` subtree**, and behind a `Set` guard against `onLangChange` re-entrancy. The routed entry still registers the full bundle, which is correct there — it owns the page. Why each rule exists: **`services/shell-frontend-architecture.md` § Header widget slots** rule 4.
2. **It must work with nothing else of this remote mounted** — no assumption that a route, a layout or a route-scoped provider exists.
3. **It navigates through the shell's `Router`.** Module Federation shares one Angular instance, so `inject(Router)` inside the widget is the shell's router; `/messenger` is an absolute shell path.
4. **Loading the widget at login keeps the remote alive for the session.** That is what will let a root-provided store hold the realtime socket across navigation (phase 1) rather than opening it on first visit to `/messenger`.

## Widget *and* app tile

Messenger appears three times in the shell's config, and each entry answers a different question: `environment.remotes` (where the bundle is), `environment.headerWidgets` (the ambient slot — socket, badge, ringing on every page) and `environment.apps` (the sidebar link and launcher tile, because `/messenger` is a real destination with an Overview page).

An earlier draft of the rule said an ambient product must *not* be a tile. That conflated two independent decisions and is corrected in **`services/shell-frontend-architecture.md` § Header widget slots** rule 5 (dathq, 2026-09-06).

## Phase 0 scope (built 2026-09-06)

Skeleton only, and honest about it: the Chats feature renders the sidebar (search + new-message, both `disabled`) and a zero-state stage, and the widget renders its icon plus an empty popover. **No badge, no fixture conversations**: a badge with no unread source is decoration, and fake threads would make the page lie. Conversations, presence, typing and calling arrive with `messenger-service` and `realtime-service`.

**The composer belongs to the thread, not to the pane.** Messenger, WhatsApp, Telegram and iMessage all render *no* text box when no conversation is open — a composer with nothing to send to only raises questions. Phase 0 briefly shipped one and it was rightly called confusing; the composer is now phase 1's, mounted with the thread component.

Two empty states, and they are not interchangeable:

| State | Right pane | Reachable |
|---|---|---|
| No conversations at all | "Start your first conversation" + the same **New message** action as the sidebar | phase 0 (the only one today) |
| Conversations exist, none selected | "Select a conversation" | phase 1 on |

Phase 1 should also auto-open the most recent conversation, the way Slack sidesteps the second state entirely.

Chats borrows its visual language from **`chatbot-frontend`'s chat page** — a gradient stage with noise and glow layers, translucent sidebar, and one set of CSS custom properties per theme (`:host` for light, `:host-context(.dark)` for dark) — as inspiration rather than a copy. Two frontends of the same platform should not look like different products; equally, the messenger layout is its own (conversation list instead of history, composer disabled instead of live).

The **Overview** page (`home-page/`) is the exception — it is finished, not a placeholder. Like the other frontends' landings it exists to teach the stack: a hero, two interactive flow diagrams (**sending a message** and **placing a call**, each step clickable for detail) and the stack cards. Cards for services that do not exist yet carry a *Planned — phase N* chip (`LandingStackCard.statusKey`), so the page never implies more is running than is.

Feature folders: `home-page/` (Overview), `chats/` (routed), `header-widget/` (the slot content), `shared/` (the two layouts). `SUBNAV` carries Overview and Chats — Calls and People tabs arrive with their features, since an empty tab is worse than an absent one.

The trigger button mirrors the shell's bell and profile triggers exactly — `[rounded]` + `[outlined]` + `styleClass="datha-profile-trigger"`, inside a `relative` wrapper that will anchor the unread badge. Header chrome must look like one set of controls, so this is copied deliberately rather than styled independently.

## Dual mode

Same pattern as the other remotes (**`services/shell-frontend-architecture.md` § Dual-mode remote pattern**): `AuthenticatedLayoutComponent` reads `data.shelled`, showing the slim sub-header when hosted and the full toolbar when standalone, and switches tab links between `/chats` and `/messenger/chats`.

⚠️ **Standalone is chat only — there is no call UI at :4003.** The two halves of calling are mounted in different places, and it is easy to say "calling lives in the shell" or "calling lives in this repo" and be half wrong either way (I was, 2026-09-15, and dathq corrected it):

| Piece | Lives in | Rendered at :4003? |
|---|---|---|
| Call **buttons** (`thread-call`, `thread-call-video`) | this repo, the thread header | **yes** |
| `WebrtcCallService` (the engine) | this repo, `providedIn: "root"` | **yes** |
| Call **dock** (ring, tiles, accept, hang up) | this repo — mounted by `HeaderWidgetComponent` when hosted, and by `AuthenticatedLayoutComponent` when not | **yes**, since 2026-09-15 |

**Fixed 2026-09-15.** Until then the dock was mounted *only* by the header widget, which only the shell renders — so :4003 had a call button that started a real call it could neither show nor hang up. The fix mounts the dock in the standalone layout (`@if (!isShelled())`, the counterpart of the widget) and starts the socket there too, so a call can ring on the Overview page and not only from the thread that opened it.

**Hiding the button standalone was the wrong instinct, and was rejected** (dathq, 2026-09-15): *"When i create microfrontend like this is for all the small frontend can work independently, with or without the shell."* A remote that needs the shell to do its own job is not an independent remote. Any future capability added through the header widget owes the standalone layout the same mount — that is the rule, not a one-off.

⚠️ **Mounting it under `@if` exposed a latent bug worth knowing about.** `CallDockComponent` re-parents its host to `document.body`, to escape the shell toolbar's `backdrop-filter` (which creates a containing block for `position: fixed`). That ran in the **constructor**, and Angular inserts a host node at its anchor *after* the component is constructed — so inside a control-flow block the `appendChild` was silently undone and the dock rendered back inside the layout. It only ever worked because the widget renders it statically. It now runs in `afterNextRender`, correct in both mounts.

**Calls can be verified at either :4000 or :4003 now.** The shell remains the only place to test the *navigation* criterion (leaving `/messenger` mid-call), because standalone has nowhere else to navigate to.

## i18n

Top-level namespace **`MESSENGER.*`** (plus the shared `SUBNAV.*` / `PROFILE.*` / error keys). Registered through `registerRemoteTranslations` — never `setTranslation(..., merge: true)`, whose deep merge leaves stale keys behind when switching remotes.

## Dev-server gotcha

Angular's incremental dev build has silently missed a component's SCSS change on this repo (a rule was in `dist/` but absent from the served chunk, so a style looked broken that was not). **After a style change, restart `pnpm start` before believing what the browser shows.**

## CI

`azure-pipelines/bot-review.yml` extends `platform-pipelines` `stack-angular-karma.yml`, pinned to **`refs/tags/v9`**. The ADO repo, its branch policies and the build-service *Contribute to pull requests* grant follow **`ci/bot-review-pipelines.md` § New repo — ADO setup checklist**.

## Realtime socket (phase 1)

`src/services/implementations/realtime.service.ts` owns the browser's socket. It is **root-provided and started by the header widget**, so it is alive from login onward rather than from the first visit to `/messenger` — that is what makes a live badge (and later, ring-from-anywhere) work at all. `start()` is idempotent: a second widget mount reuses the socket.

Connect sequence, matching **`services/api-gateway-architecture.md`**: `GET /api/realtime/token` → open `wss://…/api/realtime/ws?stream_token=…` → on open, resync unread over REST. Reconnect backs off 1 s → 30 s and **mints a fresh token every attempt**, since they expire in ~90 s.

Two invariants:

- **Unread is a set of conversation ids, never a counter.** Every delta is a union or a delete, so a duplicated frame costs nothing and a dropped one self-heals at the next resync. The badge is `set.size`, displayed capped at `9+`.
- **The set comes from `GET /api/messenger/conversations/unread`, not from the socket's `ready` frame** (dathq's call, 2026-09-08). It keeps `realtime-service` stateless and lets a socket become ready while chat is down.

A server `ping` is answered with `pong`; unknown frames (`receipt.read`, `call.*`) are ignored rather than treated as errors — that is what makes the protocol versionless.

`environment.realtime.{tokenUrl,socketUrl}` carry the endpoints in all four environment files. Note that the remote reads `window.ENV`, which the shell also writes: each side captures its own object at import, so the remote's config survives being hosted.

## Chat UI (phase 1)

```
src/modules/chats/
  chats.routes.ts                     ""  and ":id" → the same page
  pages/list/chats-page.component     list + thread, route param = open thread
  components/conversation-list/       sidebar, client-side search
  components/thread/                  header, messages, composer
  components/new-message-dialog/      directory search (accounts-service)
src/services/implementations/
  messenger-api.service.ts            REST client (messenger + accounts)
  chat-store.service.ts               the state the UI renders
  realtime.service.ts                 the socket
```

**`ChatStore` is where the two sources meet.** REST is truth — conversations, message pages, the read watermark. The socket is a delta stream that keeps what is already on screen live. Anything a frame misses is corrected by the next load, which is why a dropped frame is not a bug.

Decisions worth keeping:

- **Sending is optimistic and reconciled on `clientMessageId`** — the same key that makes the server's retry idempotent, so a failed send offers a retry that cannot double-post. Deduplication matches **sender + client id**, mirroring the server's unique index; matching on the client id alone would let one participant's id replace another's message.
- **The open conversation is held in the store, not derived from the list.** The list is one page ordered by recency, so a thread opened by URL may legitimately not be in it — and a background refresh must never make the thread on screen vanish.
- **The composer lives in the thread component**, never on the page: a composer with no thread to send to is the confusing state every mainstream messenger avoids.
- **Typing is throttled to one frame per 2 s** and only after `conversation.open` has authorized this socket for that thread.
- **Presence is subscribed for the owners on screen only** — subscribing to everyone makes fanout quadratic.
- **Chat requests carry `X-Datha-Quiet-Errors`** so a failure surfaces inline (an error notice on the list, a retry on the message) instead of raising the global modal over the thread. The header exists because a context token does not cross the federation boundary — see **`services/shell-frontend-architecture.md` § Header widget slots**.
- **The popover lists conversations only**, filtered client-side; directory search lives in the new-message dialog, where a second data source has room.

## Attachments

`file-upload.service.ts` runs the three-step upload — `POST /api/files/prepare` → `PUT` the bytes straight to Azure Blob → `POST /api/files/:id/confirm`. The blob PUT deliberately uses `fetch`, not `HttpClient`: the SAS URL must never have the app's bearer attached and must never reach the interceptors. Uploads are labelled `origin: "messenger"`, or file-service's orphan reconcile would treat them as chatbot leftovers.

The composer's row appears **before** the upload starts, carrying the filename, and is reconciled on `clientMessageId` like any other send — so a failed upload offers a retry that **re-uploads** and still cannot double-post. Downloads are fetched on demand from messenger-service (never file-service, which would refuse a recipient) because the URL is short-lived; see **`services/messenger-service-architecture.md` § Attachments**.


## Calling — the mesh (phase 3 slice 3, 2026-09-15)

`WebrtcCallService` is root-provided, and the **dock** is mounted by the header widget rather than by a route: leaving `/messenger` must not destroy the connections. Note the split — the call *buttons* are ordinary thread chrome in this repo, so they render standalone while the dock does not; see **§ Dual mode** for why that matters and where it bites. The product-level design — why mesh rather than an SFU, who offers in each pair, what `call.participant` carries — lives in **`products/messenger-architecture.md` § Slice 3**; what follows is only what a reader of this repo needs.

```
services/implementations/webrtc-call.service.ts   the engine: Map<ownerId, PeerLink>
services/implementations/realtime.service.ts      the socket, and the per-tab session id
modules/call-dock/                                the panel: tiles, controls, ring
models/call.model.ts                              LiveCall, RemotePeer, CallRecord
```

- **`PeerLink` is the unit, and a 1:1 call is one of them.** Nothing branches on "group" except the *handshake*: a pair's first description rides `call.invite`/`call.answer`, a group's rides `call.renegotiate` with a `to`. Everything after — tracks, candidates, collisions, teardown — is the same code for both.
- **`LiveCall` has no `peerOwnerId`.** The 1:1 peer is derived from `participantIds`; storing both would be two sources of truth for one fact. `callerOwnerId` *is* stored, because "who rang" is not derivable from a set sorted by owner id.
- **The dock renders `peers()`, an array, in every case.** A pair is not a layout special case — that is exactly how the expanded stage came to render at the compact width while 135 specs passed. Tiles are keyed by `data-owner` and bound by owner id, never by position: a mesh adds and drops tiles mid-call, and an index would hand one person's camera to another the moment somebody between them left.
- **`sessionStorage`, not `localStorage`,** for the call session id — the latter is shared by every tab of a window, which is the one thing the id exists to tell apart.
- **Coming back to a call is a click, never automatic.** The thread renders an ongoing-call banner (`thread-live-call`) with a Join button for any call in this conversation with no `ended_at` that this tab is not already in; pressing it calls `WebrtcCallService.joinOngoing`, which sends `call.join` and lets `HJoin` recognise the session and hand the place back. `ChatStore.ongoingCall` is the selector — fed by the call history the thread already fetches, kept fresh by `call.participant` (the whole joined set, so it replaces rather than increments), and given its conversation by the `call.incoming` that rang, since no other call frame names one. **Effectively group only:** realtime-service ends a 1:1 the instant a socket closes (`releaseCalls`), so there is never an ongoing 1:1 row. `call_gone` clears the banner's attempt **without** an end notice — announcing an ending to someone who was not in it is noise.
- ⚠️ **The automatic rejoin that preceded it was deleted, not kept.** It remembered the call in `sessionStorage` and re-sent `call.join` on the socket's `ready` frame, and needed three things to go right — open socket, reacquired capture, won takeover — failing silently at each. Three failure modes were fixed in one day and it still dropped dathq. Do not reintroduce it; `webrtc-call.service.spec.ts` pins that a bare `ready` frame produces no join. Why, in full: `products/messenger-architecture.md` § Rejoining an ongoing call.
- **Claim the place before opening the microphone.** `joinOngoing` sends the join first and starts capture after, with `buildLink` awaiting `mediaReady`. `RealtimeService.send` drops a frame on a socket that is not open and says nothing, so every await before the join is a window where it vanishes; and capture is what actually fails on a real machine, where several tabs contend for one microphone. Losing capture costs the microphone and an error banner, never the place.
- **Glare is two people dialling each other, and nothing else.** `onIncoming`
  yields its own call to an incoming invite only while that call is still
  **outgoing and ringing**. It used to yield from any state, so a third person
  pressing Call during a call made the polite side hang up the call it was in
  and take the new ring (2026-09-15). Anything else — a call already joined, or
  one somebody else is ringing us with — is refused as `busy`.
- **A refused invite becomes a join.** realtime-service allows one call per
  conversation and answers a second invite with `call_exists` plus the live
  call's id; `onServerError` turns that into `joinOngoing`. The Call button is
  hidden while `ongoingCall()` is set, so this is the *race* path — two people
  pressing Call in the same instant — rather than the usual one.
- **The ongoing-call banner goes on the frame, never on the projection.**
  `call.ended` marks the call in `ChatStore.endedCalls` immediately, because the
  history row is written by a JetStream consumer and still reads `ended_at:
  null` for a second or so afterwards — which left a Join button pointing at a
  dead call (dathq, 2026-09-15). `refreshCalls` then settles the row, and its
  `until` argument is the other half of that bug: a row exists from the moment
  someone *joins*, so a refresh waiting for the call to appear stopped on the
  first fetch and kept the open row. Wait for `"ended"` after an ending.
- **Capture that lands after the call is gone must stop itself.** `joinOngoing`
  opens the microphone *after* sending the join, so a `call_gone` or a lost
  takeover can clear the call while `getUserMedia` is still resolving;
  `teardown` cannot stop a track it has never seen, so the microphone stayed
  open with no call attached — a live recording indicator and a stream nothing
  would ever release.
- **A history row may say things a frame never can.** `CallHistoryEndReason` is `CallEndReason` plus `expired`, which is messenger-service's own conclusion that a call outlived any possible call — reachable only through `GET /calls`, never the socket. Keeping them separate stops an impossible `CallEndNotice` being representable. Found by the gucci audit on 2026-09-15: the service gained the reason and this type quietly could not hold it, the same shape as `calleeOwnerId` before it.
- **The mesh cap is not duplicated in this repo.** `MAX_CALL_PARTICIPANTS` belongs to realtime-service; the call button is offered in any group and a refusal is surfaced from the server's `error` frame.

**Testing it means running it.** The unit suite drives a fake `RTCPeerConnection`, which can prove the state machine and nothing about media. The real coverage is `playwright test --project=calls`, the nightly tier: four browser contexts, `--use-fake-device-for-media-stream`, the live stack, and the gateway's own `E2E_JWT_SECRET`. It asserts `videoWidth` per tile rather than classes — and it **polls** for it, because ICE connecting is what makes the duration appear while the first video frame lands a moment later. Its group is created **idempotently**: `POST /conversations` makes a new group every time and there is no delete endpoint, so creating per run leaves one behind per run.

## Container names, and why they are named (2026-09-21, !225)

Two containers, both explicit:

| Name | Declared on | Answers |
|---|---|---|
| `ms-page` | `.messenger-content` (authenticated layout) | how much room the **route** has |
| `ms-chats` | `.chats-root` | how much room the **chats area** has |

`ms-page` is on the layout rather than on each page root because `.chats-root`
carries its own `gap` and `padding` that have to respond, and **an element
cannot query a container it declares**.

`ms-chats` was an unnamed container from !203. Naming it closed a real hazard:
`call-dock` declares a `container-type: size` of its own, and
`thread.component.scss` queries `.chats-root` **across a component boundary**,
so an unnamed `@container` was one refactor away from binding to something
else — silently, with no error and no log.

Naming also documents a behaviour that used to be accidental: **a docked chat
window has no `ms-chats` ancestor**, so the thread's collapse rules never
match there, which is correct — a dock is 20rem wide and has its own layout
and its own close control. The `:host(.is-windowed)` rules carry that case.

Both declarations live in **component** stylesheets, so they travel with the
federated JavaScript; a host never loads a remote's global sheet.

## The call dock's stage is full-bleed on a phone (2026-09-21, !225)

The desktop stage is defined by four insets (`inset: 1.25rem`) with
`width: auto`, which reads as a panel rather than a takeover. The phone rule
must reset the inset as well as the size: with `inset: 1.25rem` still applying,
`left: 20px` plus `width: 100%` put the right edge at **395px on a 375px
viewport**, because when both insets and a width are set the width wins and
the opposite inset is ignored. Spec: `e2e/specs/call-dock-viewport.spec.ts`,
which measures the stylesheet by stamping the component's own `_ngcontent`
attribute onto a probe — an unstamped element receives no encapsulated styles.

## Connector labels: prose is styled, literals are quoted (2026-09-21, !225)

`.flow-link` uppercases; `.flow-link--code` does not and switches to the mono
stack the ops pages use. Uppercasing prose is a label convention, uppercasing
an identifier changes what it says — `createOffer` became `CREATEOFFER`,
`rt.owner.<id>` a NATS subject that does not exist and `POST /api/messenger`
a path that does not either. The flag lives on `LandingFlowLink` in the
component, so the label and its kind come from one list rather than from an
index-keyed ternary in the template plus a second index-keyed binding beside
it. Spec: `e2e/specs/landing-flow-labels.spec.ts` (asserts `innerText`, since
`textContent` is untransformed and would pass against the bug).
