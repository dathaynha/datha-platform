# Local environment (dathq's dev machine)

_How this workspace is set up on the local machine — written down 2026-09-04 because dathq stops using this device in late September 2026 and this knowledge was only in agent memory._

Everything here is **local dev only**. No service depends on it in CI: pipelines
run on `ubuntu-latest` agents with their own toolchain.

## Node — via nvm

`.nvmrc` + `engines.node` in all 8 Node repos; the canonical version and the bump
policy live in **`always-apply/workspace-layout.md` § Node version** (do not
restate the number here).

**nvm does not auto-switch on `cd`** on this machine — no shell hook is installed,
so the shell keeps whatever version was last `nvm use`d. Consequence seen
2026-09-04: `.nvmrc` said 22 while the shell ran 24.18.0, and `pnpm install`
prints `WARN Unsupported engine` (it warns and installs anyway — a signal, not a
gate). Either install an nvm `cd` hook or accept that `nvm use` is manual.

pnpm is pinned via corepack (`packageManager` in each `package.json`); pipelines
run `corepack prepare pnpm@<version> --activate`.

## `.playwright-mcp/` at the workspace root

The Playwright MCP server writes its scratch there — page snapshots (`page-*.yml`), console logs (`console-*.log`) — relative to the workspace root, **not** into any repo. Harmless: the root is not a git repo, so nothing leaks into a PR, and no `.gitignore` entry is needed. It does grow with every headed session; delete it freely.

Its browser profile is **persistent**, so a Google or Microsoft session logged in during one session is still there in the next. Convenient for verification, and worth remembering before driving a logout test — the account is real.

## Docker — Colima on this machine; either engine works

> **On a new machine, the engine is a free choice.** Docker Desktop was banned
> **on the old machine only**, by company licensing (2026-07-20) — that is a
> fact about the employer, not a platform requirement. Nothing here depends on
> the engine: services talk to `localhost` ports published by
> `_local/docker-compose.yml`, which is engine-agnostic. The colima mechanics
> below (the wedge, `brew services` autostart, `--network-address`) are lima
> specifics that simply do not apply under Docker Desktop; everything about
> **volumes**, `docker compose stop` and **never `down -v`** applies to both.

Engine on the old machine is a **colima** VM (`colima start`, auto-started via `brew services`) with the
standalone Homebrew `docker` CLI + compose plugin (`cliPluginsExtraDirs` in
`~/.docker/config.json`). UI is **Portainer CE** at `https://localhost:9443`.
Compose + volume backup/restore commands live in `_local/README.md`.
Versions at time of writing: colima 0.10.3 / lima 2.1.4, `vz` + `virtiofs`, 8 GiB.

- Engine: `colima status`. If wedged (`already running` but a dead socket):
  `colima stop --force && colima start`.
- **Colima wedges periodically** (first diagnosed 2026-07-30): `colima start`
  reports "already running" while the docker socket *and* VM SSH are dead, yet
  lima host-agent logs stay healthy and the serial log is clean — **not OOM, not a
  kernel panic**, but a port-forward layer collapse (likely macOS `vz`/`vmnet`
  state). Raising memory 6 → 8 GiB did **not** cure it. Escalation if
  `stop --force && start` stops working: reboot the Mac (clears vmnet), then
  `brew upgrade colima lima`, and only as a last resort recreate the VM —
  **back the volumes up first**, because `colima delete` wipes all container data.
- Volume tarball backups live in `_local/docker-backup/`, **platform volumes only**
  (`pgdata`, `natsdata`, `redisdata`).
- Other projects share this VM. **`packtech`** (external recruitment app) keeps
  containers `pr*` and volumes `packtech_recruitment_*` — do not stop or remove
  them. **Its source was deleted 2026-09-08**, so those two volumes
  (`packtech_recruitment_postgres_data`, `_redis_data`) are now **orphaned**:
  the data is intact but the compose file that could start against it is gone.
  Its MinIO data was a bind mount inside the source folder and went with it.
- **`agentic-coding-live-demo` is finished and fully removed** (2026-09-08):
  11 containers, 14 `public.ecr.aws/supabase/*` images (~10.9 GiB) and both of
  its volumes. That was the "heavy neighbour" Supabase stack that contributed
  to the 2026-07-30 VM wedging — it is gone, so do not go looking for it.
