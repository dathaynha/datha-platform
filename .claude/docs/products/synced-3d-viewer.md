# Synced 3D viewer

_Pre-product. A room where several people watch one 3D model together, some of them able to
drive it. What the design is, and what has to be decided before any of it is built._

**No repo, no code, nothing scaffolded** — `critical-behaviors.md` #8 applies.

## The shape it takes

A 3D human model walks through a sequence of narrated steps, while other people watching from
their own machines see the same session and — if granted — can drive it.

Stack for the reference implementation the design was worked out against:
`three` 0.180 + `@react-three/fiber` 9 + `@react-three/drei` 10, React 19, Tailwind 4.

Three things carry into this product: **the three.js core**, **the step/animation model**, and
**the cross-machine sync protocol** — reworked onto `realtime-service` rather than a hosted
pub/sub service.

## ⚠️ Assets before code

**Do not reuse a 3D asset whose licence you cannot point to.** Rigged character models,
narration audio and transcripts are commissioned work far more often than not, and having a
copy on disk answers nothing about the right to ship it.

**Source a freely-licensed rigged model** — a CC0/CC-BY character with baked animation clips
behaves identically for every technique below, and the whole design here is *clip-name
driven*, so swapping the asset changes nothing structural.

## The three.js core worth keeping

### Loading and caching

`GLTFLoader.loadAsync`, with a **module-level `Map<string, THREE.Group>` cache** outside
React. That cache exists because React Strict Mode double-mounts in development and the
second mount was losing the model. The same guard covers a concurrent second load of the same
path via a shared in-flight promise.

The Angular equivalent has no Strict Mode, so the double-mount reason disappears — but the
cache is still right for a 45 MB asset, and it belongs in a service, not a component.

### ~~The camera lives inside the GLB~~ — it does not. Corrected 2026-09-22

**This section previously claimed the camera was authored into the model file and driven by
the mixer, and called it the best idea in the codebase. Measuring the assets disproved it.**

`Man.glb` and `Woman.glb` contain **zero cameras**: no `cameras[]` entries, no camera-like
node among 178 nodes, and every animation channel targets rig bones (`mixamorig:*` plus IK
and FK controls). The claim came from reading the *code* — `cameraActionRef`, the
`camera instanceof THREE.PerspectiveCamera` checks, a comment about "camera hierarchy" — and
inferring a property of the asset from it. The code path is real; with these models it never
fires.

So framing is **entirely programmatic**: `CameraController` plus `zoomToLegs` /
`zoomToUpperBody`. There is no authored cinematography to inherit, and a reimplementation
owes camera work of its own.

The ordering constraint the code comments on (`mixer.update(delta)` before camera sync in
the same `useFrame`) is still correct in general — an authored camera would need it — but
nothing in these assets exercises it.

Textbook case of this workspace's own rule: **measure, do not reason.** One GLB parse would
have settled it at the time, and the doc asserted it for a day instead.

### Programmatic camera moves live alongside

`zoomToLegs` / `zoomToUpperBody`, each taking `{ startDelay, holdDuration, duration }` and
advanced from `useFrame`. So framing has two sources — the authored clip and imperative
zooms — which coexist only because the zooms are triggered from step transitions rather than
freely. Worth keeping the capability and worth deciding, deliberately, which one wins when
both want the camera.

`OrbitControls`, `Environment` and `Html` come from drei; `Html` puts DOM overlays in 3D
space.

### Materials are selected by mesh **name**

`isHairPart`, `isSkinPart`, `isMarkerPart` classify meshes with `name.toLowerCase().includes(...)`
— and there are hard-coded escapes like `child.name === "Plane005"`.

**This is the codebase's most fragile seam.** A re-export from Blender that renames a mesh
silently drops its material treatment, with nothing to catch it. If any of this is carried
over, classify from a **convention the asset pipeline guarantees** (a naming prefix that is
checked on load, or glTF `extras` metadata authored into the file) and fail loudly when a
mesh matches nothing.

## The step model

