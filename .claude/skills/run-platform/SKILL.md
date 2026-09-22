---
name: run-platform
description: >-
  Start or stop platform dev servers by product group. Use when the user says
  run platform, run core, run chatbot, run event store, run all, stop all,
  stop chatbot, or similar. Explicit run request = servers stay running after
  the turn (authorized exception to the no-running-ports rule).
---

# run-platform

Start platform dev servers in the background, by group. The user saying "run X" IS the authorization to leave those servers running — this skill is the explicit exception to `.claude/docs/always-apply/no-running-ports.md`. Never start servers without such a request, and never kill ports the user didn't ask to stop.

## Groups

| User says | Repos (port) |
|-----------|--------------|
| "run platform" / "run core" | shell-frontend (4000), api-gateway (8080), notification-service (3003), accounts-service (3006) |
| "run chatbot" | core + chatbot-service (8050) + chatbot worker + chatbot-frontend (4001) + file-service (3001) |
| "run event store" | core + event-store (3002) + event-store-frontend (4002) |
| "run messenger" | core + messenger-service (3005) + realtime-service (3004) + messenger-frontend (4003) + file-service (3001) + **coturn** (infra, 3478) |
| "run all" | all of the above (12 apps + worker) |

**file-service (3001) is shared, not chatbot's alone**: messenger attachments POST `/api/files/prepare` through the gateway, so with 3001 down an upload fails with a **502 from the gateway** and nothing in messenger-frontend or messenger-service logs a word — the failure looks like a messenger bug and is not one (dathq, 2026-09-11). It belongs to the chatbot group **and** the messenger group. notification-service is core chrome (shell bell polls it); **accounts-service is core too** — the shell calls `POST /api/accounts/users/me/sync` on every start with a valid session (`AccountSyncService`, wired 2026-09-09 after the call turned out never to have been implemented), which 502s without it, and without the row the person is invisible in the directory. The shell's messenger header widget is loaded from messenger-frontend: with 4003 down the slot renders empty and logs one warning, which is by design, so core does not require it. A named single repo ("run file service") starts just that repo.

**Messenger is never folded into core** (dathq, 2026-09-14). "run platform" / "run core" starts four apps and nothing else — messenger costs five more (messenger-service, realtime-service, file-service, the 4003 remote and coturn), which is a drag on every session spent developing some *other* product. Ask for it by name: "run messenger". The shell is built for its absence — the header widget slot renders empty and logs one warning when 4003 is down, by design.

**One product at a time, two at most** (dathq, 2026-09-08). Each `ng serve` costs ~1-1.5 GB of RAM, and every rebuild grows that frontend's `.angular/cache`. "run all" still exists, but it is the exception rather than the habit — and the suites are built for it: the shell's remote-dependent specs self-skip when a remote is down, so a single-product session still runs green.

## Run commands

| Repo | Command | Port |
|------|---------|------|
| shell-frontend | `pnpm start` | 4000 |
| chatbot-frontend | `pnpm start` | 4001 |
| event-store-frontend | `pnpm start` | 4002 |
| api-gateway | `go run -mod=vendor ./cmd/gateway` | 8080 |
| chatbot-service | `uvicorn app.main:app --port 8050 --reload` (use repo venv) | 8050 |
| chatbot worker | `python -m app.worker` (same venv, second process) | — |
| file-service | `pnpm dev` | 3001 |
| event-store | `pnpm dev` | 3002 |
| notification-service | `pnpm dev` | 3003 |
| accounts-service | `pnpm dev` | 3006 |
| messenger-service | `pnpm dev` | 3005 |
| realtime-service | `go run -mod=vendor ./cmd/realtime` | 3004 |
| messenger-frontend | `pnpm start` | 4003 |

For chatbot-service, prefer the repo's virtualenv (`.venv/bin/uvicorn`, `.venv/bin/python`); if absent, check the repo README rather than guessing a global python.

## Start procedure

