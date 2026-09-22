# Critical behaviors (always apply)

One-line hard rules; full detail in the linked canonical `.claude/docs/` file.

1. **Never read or edit `.env` / `.env.*` in any backend service dir** — real secrets. Only `.env.example` (editable) and frontend `environment.*.ts` are safe. When env config changes, update `.env.example` and tell the user to mirror it. **Enforced, not just stated:** `settings.local.json` denies `Read`/`Edit`/`Write` on `**/.env`, and the bare name means `.env.example` is untouched. The deny covers the file tools only — `cat`/`grep` through Bash still reach it, so the rule still needs following. → `.claude/docs/always-apply/env-file-safety.md`
2. **Never touch `_local/`** — personal documents and legacy notes. Off limits unless the user names a specific file; the infra working files are the standing exception. Holds **no credentials** (scanned 2026-09-18), so it is backed up rather than excluded. → `.claude/docs/always-apply/context-boundaries.md`
3. **Never leave a dev server running** at end of turn. May start one temporarily to verify, must kill it. User manages all ports. Sole exception: explicit "run …" request via the `run-platform` skill — those stay up. → `.claude/docs/always-apply/no-running-ports.md`
4. **No routine unit test runs** after normal edits. Run suites only on prepare-push or explicit request. Writing tests is fine; auto-running is not. → `.claude/docs/always-apply/no-routine-unit-tests.md`
5. **Don't grep/bulk-read** `node_modules/`, `dist/`, `coverage/`, `vendor/`, `.venv/`, `.angular/`, `.git/` — several repos have these committed/present locally. → context-boundaries.md
6. **Commits/PRs scoped to one service repo** unless the user names more. No root pipeline, no root package.json, no "deploy the monorepo". → `.claude/docs/always-apply/workspace-layout.md`
7. **NATS topology belongs to `platform-nats/`** — other services connect only, never `streams.add`/`consumers.add` on startup. Durable names sync with each service's `src/nats/streams.ts`. → `.claude/docs/platform/platform-nats-architecture.md`
8. **Don't scaffold deferred services** (analytics-service, search-service, translation pipeline, interview-prep repos) until explicitly asked — they are documented ahead of build.
10. **A scripted edit must stay prettier-clean** — `PostToolUse` runs `.claude/hooks/prettier-check.sh` after every Edit/Write, checking `.ts`/`.json` against the repo's own prettier. No test suite can see formatting, and MegaLinter fails the PR for it; that gap cost two PRs. `.scss`/`.html` are not checked, because `.mega-linter.yml` does not lint them either.

9. **No AI attribution in git** — **enforced** by a `PreToolUse(Bash)` hook that rejects the trailers outright, and also blocks a commit with a real `.env` or an `env-backup/` directory staged anywhere in the workspace. Before it existed the rule was hand-checked after eight commits in a single session, against a system reminder that actively asks for those lines.