An animation **step is a `THREE.AnimationClip`**, and clips are addressed **by name**, not by
index — `animations.findIndex(a => a.name === targetStepName)`. That is what lets two machines
agree on "where we are" without sharing an array order, and it is the right call.

Its two failure modes are worth naming, since neither is guarded today: a **renamed** clip
breaks sync silently, and **duplicate** clip names make `findIndex` pick the first.

Each step carries, in parallel:

- the clip itself, played through one `THREE.AnimationMixer`
- **narration audio** — `assets/audio/<lang>/<character>/<NN>.mp3`, with a preload pass and a
  validation cache keyed by step, invalidated whenever language or character changes
- a **transcript** for subtitles, cached the same way

`useAnimation` is a 1,248-line hook holding all of it — playback state machine
(`STOPPED | PLAYING | PAUSED`), sequence control, audio, and subtitles. The state machine and
the step/audio/transcript triple are the ideas; the single-hook packaging is not, and in
Angular this is a **service with signals** plus a separate audio service.

One detail to keep: audio is the part that fails in the browser, not the animation.
Autoplay is blocked until a gesture (`unlockAudio`, an "enable audio" modal), a file may be
missing for a language/character pair, and `play()` returns a promise that must be awaited
before the next `play()` or the two race. The legacy code holds `audioPlayPromiseRef` for
exactly that.

## The cross-machine sync protocol

This is the feature dathq wants, so it is worth stating what it actually does — it is **not**
what the file layout suggests.

### Shape

Sync is **server-mediated, not peer-to-peer**. A machine PATCHes the session over HTTP; the
backend persists it and publishes a Pusher event; every subscriber — including the sender —
receives it. There is no direct connection between the two machines and no frame-level
streaming: what crosses is a **command plus a state snapshot**, a few times per interaction.

```
machine A ── HTTP PATCH ──► backend ── persist ──► publish ──┬──► machine A (own echo)
                                                             └──► machine B
```

Payload, flattened from `session.update`:

| Field | Meaning |
|---|---|
| `state.action` | `start \| pause \| resume \| next \| previous \| goto \| repeat` |
| `state.playbackState` | `playing \| paused \| stopped` |
| `info.current_patient_step` | the clip **name** |
| `info.language_selection` | narration language, synced too |

### Why the server in the middle is right

The session row is the source of truth, so a machine that reloads, joins late or reconnects
**reads the state** rather than waiting for the next event. That is the same rule the platform
already learned the hard way with messenger calls: *every fire-and-forget fan-out needs a
state read on connect, or it is invisible to anyone who was not already there.* Keep it.

### The four things that are wrong with it

1. **Echo suppression is a 2-second timer on the action name** (`isOwnEcho`). Two machines
   sending `next` within that window means the second one's genuine command is swallowed.
   The fix is an **emitter id on the event** — the platform's realtime frames already carry
   the sender, so this problem disappears on the port rather than being reimplemented.
