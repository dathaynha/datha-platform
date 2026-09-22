# Platform notifications

_In-app notifications — notification-service (JetStream consumer, :3003) + shell bell; phase 1 built 2026-07-30, phase 2 (SSE live push + toast) 2026-08-03, phase 3 (preferences + Web Push + email digest) 2026-08-04_

Decided 2026-07-29; **phase 1 shipped 2026-07-30** — PRs 53 (notification-service, new repo), 54 (platform-nats durables), 57 (api-gateway proxy), 60 (observability target), 61 (shell drawer), all merged. Same wave: stream watchdog PRs 58/59, NATS reconnect-forever PRs 55/56/57/58. **Phase 2 shipped 2026-08-03** — PRs 62 (notification-service SSE), 63 (api-gateway stream routes + flush fix), 64+65 (shell SSE/toast + push dedupe fix), all merged; includes the gateway SSE flush fix (see design rules in `services/api-gateway-architecture.md`). In-app notifications derived from platform events: a consumer service turns JetStream events into per-owner notifications; the shell renders a toolbar bell. Ops alerting (Slack/email on error rates, DLQ depth) is NOT this — that's Grafana alert rules, `platform/platform-observability.md`.

## Architecture — event-driven, no new "send notification" APIs

Notifications are a **projection of events that already exist**. Services never call a notify endpoint — they keep publishing domain events; the notification pipeline decides what becomes user-facing. One source of truth, zero coupling.

```
services ──publish──▶ JetStream ──durable consumer──▶ notification-service ──▶ Postgres
                                                            │
shell bell ◀──SSE (live) + REST (list/read)── api-gateway ◀─┘
```

## `notification-service/` (own repo, port 3003) — BUILT