- **Classify before removing anything in Docker.** Every image, container and
  volume belongs to exactly one of: this platform (`_local/docker-compose.yml`,
  `platform-observability/`), `packtech` (`pr*`), Portainer (no compose label,
  dathq's tooling — leave it), or nothing. Only the last group is removable, and
  `redis:7-alpine` is shared by the platform **and** packtech — which is why
  `docker image prune -a` is never the tool: it would also take the stopped
  observability and packtech images. → `.claude/skills/platform-disk/SKILL.md`
- Infra containers: `_local/docker-compose.yml` — Postgres, Redis, NATS, Mailpit,
  and **coturn** (added 2026-09-09 for Messenger phase 2, on dathq's word — that
  file is the one thing in `_local/` an agent may read and edit).
  Start/stop them with `docker compose up -d` / **`docker compose stop`**.
- **coturn is opt-in, and deliberately not in the default start line.** It
  publishes 3478/udp+tcp plus a relay range `49160-49179/udp`, and *every
  published UDP port is a separate forward through the colima VM* — that
  forwarder is the part of this machine that wedges (see the 2026-07-30 note
  above). Twenty relay ports is far more than 1:1 calling needs. Start it only
  for call work: `docker compose up -d coturn`.
- **The TURN secret lives in two places and must match**: coturn's
  `--static-auth-secret` (from `TURN_STATIC_SECRET` in `_local/.env`, defaulting
  to `datha-local-turn-secret` in the compose file) and `TURN_STATIC_SECRET` in
  `realtime-service/.env`, which dathq writes. A mismatch fails every call to
  relay with no useful error on either side — check this first when a call
  connects directly but never over TURN.
- **coturn in a container advertises the wrong relay address by default.** It
  would hand the browser its bridge IP (`172.18.x.x`), which nothing on the host
  can reach, so the compose file sets `--external-ip` (default `127.0.0.1`).
  Relaying between two *machines* needs `TURN_EXTERNAL_IP` set to the LAN or
  public address plus a router port-forward — untested as of 2026-09-09.
- ⚠️ **UDP does not reach published container ports on this machine; TCP does.**
  Measured 2026-09-09: a raw STUN Binding Request to `127.0.0.1:3478/udp` from
  the host times out, while `turnutils_stunclient` **inside** the container
  answers instantly (`UDP reflexive addr: 127.0.0.1:47800`) — so coturn's UDP
  listener is fine and the host→VM forward is what drops it. Chrome confirms it
  behaviourally: offered only `turn:…?transport=udp` it gathers **no** relay
  candidate and ICE never leaves `new`; offered only `transport=tcp` it connects
  relay↔relay and moves real media (17 KB each way in 3 s).
  - **Consequence: none for calling.** Chrome negotiates the TCP relay by
    itself, and a normal local call uses host candidates and no relay at all.
    What is *not* locally testable is the UDP relay path, which is the one a
    real deployment prefers.
  - **Do not "fix" this with a colima restart** — it is a lima port-forwarding
    limitation, not the periodic wedge described above. The genuine fix is to
    give the VM a reachable address (`colima start --network-address`, currently
    unset: `colima ls` shows an empty `ADDRESS`) and point `TURN_URLS` /
    `TURN_EXTERNAL_IP` at it instead of `127.0.0.1`, bypassing forwarding
    entirely. That restarts the VM, so it is dathq's call.
  - Both TURN transports stay in `TURN_URLS` on purpose: the UDP entry costs
    nothing when it fails and is the preferred path everywhere else.
- All coturn config is passed as `command:` arguments rather than a
  `turnserver.conf`, so `_local/docker-compose.yml` stays the single file
  describing local infra. **There is no `_local/.env`** (decision 2026-09-09):
  both substituted variables have fallbacks in the compose file, so
  `TURN_STATIC_SECRET` resolves to the literal `datha-local-turn-secret` and
  `TURN_EXTERNAL_IP` to `127.0.0.1`. `realtime-service/.env` simply carries the
  same literal secret. An `.env.example` was written here and then deleted as
  dead weight once that was settled — do not re-add one without a variable that
  actually needs to vary.
- If a Compose variable ever *does* need overriding, a `.env` next to
  `docker-compose.yml` is how: Compose reads it to fill the `${...}`
  placeholders inside that file. It is not a service env file, and
  Postgres/Redis/NATS/Mailpit take none of it — their throwaway local
  credentials are literals in the compose file on purpose. The realistic first
  case is `TURN_EXTERNAL_IP`, for relaying between two machines.
- ⚠️ `_local/` is **not a git repo**, so the compose file is as device-local as
  `.claude/` itself — same 2026-09-23 deadline.
- **Never `docker compose down -v`, never `colima delete`** — that destroys the
  volumes (`…_pgdata`, `…_redisdata`, `…_natsdata`) and JetStream data with them.
  The volumes predate the compose file, so compose logs a benign
  `volume … already exists but was not created by Docker Compose` warning.
- Never add a `restart:` policy — infra must not auto-start with the machine.
- **Portainer (`:9443`) is not in that compose file** and is not this project's —
  leave it running when stopping the platform, and never stop another project's
  containers.
- `nats-server` exits **1** on a clean SIGTERM (`Trapped "terminated" signal` →
  `Initiating JetStream Shutdown...`). That is not a failure.
- Only `_local/`'s infra working files are readable (`docker-compose.yml`,
  `README.md`, `docker-backup/`, `init-db.sh`, `sql/`) — the rest of `_local/`
  holds PATs and personal notes and is off limits (`context-boundaries.md`).

After stopping infra, confirm the JetStream state survived by starting it again
and checking `curl -s 'localhost:8222/jsz?streams=1'` still lists `EVENTS` + `DLQ`
with their message counts. Streams missing → `platform-nats` `pnpm reconcile`
(topology owner) **before** starting any consumer.

