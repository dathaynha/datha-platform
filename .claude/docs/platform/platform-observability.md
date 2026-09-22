# Platform observability

_Observability — Grafana/Loki/Prometheus/Alloy stack (shipped), logging + metrics conventions, correlation-id contract_

Decided 2026-07-29; stack repo shipped same day (PR 47). Operational observability for the platform: logs, metrics, dashboards, later traces. **Distinct from** the JetStream event log (curated business facts, `platform/event-store-architecture.md`) and from the deferred product analytics-service. The two worlds link via `correlation_id`.

## Stack (Grafana OSS, self-hosted in colima Docker)

| Piece | Role | Notes |
|-------|------|-------|
| **Grafana** | dashboards, alerting | provisioned as code, never click-configured |
| **Loki** | log store | label-indexed, short retention (7–14 d) |
| **Prometheus** | metrics store | scrapes host service ports + exporters |
| **Alloy** | collector | receives OTLP push from host services → Loki/Prom |
| Tempo | traces | phase 3 only |
| Exporters | NATS (JetStream lag, DLQ depth), Postgres, Redis | phase 2 |

**Push over scrape for logs:** services run on the host (pnpm dev / uvicorn / go run) while the stack runs in colima — file scraping across that boundary is brittle. Services push OTLP to Alloy; identical in dev and any future prod.

## Repo: `platform-observability/` (own ADO repo, like platform-nats owns topology) — SHIPPED (PR 47, 2026-07-29)

```
platform-observability/
  docker-compose.yml          # grafana 12.4.3 :3000, loki 3.7.4 :3100, prometheus v3.13.1 :9090, alloy v1.18.0 :4317/:4318 + UI :12345
  grafana/provisioning/       # datasources (Prom default + Loki, non-editable) + dashboard provider
  grafana/dashboards/         # dashboard JSON as code (gateway-red.json shipped)
  alloy/config.alloy          # OTLP in → batch → loki.write + prometheus.remote_write
  loki/loki-config.yml        # single-binary, filesystem, 14 d retention
  prometheus/prometheus.yml   # host scrape targets via host.docker.internal (gateway/event-store/file-service/chatbot pre-declared)
  README.md                   # run + service contract (canonical for instrumenting services)
```

Owns the whole stack + every dashboard. A dashboard that exists only in the Grafana UI is unversioned state — export to `grafana/dashboards/` or it doesn't exist. Grafana runs anonymous-admin (local-only). Run: `docker compose up -d` / `down` — user manages when it's up, same as infra.

**Learned in smoke test:** OTLP resource attr `service.name` becomes Loki label `service_name` (not `service`) — LogQL queries filter `{service_name="..."}`. Prometheus needs `--web.enable-remote-write-receiver` for Alloy's metric push path.

## Logging conventions (all services)

1. **Structured JSON to stdout**, one event per line. No printf debugging left behind.
2. Mandatory fields: `timestamp`, `level`, `service`, `msg`, `correlation_id` (when in a request/event context).
3. **`correlation_id` contract — the money feature:** the same id that rides the event envelope (`platform/event-store-architecture.md`) appears in every operational log line touched by that request/event. Gateway generates it at the edge (or adopts the inbound one), propagates via header; services echo it into logs and envelopes. Grafana then pivots from a business event to every log line across gateway → service → worker.
4. Per-stack idiom (all shipped 2026-07-30, branch `feat/observability-instrumentation` in each repo):
   - **api-gateway**: slog fanout handler (`internal/logging/`) = stdout JSON + otelslog→OTLP; RED middleware (`internal/middleware/metrics.go`) with chi route *pattern* label; `/metrics` skipped in request logs (scrape noise).
   - **Fastify ×2**: `genReqId` adopts `X-Correlation-ID` + `requestIdLogLabel: 'correlation_id'`; `src/lib/logger.ts` pino transport targets (`pino/file` stdout + `pino-opentelemetry-transport`); `src/plugins/metrics.ts` prom-client RED (`event_store_*` / `file_service_*`), route = `request.routeOptions.url`.
   - **chatbot-service + worker**: `app/core/logging.py` — structlog `ProcessorFormatter` renders stdlib records as JSON (no call-site conversion), correlation contextvar + logging.Filter feeds both stdout and OTel `LoggingHandler`; uvicorn handlers stripped (access log muted — own middleware logs requests); `prometheus-fastapi-instrumentator` with `metric_namespace="chatbot_service"`; worker = distinct `service.name` **chatbot-worker**, binds correlation_id from job payload.
   - Gate everywhere: `OTEL_EXPORTER_OTLP_ENDPOINT` unset → stdout-only, no OTLP (documented in each `.env.example`).
   - **LogQL pivot**: `{service_name=~".+"} | json | attributes_correlation_id="<id>"` — OTLP puts fields under `attributes`, resource attr `service.name` becomes label `service_name`.
5. **Never publish operational logs into JetStream.** Event streams stay curated; the firehose goes to Loki.

## Metrics conventions

- Every service exposes Prometheus `/metrics` on its own port: gateway `promhttp`, Fastify `prom-client` default + route histograms, FastAPI `prometheus-fastapi-instrumentator`, worker = job counters/durations.
- RED per service (rate, errors, duration) + domain metrics: Gemini job duration + token usage, upload sizes, ingest lag.

## Dashboards (phase-1 set, provisioned)

1. **Gateway** — RPS, p50/p95/p99, 4xx/5xx, auth failures
2. **Chatbot** — message jobs/min, job duration, Gemini tokens, SSE streams open
3. **Events** — events/min per stream (straight from event-store Postgres datasource), consumer lag + DLQ depth (NATS exporter, phase 2)
4. **Infra** — Postgres/Redis/NATS health (exporters, phase 2)

## Phasing

| Phase | Content | Exit criteria |
|-------|---------|---------------|
| **1 ✅** (2026-07-30, verified live) | repo + compose ✅ PR 47; instrumentation shipped for ALL services (gateway + event-store + file-service + chatbot-service + worker — exceeded the "one Node service" plan) | met: gateway RED panel live + one LogQL query by correlation_id spanning 3 services |
| **2 ✅** (2026-07-30, PRs 48–52 merged) | exporters (NATS/PG/Redis, postgres DSN via gitignored repo `.env`); instrumentation on ALL services incl. worker `/metrics` :8051; 7 dashboards as code (Overview, per-service RED, Infra USE, Correlation Trace) | met: DLQ depth + consumer lag charted; all 10 prom targets up |
| **2.1 ✅** (2026-08-04, PR 77 merged) | `notification-red.json` — notification-service RED + pipeline (events consumed by stream/outcome, SSE gauge) + channels (push/email sends by outcome; labeled counters appear after first inc since boot). Failure outcomes here are the de-facto SMTP/push-service health signal — Mailpit itself has no /metrics | dashboard provisioned, target up, SSE gauge live |
| **3** | OTel traces → Tempo; trace_id ↔ correlation_id link; Grafana alert rules (needs notification channel — after notification-service) | click event → trace → logs |

## Hard rules

- Stack containers live beside the existing infra compose (user manages `_local/` compose; this repo has its OWN compose — never merged into `_local/`).
- No Grafana Cloud / SaaS — self-hosted only (colima).
- Dashboards/datasources as code; UI-only artifacts are throwaway.

## Related rules

- `platform/platform-nats-architecture.md` — JetStream topology (event log ≠ operational log)
- `platform/event-store-architecture.md` — envelope `correlation_id` (source of the linking id)
- `platform/platform-backlog.md` — scheduling