1. **Disk preflight** — `df -h /System/Volumes/Data | tail -1`. Under ~10 GB free, say so in one line and name `platform-disk`; under ~2 GB, prune before starting, because the first build will fail with `ENOSPC` and that error reads like a broken test rather than a full disk (it did on 2026-09-08). Do **not** prune on your own initiative once servers are up — they hold those caches open.
2. **Infra preflight and start** — check listeners: Postgres 5432, Redis 6379, NATS 4222 (`nc -z localhost <port>`). Needed per group: chatbot → all three; event-store → Postgres + NATS; core → Postgres + NATS (notification-service, accounts-service). Anything missing → **start it** (dathq handed infra over 2026-08-17):
   - Engine first: `docker info` — that is the engine-agnostic check. If it fails, start whichever engine this machine uses (`colima start`, or launch Docker Desktop). Under **colima** a wedge looks like `colima status` reporting `already running` with a dead socket → `colima stop --force && colima start`.
   - `cd _local && docker compose up -d postgres redis nats mailpit` — the rest of `_local/` stays off limits.
   - **Messenger group also needs coturn**: `docker compose up -d coturn`. It is deliberately not in the line above, because every published UDP relay port is its own forward through the colima VM and chat development never needs a relay. Calls still *connect* without it whenever both peers can reach each other directly — coturn only matters behind symmetric NAT, which is exactly the case that is impossible to notice locally.
   - Wait for `healthy`, then confirm JetStream survived: `curl -s 'localhost:8222/jsz?streams=1&acc=$G' | grep -cE '"name": "(EVENTS|DLQ)"'` → `2`. Streams missing → run `pnpm reconcile` in `platform-nats/` (topology owner) before starting apps. ⚠️ **`jsz?streams=1` alone returns totals with no stream names** — grepping it finds nothing and looks like the streams are gone when they are fine (corrected 2026-09-18). The `acc=$G` is required, single-quote the URL so `$G` survives the shell, and note the JSON is pretty-printed so the key has a space after the colon.
   - Never add a `restart:` policy — infra must not auto-start with the machine.
3. **Port check** — for each target port, if already listening: skip that repo, report "already up". Idempotent re-runs are expected.
4. **Start** — each repo in the background from its own directory, output redirected to `.claude/tmp/run/<repo>.log` (create dir). One process per repo (+ the chatbot worker as its own process).
5. **Verify** — wait briefly, then confirm each port is listening (frontends compile slowly — allow ~30-60s; check the log tail for compile errors instead of blocking on the port).
6. **Report** — status table: repo, port, up/failed/already-up, log path. On failure quote the decisive log line.

## Stop procedure

"stop all" / "stop chatbot" / "stop <repo>" → kill the processes for that group's ports, plus the chatbot worker process if its group is stopped (`pkill -f "app.worker"` scoped to the repo path). Report what was killed.

**Always scope the kill to listeners:**

```bash
lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill
```

⚠️ **Never `lsof -ti :<port> | xargs kill`.** That matches *any* socket on the port, **including the client side of a connection** — so killing one backend can take down whatever was talking to it. On 2026-09-11 restarting messenger-service that way killed **api-gateway** as well (it died with `signal: terminated` while proxying browser traffic to :3005), which then looked like an unrelated crash. `-sTCP:LISTEN` kills only the server that owns the port.

**Prune window** — stopping the frontends is the one safe moment to clear `.angular/cache`: deleting it under a live `ng serve` produces junk rebuild errors. After a "stop all", report free space and name `platform-disk` if it is low. Offer only — the deletion is dathq's call.

**Infra stop** — only on "stop infra" / "stop everything including infra" / "stop all + infra": `cd _local && docker compose stop` (stops coturn too) (**`stop`**, never `down -v` — that destroys volumes). Plain "stop all" means apps only; leave containers running. Never stop Portainer or another project's containers.

## Hard rules

- Only start what the group defines; user names extra repos → add them.
- Infra (Postgres/Redis/NATS/Mailpit) is mine to start and stop via `_local/docker-compose.yml`; the rest of `_local/` is still off limits.
- Never destroy container data — `docker compose stop`, never `down -v`, never `colima delete` (nor Docker Desktop's *Reset to factory defaults*, which is the same thing).
- Never touch `.env` files; missing env config → report, don't fix silently.
- Servers started here stay running at end of turn — that is the point.
