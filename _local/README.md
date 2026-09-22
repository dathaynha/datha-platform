# `_local/` — local infrastructure

Everything the platform needs that is not one of its own services: Postgres,
Redis, NATS JetStream, a mail catcher, and an optional TURN relay. Start these
before any service.

```bash
cd _local
docker compose up -d postgres redis nats mailpit
docker compose ps        # wait for "healthy" on all four
```

| Container | Purpose | Port |
|---|---|---|
| `postgres` | one database per service, created by `init-db.sh` | 5432 |
| `redis` | presence and call state for `realtime-service` | 6379 |
| `nats` | JetStream — the event backbone | 4222, monitoring 8222 |
| `mailpit` | catches outbound mail, web UI | 1025, UI 8025 |
| `coturn` | TURN relay for WebRTC, **opt-in** | 3478 |

coturn is deliberately not in the line above: every published UDP relay port is
a separate forward through the container VM, and calls connect directly without
it whenever both peers can reach each other. Start it with
`docker compose up -d coturn` if you want to exercise the relay path.

## Databases

`init-db.sh` runs on first boot only and creates one database per service.
To re-run it, remove the volume — which destroys the data:

```bash
docker compose down            # NOT -v unless you mean it
docker volume rm datha_platform_datha_platform_pgdata
docker compose up -d postgres
```

Each service owns its own schema and runs its own migrations on start.

## JetStream

The topology — every stream and consumer — belongs to `platform-nats` and to
nothing else. No service creates streams on startup, which is what keeps two
services from disagreeing about a durable name:

```bash
cd ../platform-nats && pnpm install && pnpm reconcile
```

Check it took:

```bash
curl -s 'localhost:8222/jsz?streams=1&acc=$G' | grep -E '"name": "(EVENTS|DLQ)"'
```

Note the `acc=$G` and the single quotes — without the account parameter that
endpoint returns totals with no stream names, which reads like the streams are
missing when they are fine.

## Stopping

```bash
docker compose stop      # keeps volumes and therefore your data
```

`docker compose down -v` deletes the volumes. There is rarely a reason.

## Seed data

`sql/chat-loading-performance-seed.sql` generates a large conversation for
testing list paging and scroll performance.

## Credentials

The values in `docker-compose.yml` are local-only placeholders and bind to
localhost. Real environments generate their own and keep them in a secret store.