2. **Timing is fixed sleeps.** `setTimeout(200)`, `setTimeout(800)` when the language changed,
   and a double `requestAnimationFrame` plus `setTimeout(600)` before a step change — each one
   waiting for audio preload or a React state flush. These are races with a guess for a
   guard. Sequence on the actual readiness signal (the audio element's `canplaythrough`, the
   mixer's action being ready) instead.
3. **The reconnection path is gated on heuristics** — "we are stopped or at step 0, they are
   playing, and it has been more than 5 s since our own periodic update". That is three
   proxies for a question the protocol should answer directly: **who is driving?** Make that
   explicit state rather than inferring it.
4. ~~Both sides can drive at once and nothing arbitrates.~~ **Wrong — corrected 2026-09-22
   by reading the handlers.** See § Control is two disjoint sets below. There is no
   arbitration because there is nothing to arbitrate.

### Porting to `realtime-service`

The platform already has what Pusher was doing, and more of it:

| Legacy | Platform |
|---|---|
| Pusher hosted channels | `realtime-service` (:3004) websocket, `/api/realtime/{token,ws}` through the gateway |
| `operator-channel` | a room subject scoped by `owner_id` — the sync is between **your own devices**, which is a simpler authorisation story than the legacy app's |
| HTTP PATCH + publish | same shape: a service owns the session row and publishes; do not let clients publish state to each other directly |
| `isOwnEcho` timer | the frame's sender id |
| — | presence, which the legacy app lacked entirely and which answers "is my other machine even here" |

**`realtime-service` is Go and already carries a room model, targeted delivery with a
validated `to`, and instance heartbeats with a reaper** — built for calls, but the shape is a
room of participants exchanging small typed frames, which is exactly this. Read
`services/realtime-service-architecture.md` before designing frames; the `call.*` family is
the precedent to copy, not to extend.

⚠️ Nothing here needs a new NATS stream. Topology belongs to `platform-nats/`.

## Control is two disjoint sets — the design decision worth keeping

Verified against `InstructionalVideo.tsx` (2026-09-22), not inferred. The two roles emit
**non-overlapping** actions, and each handler carries a comment saying so:

| Action | Emitted by | Gate in source |
|---|---|---|
| `start` | patient | `if (isPatientFlow && patientId)` |
| `pause` / `resume` | patient | `// PATIENT ONLY (operator doesn't have this button)` |
| `repeat` | patient | `// PATIENT ONLY` |
| `next` | operator | `// Only operator emits this action (patient doesn't have next button)` |
| `previous` | operator | `// OPERATOR ONLY (not available for patient)` |
| `goto` | operator | `// Wrapped handleStepClick that emits Pusher events - OPERATOR ONLY` |

**The patient owns transport; the operator owns navigation.** One shared timeline, two
control sets that cannot collide — so the app needs no lock, no claim, no last-write-wins
rule and no "who is driving" state. That is a stronger answer than arbitration, and it is
the part to carry forward.

What the echo suppression is actually for, then, is **not** contention: a publisher receives
its own publish, so `isOwnEcho` exists only to drop the sender's own message. A sender id on
the frame replaces it exactly (flaw 1).

### Where this product lands instead (decided 2026-09-22)

The legacy split is kept as the *idea* — one shared timeline, everything else local — but the
line moves, because the legacy mapping is backwards for a room of peers (it gives the guest
transport and the host navigation, which only makes sense when the guest is the one living
through the sequence).

| Concern | Scope | Note |
|---|---|---|
| `start` | **shared** | The room begins together |
| `goto` | **shared** | The only resync, so it has to be available to both |
| `next`, `previous`, `pause`, `resume`, `repeat` | **personal** | Move at your own pace |
| Volume, mute, subtitles | **personal** | |
| **Audio language** | **personal** | |
| Character (male/female model) | **personal** | conditional — see below |
| Camera | **personal**, with follow | |

**The legacy app synced all of the personal ones** — `audio_volume`, `muted`,
`show_subtitles`, `language_selection` and `character_selection` are all in its payload.
Defensible for one operator configuring one patient's booth; wrong for peers, where it means
pushing your volume onto someone else's speakers. This is a defect the new split fixes, not
a preference.

Language being personal is the strongest part: audio and transcripts are already addressed
`assets/audio/<lang>/<character>/<NN>.mp3` per step, so two people can watch one walkthrough
in different languages with **no new machinery at all**.

Three consequences that have to be designed rather than discovered:

1. **A symmetric `goto` is a real race** — unlike the disjoint sets above, two people can
   now issue the same command at once. It resolves cheaply because the session row is
   already the serialization point: the server orders the writes and everyone converges on
   what was persisted. Last-write-wins is *defined* here rather than merely likely, which is
   the only reason it is acceptable.
2. **The room stores an anchor, not a current step.** With transport personal there is no
   single "where we are" — only "where we were last jumped to". Shared state is
   `anchor_step` plus who set it and when; each participant carries their own position. A
   `current_step` column would be a lie for everyone who has moved since, and the legacy row
   has exactly that column.
3. **Drift has to be visible.** `goto` being the only resync means someone three steps behind
   must see that they are, with one click back. Figma's follow indicator is the reference.
   Without it, a desynced room reads as broken rather than as personal pacing.

✅ **Personal character is safe — clip-name parity verified 2026-09-22.** Both models expose
the same 12 clips in the same order: `01. Greeting`, `02. Step forward`, `03. Adjust feet`,
`04. Face forward`, `05. Relax arms`, `06. Incorrect posture`, `07. Capture`,
`08. Widen stance`, `09. Face forward`, `10. Raise arms`, `11. Scanning`, `12. Completion`.
The numeric prefix is what joins a clip to `<NN>.mp3` and `<NN>.txt`.

Note `09. Face forward` duplicates `04. Face forward`'s wording but not its number — so
name-addressing stays unambiguous **only because of the prefix**. Any asset pipeline that
strips it reintroduces the duplicate-name failure, so keep the prefix as part of the
contract rather than as decoration.

### Who may drive: two controllers, granted at runtime (decided 2026-09-22)

A room holds N participants; **at most two may issue the shared commands** (`start`,
`goto`). The host is always one. The second slot is **granted by the host at runtime and
revocable**, defaulting to nobody.

Runtime rather than declared-at-creation, because the field is one-sided on this: Live
Share, Zoom, Teams "give control" and Discord stage speakers all grant capability during the
session, revocably, default-off. The need to hand someone the controls arises *mid*-session
and you cannot predict it at creation — and a declare-upfront model has no way to take
control back, which is the requirement that actually matters.

Everyone else keeps the personal set (transport, volume, subtitles, language, camera), so a
watcher is never a passive screen.

Four design consequences:

1. **Control is a claim with a TTL, not a `can_control` boolean.** A flag on a row can only
   be cleared by the holder or by the host noticing — the exact shape that left messenger
   claiming a call was live forever. A claim keyed by `owner_id`, refreshed by the
   heartbeats `realtime-service` already runs, lapses on a dead grantee without anyone
   intervening. `ClaimWithTTL` returns `(won, currentHolder)` and is already exercised
   against real Redis Lua.
2. **Grant to an `owner_id`, not a connection or a session.** Reload is the common case and
   must resume control. The legacy app's reconnection heuristics existed precisely because
   it had no identity to anchor state to.
3. **The host retains control and grants only the second slot.** A host able to transfer
   control away entirely can be locked out by an absent or broken grantee; keeping the host
   in makes that unreachable rather than merely recoverable.
4. **Enforce on the server for every shared command.** Hiding the button is not revocation —
   a stale client goes on emitting `goto`. Check the claim holder where the command is
   applied.

The tie between the two controllers is unchanged and already handled: the session row
serializes, last write wins, and everyone converges on what was persisted.

**This makes host a capability, not only a membership role** — correcting what this doc said
before the decision. The host is the only participant who can grant, revoke and end.

Still open, and cheap to defer: whether a guest may *request* control, or only receive it.
Zoom has both; the request path is pure UI over the same claim.

## What to drop

**Patient and operator.** Two fixed roles, one guided and one supervising, is that client's
domain. The mechanism underneath — *one machine drives a 3D scene, another follows, either
may take over* — is role-free, and the framing is still open (see below).

Also dropped: OpenEMR, sessions/facilities/arrival status, the operator's patient table and
filters, the failure-reason and confirmation modals, the "call operator" help toast.

## Open — decide before building

1. ~~What are the two machines?~~ **Decided 2026-09-22.** A room with a host and guests;
   guests are other people and need a platform account, so invites go through the accounts
   directory (`/api/accounts/users/lookup`) — no public join link, no anonymous access, no
   new auth surface. Control is the shared/personal split above: `start` and `goto` shared,
   everything else personal, and **at most two participants hold the shared commands** — the
   host plus one grantee, assigned at runtime and revocable. Only remaining sub-question is
   whether a guest may request control or only receive it.
2. **Which asset**, given the IP question above.
3. ~~Angular + three.js directly, or a wrapper?~~ **Leaning React (dathq, 2026-09-22) — the
   first non-Angular frontend on the platform.** `@react-three/fiber` + `drei` is the real
   argument: Angular has no equivalent, so it would mean hand-writing scene-graph
   reconciliation and the render loop (`useFrame` becomes a `requestAnimationFrame` loop
   owned by a service, outside `NgZone`). What that costs, measured rather than assumed:

   | Concern | Cost |
   |---|---|
   | **CI** | **None.** `stack-node-vitest.yml` is the generic Node template and fits React + Vite as-is — no new template, no tag, no `ExtendsCheck` entry, no canary. Note `testCommand` is hardcoded to vitest (line 50), not a parameter, so the repo must use vitest |
   | **Federating it** | Small. MF's container protocol is framework-agnostic: the remote exposes a mount function and the shell wraps it in a component that passes a host element. `shareAll` is filtered to real packages and React shares nothing with the host, so it ships its own (~45 KB gz) |
   | **The chrome** | **The real cost.** `@datha/platform-ui` is an Angular library and does not travel; `AuthenticationService`, `auth.interceptor.ts` and `http-context.tokens.ts` are already copied per frontend, and a fifth copy in another idiom means a shared fix can no longer even be pasted across; ngx-translate's remote-catalog merge does not apply |

   **Decided 2026-09-22: a federated remote.** dathq: *"still need to be in the ecosystem"*.
   A standalone app was offered and declined — the product belongs in the shell like every
   other one, and this also becomes the first real test of whether the MF host is genuinely
   framework-agnostic rather than Angular-only by accident. The integration contract is
   below.

   ⚠️ Picking the legacy app's own stack makes copy-paste from client source effortless.
   Techniques carry over; **files do not** (see § Before any of this is built).
4. **Which product does it live in** — its own remote (a 5th, so the bottom-nav cap again),
   or a surface inside an existing one.

## Integration contract — a React remote in an Angular host

### The container protocol decides the bundler

The shell loads remotes with `@angular-architects/module-federation`'s
`loadRemoteModule({ type: "manifest", … })`, against an in-memory manifest built from
`environment.remotes` by `setManifest()` in `main.ts`. That is the **webpack 5 MF v1**
container contract — `init(sharedScope)` then `get(module)`.

So the remote must emit that container:

**Decided 2026-09-22: Rspack (or webpack) with `ModuleFederationPlugin`** — dathq confirmed
Vite is not required. That emits exactly the container the host already loads, so the one
genuine unknown in this design disappears; Rsbuild gives Vite-like DX over Rspack and vitest
still fits `stack-node-vitest.yml`.

Rejected: `@module-federation/vite` (targets the MF2 runtime, interop with this host
unproven) and `@originjs/vite-plugin-federation` (different protocol in several modes,
unreliable cross-host). Either would have required a loading spike as step 0.

### ⚠️ Zone.js will run change detection on every rendered frame

The shell is **not** zoneless — `angular.json` lists `polyfills: ["zone.js"]`. Zone.js
monkey-patches `requestAnimationFrame`, so a three.js render loop inside the remote triggers
a full Angular change-detection pass **60 times a second**, across the shell's entire
component tree.

**Decided 2026-09-22: migrate the shell to zoneless before this product ships** (dathq).
That deletes the trap rather than working around it, and it is the correct end state on
Angular 21 regardless — the four frontends are zone-based only because they predate zoneless
being the default and were never migrated. Tracked in `platform/platform-backlog.md`.

Until then — and as a belt-and-braces measure afterwards, since a remote cannot assume its
host is zoneless — mount the React tree outside the zone:

```ts
this.ngZone.runOutsideAngular(() => (this.unmount = mount(el, props)));
```

Everything the React tree then schedules, its rAF loop included, stays outside. Note this is
invisible standalone at :4004, where there is no Angular to tick — the same shape as every
other trap in this document: correct alone, wrong hosted. The guard belongs in the shell's
suite.

### Exposure and mounting

The remote cannot expose an Angular component, so it exposes a **mount function**:

```ts
// remote: ./Mount
export function mount(el: HTMLElement, props: MountProps): () => void; // returns unmount
```

The shell wraps it in a host component modelled on
`shared/header-widget-host/header-widget-host.component.ts` — keep its
`InjectionToken`-over-`loadRemoteModule` indirection, which exists so the degradation path
(remote down → empty slot, one warning, no broken chrome) stays testable.

Two Angular specifics, both already learned here the hard way: mount in
**`afterNextRender`**, never a constructor — where Angular puts a host element is not
decided until after the first render, which is why `CallDockComponent`'s re-parenting was
silently undone inside `@if`. And unmount in `ngOnDestroy`, or a route change leaks a live
three.js context and its GPU buffers.

### ⚠️ CSS must be JS-injected, never extracted

**A host never loads a remote's global stylesheet.** Tailwind 4 emits precisely such a
sheet, so a remote built with `MiniCssExtractPlugin` renders perfectly at :4004 and
**unstyled at :4000**, with nothing in the console. Bundle styles into the JS
(`style-loader`-style injection) so they arrive with the container.

This is the same rule that cost `--messenger-dock-width` and event-store's compact table
rules. The guard belongs in the **shell's** suite, because a standalone remote cannot
reproduce it.

### Sharing: React is the remote's own, not a singleton

The shell shares via `shareAll({ singleton: true, strictVersion: false, requiredVersion:
"auto" })`, filtered to packages that really are dependencies. **Nothing in the host provides
React**, so the remote should carry its own copy rather than declaring it a shared singleton
against a scope no one fills (~45 KB gz, and it removes a whole class of resolution
surprise).

Sharing only starts paying when a *second* React remote exists — and that is also when
version alignment begins to matter, exactly as the exact Angular 21.2.x pin does today for
the Angular remotes. Revisit then, not now.

### What crosses the boundary

| Concern | Mechanism |
|---|---|
| **Auth** | Host passes `getAccessToken: () => Promise<string>` in `MountProps`. **The remote never implements OAuth** — one interface, two implementations (hosted, standalone). Deliberately *not* a fifth copy of `AuthenticationService`, which is the trap the four Angular frontends are already in |
| **Theme** | Free, via the cascade. The shell declares its custom properties on `:root` of the shared document, so React-rendered DOM inherits them. Consume `var(--…)`; the asymmetry is that host globals reach the remote and never the reverse |
| **Language** | A `language` prop, re-rendered on change. The remote owns its own catalogues (react-i18next); ngx-translate's remote-catalog merge does not apply and is not needed — the only shell-owned strings are the `APPS.*` tile name and description |
| **Design system** | `@datha/platform-ui` is Angular and does **not** travel. Either accept a different look, or publish the tokens as a framework-neutral CSS package. Components would have to be rebuilt |

### Housekeeping

- Port **4004**; `environment.apps` + `environment.remotes` rows in the shell.
- A **public-path env var** is mandatory, not optional: a `localhost:4004` default bakes
  itself into every lazy chunk and works only on the dev machine — `messenger-frontend`
  already paid for this one.
- CI: `stack-node-vitest.yml` as-is, plus the Playwright step. No new template, no tag, no
  `ExtendsCheck` entry. `testCommand` is hardcoded to vitest, so the repo uses vitest.
- A 5th product makes the bottom-nav cap a hard prerequisite.

## Why this is worth building at all

Three stated goals, all of them real:

1. **Explore three.js properly**, with authored animation and a real scene.
2. **Reuse the platform's realtime for something other than calls.** `realtime-service` has
   only ever carried WebRTC signalling; a second, completely different consumer is what
   proves the room model generalises rather than being a calling feature wearing a generic
   name.
3. **Practise Module Federation across frameworks** — an Angular host with a React remote
   (dathq, 2026-09-22). Today "the host is framework-agnostic" is an assertion the platform
   has never tested; four Angular remotes cannot test it. This supersedes the earlier
   argument in this doc for a standalone app, which rested on MF *not* being a goal.
