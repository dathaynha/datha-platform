# Go — best practices

_Go best practices — error handling, project layout, logging, HTTP (any Go project)_

## Style

- **Go 1.22+**; prefer the standard library — add third-party deps deliberately.
- `gofmt` / `goimports` on every file; imports grouped as stdlib → external → internal.
- Use `any` instead of `interface{}` (Go 1.18+).
- Avoid `init()` — prefer explicit initialization in `main`.

## Error handling

- Return errors explicitly; never discard with `_` unless genuinely irrelevant (add a comment if so).
- Wrap with `fmt.Errorf("context: %w", err)`; inspect with `errors.Is` / `errors.As`.
- Fail fast on startup: call `os.Exit(1)` with a clear message when required config is missing.

## Project layout

- `cmd/<name>/main.go` — entry point only; wire deps and start the server, no logic.
- `internal/` — all business logic; not importable outside the module.
- Keep packages small and focused: one responsibility per package.

## HTTP

- Always set `Content-Type: application/json` before writing JSON responses.
- Use a shared error-writing helper for consistent error shape — never `fmt.Fprintf(w, ...)` for errors.
- Middleware order matters — apply global middleware before route-specific middleware.

## Logging

- Use **`log/slog`** (stdlib, Go 1.21+) with JSON handler to stdout.
- Never log secrets, tokens, or raw request/response bodies.
- **`slog.SetDefault` also captures the stdlib `log` package**, re-emitting it through the slog handler at **`INFO`**. So any library that still writes via `log.Print` appears as a well-formed JSON line at INFO with the raw error as `msg` — which reads like an app log and hides that it is an error.
- **Always install `otel.SetErrorHandler` when OTLP is enabled.** OTel's default handler is `log.Print`, so by the point above every failed export becomes an INFO line, once per attempt, forever. Worse, the default slog handler is the stdout+OTLP fanout, so each failure message is itself queued to the exporter that just failed. Found 2026-09-08: with the collector down, `realtime-service` had written **421** such lines and `api-gateway`'s log **14,912 (2.4 MB)** — the log was almost entirely this. Both now install a throttled handler (first failure at `WARN`, then one line a minute carrying a `suppressed` count, written to stdout only). Node services with the same env var set write zero, which is why the asymmetry went unnoticed.

## Never `os.Exit` with defers pending — use `run() error` (2026-09-08)

`main` that acquires resources must be a thin wrapper:

```go
func main() {
	if err := run(); err != nil {
		slog.Error("startup failed", "error", err)
		os.Exit(1)
	}
}
```

Every `defer` lives in `run`, which returns errors instead of exiting. `os.Exit` does not run deferred functions, so an `os.Exit` in `main` past a pending `defer` silently skips cleanup. `gocritic`'s `exitAfterDefer` catches it, and on `realtime-service` it was catching a real bug: a Redis or NATS failure at startup skipped the OTLP log flush, the Redis close and the NATS drain.

Related idioms the default linters enforce:

- **`defer func() { _ = resp.Body.Close() }()`**, not `defer resp.Body.Close()` — `errcheck` flags the discarded error.
- **`collectors.NewGoCollector()`**, not `prometheus.NewGoCollector()` — the latter is deprecated (`staticcheck` SA1019). It lives in `client_golang/prometheus/collectors`, already inside the module, so adding it needs only `go mod vendor` — no `go.mod` change.

## Run `golangci-lint run --no-config` before pushing a Go repo (2026-09-08)

Both Go repos are lint-clean under the full default set as of 2026-09-08 — keep them there. Two traps:

- **MegaLinter lints only the files a PR touches**, so pre-existing findings stay invisible until someone edits that file. `api-gateway` looked clean for months while carrying two `errcheck` findings in `internal/auth/`, because no PR had touched those files. A **new** repo's first PR touches everything, which is why `realtime-service`'s first run surfaced two findings at once.
- Neither Go repo has a `.golangci.yml`, so the effective config is the linter's defaults — and the container's version is not the local one. `--no-config` locally is the closest parity.

## Config and secrets

- Load all config from env; never hardcode values or commit `.env`.
- Local dev: use `github.com/joho/godotenv`; production relies on platform env vars.