- **Node TS + Fastify 5 + pg** — event-store twin (`lang/lang-typescript-fastify.md`); auth = gateway-injected `X-Owner-ID` (file-service pattern).
- **Ingest — two pull durables** (owned by `platform-nats/`, per critical-behaviors #7):
  - `notification-service-events` on `EVENTS`, **no filter_subject** — mapping is service-side config (`src/services/mapping.ts`), so new mapped events need no topology PR. Unmapped types / null `owner_id` → ack + ignore.
  - `notification-service-dlq` on `DLQ` — dead-lettered work becomes `dlq.arrival` ops notifications. **Loop guards:** skips its own sink `events.dlq.notification_service.projection`; on failure drops (ack) after max_deliver, never DLQ-publishes.
- **Consumer conventions (canonical for future event consumers):** idempotent projection via unique `source_key` (envelope id / `dlq:<stream seq>`) + `ON CONFLICT DO NOTHING`; envelope parser tolerates unknown fields; EVENTS projection failure after `NATS_CONSUMER_MAX_DELIVER_NOTIFICATION_SERVICE_EVENTS` → enriched DLQ publish, then ack.
- **Persistence (Postgres `notification_service_db`):** `notifications(id, source_key, owner_id, type, severity, source_service, title_key, body_key, params jsonb, link, correlation_id, read_at, created_at)` — `link` = optional in-app route the shell navigates to on card click (e.g. `dlq.arrival` → `/event-store/dlq`) — **i18n keys + params, never rendered strings**, so the bell respects live language switching. `severity` = info|warning|critical (from the mapping); `source_service` = envelope `service`. Index `(owner_id, read_at, created_at DESC)`.
- **API (via api-gateway `/api/notifications/*`, strips `/api`):** `GET /notifications?unread&limit&before` (cursor = last `createdAt`), `GET /notifications/unread-count`, `POST /notifications/:id/read` + `:id/unread` (204), `POST /notifications/read-all`.
- **SSE live push (phase 2):** `GET /notifications/stream` — consumers publish each inserted row into an in-memory per-owner fanout (`src/plugins/stream.ts`); 25 s keepalive comments; connections ended on shutdown. **Single-instance assumption** — multi-instance deploys need a NATS core pub/sub fanout instead. Auth: gateway mints a scoped stream token at `GET /api/notifications/stream-token` (JWT-protected, `jti="notifications"`), public `GET /api/notifications/stream?stream_token=` verifies it and injects `X-Owner-ID` (chatbot SSE pattern — EventSource cannot send headers). Conflict inserts (redeliveries) are never re-pushed.
- **Retention:** read notifications purged after `NOTIFICATIONS_READ_RETENTION_DAYS` (30 d) — in-app sweep every 12 h, no pg_cron.
- **Observability:** `notification_service_http_*` RED + `notification_service_events_consumed_total{stream,outcome}` (projected|ignored|invalid|dlq|dropped); OTLP logs gated on `OTEL_EXPORTER_OTLP_ENDPOINT`; Prometheus target :3003 in platform-observability.

**v1 mapping:** `file.deleted` → `file.cleanup` (`NOTIFICATIONS.FILE_CLEANUP.*`); DLQ arrival → `dlq.arrival` (`NOTIFICATIONS.DLQ_ARRIVAL.*`); **`messenger.call.missed` → `call.missed` (`NOTIFICATIONS.CALL_MISSED.*`, added 2026-09-09)**. `message.sent`/`file.uploaded` deliberately unmapped (synchronous own actions, noisy), and `messenger.call.started`/`.ended` likewise — they are history rows, while ringing itself rides the socket for sub-second delivery.

**`owner_id` decides whose bell rings, so an event's owner must be the person it is *about*.** `messenger.call.missed` is published by realtime-service with `owner_id` set to the **callee**, unlike `.started`/`.ended` which attribute to the caller. Attributing a missed call to the caller would have told them they missed their own call — a mapping cannot fix that, because the mapper only produces content, never the recipient.

## Shell UI (shell owns chrome) — BUILT

`shell-notification-bell` (`modules/shared/notification-bell/`) in the toolbar before the profile trigger: pi-bell trigger + unread badge opens a **right-hand `p-drawer`** (inspired by `_local/host-frontend` viessmann-sidebar-notification, 2026-07-30). Drawer: header count + "Mark all read", unread-only `p-toggleswitch` filter, severity-accented cards (left border + chip: info=primary, warning=amber, critical=red), `source_service` tag + date, card click marks read, per-card read/unread toggle button, "Show more" cursor pagination (page size 20). `NotificationsService` connects SSE with bell lifecycle (mint token → EventSource; pushed rows bump the badge + prepend to the list; reconnect with 1–30 s backoff and a fresh token; unread-count resync on every open; all HTTP calls use `SKIP_GLOBAL_ERROR_DIALOG`). Pushed notifications also raise a **toast** (`p-toast` in the bell, `translate.instant(key, params)`, severity info/warn/error, 5 s, suppressed while the drawer is open; deliberately no toast navigation — the drawer card owns the `link`). i18n rendered client-side: `{{ titleKey | translate: params }}` — content keys live in shell `assets/i18n/*.json` under `NOTIFICATIONS.*`. **Notifications are shell-only chrome — decided 2026-08-03, no lib extraction.** Standalone remotes (:4001/:4002) deliberately have no noti UI: notifications are cross-service per owner, so a per-product standalone bell would show a misleading subset; the aggregated view only makes sense in the host. Standalone mode stays a dev convenience.

## Phases

| Phase | Content | Exit criteria |
|-------|---------|---------------|
| **1 ✅** (2026-07-30, PRs 53/54/57/60/61 merged) | repo + consumers + mapping + Postgres + REST; shell drawer with 30 s polling | met live: real conversation delete → file cleanup → 5 projected notifications in drawer; owner isolation + 401 guard verified |
| **2 ✅** (2026-08-03, PRs 62/63/64/65 merged) | SSE live push via gateway (polling dropped) + toast | met live: conversation delete → badge + toast + drawer card, no refresh |
| **3 ✅** (2026-08-04, waves 0/1/2 all merged — PRs 66-69, 72-75) | Preferences + Web Push + email digest | met live: OS notification with shell tab closed; daily digest landed in Mailpit |

## Phase 3 plan (decided 2026-08-03 — waves in order, each its own PR pair)

Decisions locked with dathq: push default = **all severities**; email transport local = **Mailpit in `_local` infra** (SMTP vars in `.env.example` only); digest = **daily**; prod email provider deferred to the prod/domain story (env-only swap via nodemailer/SMTP abstraction — never self-host delivery).

**Wave 0 ✅ shipped 2026-08-03** — PRs 67 (notification-service prefs), 68 (gateway CORS PUT), 69 (shell settings hub + prefs page), all merged; lib v0.4.0 (PR 66, profile-popover menu items) released and consumed by shell. Waves 1–2 remain on ask.

**Wave 0 — preferences (prereq for both pillars).** `notification_preferences(owner_id, locale, push_enabled, push_min_severity, email_digest, updated_at)` + `GET/PUT /notifications/preferences`. In-app channel never gated (drawer = system of record); prefs gate push + email only. `locale` synced by shell on language switch — DB content stays i18n keys, push/email payloads are **rendered at send time** with prefs locale (documented exception). Shell: new routed feature `modules/settings/` → `/settings/notifications` page (shell-owned chrome, not a remote); gear entry in drawer header.

**Wave 1 — Web Push ✅ shipped 2026-08-04 — PRs 72 (notification-service) + 73 (shell), merged; verified live (OS notification on macOS, real conversation delete, tab unfocused).** Bot-review hardening included: SW key-resolution guards, `Notification` in the feature check, server-first unsubscribe ordering. VAPID keypair (public in shell `environment*.ts`, private in service `.env`; unset = push disabled with a boot warn). Shell: hand-rolled `src/sw.js` served at `/sw.js` (no `@angular/service-worker` — ngsw fights MF webpack), registered from bootstrap; permission requested only from the settings toggle (subscription first, preference persisted only on grant; denial shows PUSH_BLOCKED and snaps the toggle back). Service: `push_subscriptions(owner_id, endpoint UNIQUE upsert, p256dh, auth, user_agent, last_seen_at)` (multi-device), POST/DELETE `/notifications/push-subscriptions`; send via `web-push` after insert + SSE broadcast — fire-and-forget (never naks the JetStream msg), 404/410 prunes the subscription. **Payload carries i18n keys + params + prefs locale — the SW fetches `/assets/i18n/<locale>.json` (network-first, Cache API fallback) and renders itself (decided 2026-08-03, replaces the earlier server-rendered idea: notification copy has exactly one home, shell)**. SW suppresses the OS noti when a shell tab is focused (SSE toast covers it); `notificationclick` focuses-or-opens at `link`. Metric `notification_service_push_sent_total{outcome=sent|pruned|failed}`. Toggle UX reports per-reason (`denied` → unblock-in-site-settings, `dismissed` → retry, `unsupported`, `error` → console) — a browser-blocked site never re-prompts, so `Notification.permission` is checked before requesting. Severity select is `appendTo="body"` (glass card's backdrop-filter stacking context traps in-place overlays — recurring platform gotcha). macOS caveat: the browser app itself must be allowed in System Settings → Notifications. **Channel strategy (locked 2026-08-03): desktop+Android browser = Web Push; phones = future native app via APNs/FCM (see backlog "Native mobile app" — NO PWA/iOS-web-push effort); away = email digest (wave 2).** The pipeline is channel-agnostic: senders hang off the same insert→prefs-gate path, a native app later just adds an FCM sender.

**Wave 2 — email digest ✅ shipped 2026-08-04 — PRs 74 (shell) + 75 (notification-service) merged; verified live (digest landed in Mailpit, singular subject, brand template).** Bonus fixes in PR 74: sidebar tooltips, glass select overlay transparent-flash fix (never animate opacity on glass overlays — backdrop-filter dies), severity option a11y labels. nodemailer + SMTP env config — transport is env-only, three interchangeable targets: **Mailpit** (`_local` infra, default — catches all mail, web inbox :8025, nothing leaves the machine), **Gmail SMTP + app password** (real-delivery test from local, ~500/day cap), **managed provider** (prod later, needs domain + SPF/DKIM — never self-host delivery, reputation is unwinnable). Hourly sweep plugin (retention twin): owners with digest on + ≥24 h since `digest_state.last_sent_at` + unread since then → one templated email (severity counts, top N, shell link), i18n-rendered with prefs locale. Empty digests never sent; digest only, never per-event (instant-critical email = future option, not built). Metric `emails_sent_total{outcome}`.

No platform-nats PR (post-projection, in-process) and no api-gateway PR (`/api/notifications/*` proxy covers new routes). Repos: notification-service + shell-frontend.

## Hard rules

- Stream/consumer changes go through `platform-nats/` — this service only connects.
- Notification content = i18n keys + params; rendered strings never stored.
- `correlation_id` carried through (observability linking — `platform/platform-observability.md`).

## Related rules

- `platform/platform-nats-architecture.md` — topology ownership, durable naming
- `platform/event-store-architecture.md` — envelope shape (`owner_id`, `correlation_id`)
- `platform/platform-observability.md` — ops alerting lives there, not here
