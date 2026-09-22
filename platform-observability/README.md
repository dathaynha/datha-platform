# platform-observability

Operational observability stack for the DatHa platform: **Grafana + Loki + Prometheus + Alloy**, self-hosted in colima Docker. This repo owns the whole stack and every dashboard — dashboards exist only as code under `grafana/`; UI-only edits are throwaway.

Distinct from the JetStream event log (curated business facts, owned by `event-store`). The two link via `correlation_id`.

## Run

```bash
cp .env.example .env         # first run: fill POSTGRES_EXPORTER_DSN (gitignored)
docker compose up -d
docker compose down          # stop (volumes keep data)
```

| Service | Port | Purpose |
|---------|------|---------|
| Grafana | 3000 | dashboards (anonymous admin — local only) |
| Loki | 3100 | log store, 14 d retention |
| Prometheus | 9090 | metrics store, 14 d retention |
| Alloy | 4317 / 4318 | OTLP in (gRPC / HTTP) from host services |
| Alloy UI | 12345 | collector pipeline debug |
| postgres-exporter | 9187 | Postgres metrics (DSN from `.env`) |
| redis-exporter | 9121 | Redis metrics |
| nats-exporter | 7777 | NATS + JetStream metrics (streams, consumer lag, DLQ) |

Platform services run on the **host** (pnpm dev / go run / uvicorn); the stack reaches them via `host.docker.internal`, services push to the stack via `localhost:4318`.

## Service contract

**Logs** — structured JSON to stdout **and** pushed via OTLP HTTP to `http://localhost:4318/v1/logs` with OTLP resource attribute `service.name` set (becomes the Loki `service_name` label). Mandatory body fields: `timestamp`, `level`, `service`, `msg`, `correlation_id` (when in request/event context). The `correlation_id` is the same id that rides the event envelope — Grafana pivots from a business event to every log line across services. Never publish operational logs into JetStream.

**Metrics** — each service exposes Prometheus `/metrics` on its own port (scrape targets in `prometheus/prometheus.yml`). Gateway metric names the RED dashboard expects:

- `gateway_http_requests_total{code, method, route}` (counter)
- `gateway_http_request_duration_seconds` (histogram, same labels)

## Layout

```
docker-compose.yml            # the stack
alloy/config.alloy            # OTLP in → Loki (logs) + Prometheus (remote write)
loki/loki-config.yml          # single-binary, filesystem, 14 d retention
prometheus/prometheus.yml     # host scrape targets
grafana/provisioning/         # datasources + dashboard provider (as code)
grafana/dashboards/           # dashboard JSON (as code)
```

## Dashboards (provisioned — edit JSON, never the UI)

| Dashboard | What it answers |
|-----------|-----------------|
| Platform — Overview | is anything sick: per-service UP, RPS, 5xx ratio, p95, DLQ depth, consumer lag |
| Gateway — RED | edge traffic detail |
| Chatbot — Service & Worker | HTTP RED + worker jobs by outcome + job duration + combined logs |
| Event Store — Service & Streams | HTTP RED + ingest per stream + consumer lag + DLQ depth |
| File Service — RED | HTTP RED + logs |
| Notification Service — Pipeline & Channels | HTTP RED + events consumed + SSE connections + push/email by outcome |
| Accounts Service — RED & Directory | HTTP RED + user syncs by outcome (a failed sync is invisible until somebody is missing from directory search) |
| Messenger Service — RED & Projections | HTTP RED + messages/conversations + core-NATS fan-out, JetStream publishes and the call-history projection, each by outcome |
| Realtime Service — Sockets & Calls | open sockets, frames by type and direction, call setup by outcome, and the two lines that should stay flat: calls reaped and ICE failures |
| Infra — Postgres / Redis / NATS | USE-style resource health via exporters |
| Correlation Trace | paste a `correlation_id` → every log line across all services |

Doctrine: **RED** (rate/errors/duration) per service, **USE** for infra, one overview pane, logs pivot on `correlation_id`.

`realtime-service` gets an UP stat on the overview but no RPS/latency line: it is a
WebSocket service and has no HTTP request surface worth charting. Inventing one
would be a panel that is always empty.

⚠️ **Editing a dashboard file does not hot-reload.** A *new* file is picked up,
but a change to one Grafana has already imported was still serving the old
version after several poll intervals (2026-09-17) — `docker restart obs-grafana`
is what applies it. Check with
`curl -s localhost:3000/api/dashboards/uid/<uid> | jq '.dashboard.panels | length'`
rather than trusting the file on disk.

⚠️ **A PromQL expression naming a metric that does not exist evaluates fine and
returns nothing**, so "no error from Prometheus" proves only that the query
parses. Verify the *names* separately — against `/api/v1/label/__name__/values`,
and for a counter that has never been incremented (prom-client emits `# HELP`
and `# TYPE` but no sample line until the first `.inc()`, so it is absent from
Prometheus entirely) against the service's own registration.

## Status

| Item | Status |
|------|--------|
| Stack + all service instrumentation (gateway, event-store, file-service, chatbot-service, worker :8051, notification-service :3003) | shipped |
| Exporters + dashboard suite | shipped |
| OTel traces → Tempo (`trace_id` ↔ `correlation_id`) | deferred |
| Alert rules | deferred until a notification channel exists |
