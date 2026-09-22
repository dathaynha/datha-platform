# platform-nats

JetStream **topology + reconcile** for the platform (`EVENTS`, `DLQ`, shared durables).

**Architecture and ops:** `.claude/docs/platform/platform-nats-architecture.md` (source of truth — not `docs/` in this repo).

## Quick start

```bash
cp .env.example .env   # optional
pnpm install
pnpm reconcile
```

Requires a local NATS server with JetStream (`NATS_URL`, e.g. `nats://localhost:4222`).

**ADO:** `azure-pipelines/jetstream-reconcile.yml`

**Topology PRs:** `TOPOLOGY_PR_CHECKLIST.md` (cross-repo sync with `file-service` / `event-store` `src/nats/streams.ts`).