## PATH — two separate fixes

**Login shells (2026-08-05):** `eval "$(/opt/homebrew/bin/brew shellenv)"` is
appended to `~/.bash_profile` and `~/.zprofile`, so login shells resolve
`go`/`docker`/`colima` without manual prefixes (its absence was breaking the
VSCode Go extension). Non-login shells can still miss Homebrew and nvm.

**GUI-launched apps (2026-08-28):** macOS hands them a minimal
`/usr/bin:/bin:/usr/sbin:/sbin`, so Claude Code in **VSCode-from-Dock** sees no
`/opt/homebrew/bin`, `/usr/local/bin` or nvm — `go`, `pnpm`, `node`, `npx` all
missing, and stdio MCP servers spawning a bare command die with
`ENOENT: Executable not found in $PATH`. Fixed by
**`~/Library/LaunchAgents/com.dathq.setenv-path.plist`** —
`launchctl setenv PATH <login PATH>`, `RunAtLoad`, bootstrapped into `gui/$UID`.

- Applies only to apps launched **after** it runs, so a full **Cmd+Q relaunch**
  of VSCode is required; a new window is not enough. Symptom it has not been
  picked up: `command not found` for a brew binary that Terminal resolves.
- The **nvm dir is version-pinned in the plist** — bump it on a Node major
  upgrade (the `/usr/local/bin` symlinks cover `node`/`npx` regardless).
- Undo: `launchctl bootout gui/$(id -u)/com.dathq.setenv-path && rm <plist>`.
- System-wide alternative: `sudo launchctl config user path "<same>"` + reboot.
- Until a relaunch happens, export PATH inline in each shell call.

## This machine has no camera (2026-09-11)

`system_profiler SPCameraDataType` returns **nothing**. There is no built-in or
attached webcam, so `getUserMedia({ video: … })` rejects with
`NotFoundError: Requested device not found` — which is exactly how Messenger's
first video call failed.

Consequences, and they are not small:

- **The video *sending* path cannot be verified here.** Both browser contexts
  run on this machine, so neither has a camera to send. Unit specs use fake
  tracks and Playwright uses `--use-fake-device-for-media-stream`, so every
  suite is green and proves nothing about a real one. Closing that needs an
  external webcam, or the second machine from slice 5.
- **A video call itself is still testable**, and should be tested: it must
  connect, degrade to audio, and show the no-camera tile rather than failing.
- Microphones are unaffected — audio calling has always worked here.
- **The app degrades rather than refusing.** A camera fault falls back to
  audio-only and adds a `recvonly` video transceiver, so the peer's video still
  arrives; the call is flagged `cameraMissing` and the local tile says so. This
  is what Meet, Zoom, Teams and Messenger all do. An earlier fix here *disabled*
  the video-call button instead, which was wrong — it took away a call that
  would have worked. `hasCamera` now only greys out the in-call camera toggle
  and changes a hover hint.


## Verifying UI work

Verification happens in **headed Chrome driven by Playwright**, not a VSCode
webview: seed auth directly (mint the JWT into `localStorage`, see
`testing/e2e-testing-strategy.md`), run the checks, report the result. Never hand
dathq a URL and ask what he sees.

## Ports

dathq owns the ports; the agent must not leave a dev server running unless the
`run-platform` skill was explicitly invoked (`always-apply/no-running-ports.md`).
Port table: `rules/workspace-map.md`.

Infra ports, which are containers rather than dev servers and stay up: Postgres
5432, Redis 6379, NATS 4222 (+ 8222 monitoring), Mailpit 1025/8025, coturn 3478
(udp+tcp) and the relay range 49160-49179/udp.

**Killing a dev server is easy to get wrong. Two ways it went wrong on
2026-09-09, both of which killed a server dathq had asked to keep running:**

- A broad `pkill -f "go-build.*gateway"`, meant to clean up a temporary gateway
  on :8081, also killed the one on :8080. Never pattern-match on a process name
  when a port identifies the target.
- **`lsof -ti :<port>` lists clients of that port as well as its listener.**
  Killing "whatever is on :3003" therefore killed `api-gateway`, which merely
  held a proxy connection to notification-service. Always narrow it:
  `lsof -ti :<port> -sTCP:LISTEN | xargs kill`.

**A `pnpm dev` / `npm run dev` service is `tsx watch`: a supervisor plus a
child.** Killing the listener leaves the supervisor, which respawns it — so the
port comes back, and the next start fails with `EADDRINUSE`. On 2026-09-09 that
produced a messenger-service that acked JetStream messages while dying, which
looked exactly like a broken projection for twenty minutes. Kill the supervisor:
`pkill -f "<repo>/node_modules/.bin/../tsx"` (the command line is
`node …/tsx/dist/cli.mjs watch …`, so `pkill -f "tsx watch"` matches nothing),
then confirm with `lsof -ti :<port> -sTCP:LISTEN`.
