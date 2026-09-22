# TypeScript / Fastify — best practices

_TypeScript / Fastify best practices — strict TS, plugins, schema validation (any Fastify project)_

## TypeScript style

- **Strict mode** (`"strict": true`); no `any` in public APIs — use `unknown` and narrow.
- Prefer `interface` for object shapes, `type` for unions and aliases.
- Use `async/await`; avoid raw Promise chains.
- Never swallow errors silently — always log with context before re-throwing or returning an error response.
- Always handle rejected Promises — unhandled rejections crash the process.

## Fastify

- Register shared capabilities (DB, external clients) as **plugins** using `fastify-plugin`.
- Define **JSON Schema** on every route for request validation and response serialization.
- Keep route handlers thin — business logic goes in `src/services/`.
- Use `fastify.setErrorHandler` for global error shaping; never leak internal messages to clients.
- `GET /health` must stay unauthenticated and return `{"status":"ok"}`.

## Postgres timestamps

- **Never round-trip a `timestamptz` through a JS `Date` and write it back.** `timestamptz` keeps microseconds, `Date` keeps milliseconds, so the value returns truncated — up to 999 µs *older* than the row it came from. Derive the value inside the statement (`SET x = GREATEST(x, m.created_at)`) instead of reading it in one query and passing it to the next.
- Found the hard way on 2026-09-08 in `messenger-service`: a read watermark written back from a `Date` landed at `.289` against a message at `.289209`, so `last_message > last_read` stayed true and the unread badge never cleared. Unit tests missed it entirely — they faked the pool, and the truncation only exists in the driver.

## Async and concurrency

- Use `Promise.all` for concurrent independent async operations.
- Avoid `await` inside loops — batch with `Promise.all` where possible.

## Config and secrets

- Load all config from env in a `src/config.ts` module; validate required vars at startup and exit with code 1 if missing.
- Never hardcode values or commit `.env`.

## Logging

- Use **`pino`** (Fastify's built-in logger); JSON to stdout.
- Never log secrets, tokens, or sensitive payload contents.
