# notification-service

In-app notifications as a **projection of platform events**. Consumes JetStream (`EVENTS` + `DLQ` streams) through durables owned by `platform-nats/`, maps a config-driven subset of events to per-owner notifications (i18n keys + params — never rendered strings), and serves them over REST via api-gateway. Services never call a "send notification" API.

```
services ──publish──▶ JetStream ──durables──▶ notification-service ──▶ Postgres
                                                     │
shell bell ◀── REST (list/unread-count/read) ── api-gateway ◀─┘
```

## Run

```bash
pnpm install
cp .env.example .env        # fill DATABASE_URL etc.
pnpm build && pnpm migrate  # apply SQL migrations
pnpm dev                    # :3003
```

Requires local Postgres + NATS (JetStream reconciled via `platform-nats: pnpm reconcile` — durables `notification-service-events`, `notification-service-dlq`).

## API (via api-gateway `/api/notifications/*`, JWT → `X-Owner-ID`)

| Route | Purpose |
|-------|---------|
| `GET /notifications?unread=true&limit=20&before=<iso>` | List (cursor = `createdAt` of last row) |
| `GET /notifications/unread-count` | Badge count |
| `POST /notifications/:id/read` / `:id/unread` | Toggle one read state (204) |
| `POST /notifications/read-all` | Mark all read |
| `GET /health`, `GET /metrics` | Ops |

## Projection rules

- Mapping table: `src/services/mapping.ts` — envelope `type` → notification type + severity (info|warning|critical) + i18n keys + param picks; `source_service` comes from the envelope. Unmapped types and events without `owner_id` are acked and ignored.
- Idempotent: unique `source_key` (envelope id / `dlq:<seq>`), `ON CONFLICT DO NOTHING` — JetStream redelivery is a no-op.
- EVENTS projection failure after max_deliver → enriched record to `events.dlq.notification_service.projection`, then ack. The DLQ consumer never DLQ-publishes (loop guard) and skips its own sink.
- Read notifications are purged after `NOTIFICATIONS_READ_RETENTION_DAYS` (in-app sweep, 12 h interval).

## Observability

Prometheus `/metrics`: `notification_service_http_*` RED + `notification_service_events_consumed_total{stream,outcome}` (outcomes: projected | ignored | invalid | dlq | dropped). Logs: JSON stdout, OTLP push when `OTEL_EXPORTER_OTLP_ENDPOINT` set; `correlation_id` carried from envelopes and request headers.

## Tests

```bash
pnpm exec vitest run
```
