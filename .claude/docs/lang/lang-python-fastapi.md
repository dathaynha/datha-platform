# Python / FastAPI — best practices

_Python / FastAPI best practices — async, Pydantic v2, project layout (any FastAPI project)_

## Python style

- **Python 3.11+**; use built-in generic types (`list[str]`, `dict[str, int]`) — no `from __future__ import annotations` needed.
- Type-hint every public function parameter and return value; avoid `Any`.
- Format with **Ruff** (`ruff format`) and lint with `ruff check`.
- Never silence exceptions with bare `except: pass` — always log or re-raise.

## FastAPI

- Keep route functions thin; business logic goes in `services/`.
- Use **Pydantic v2** models in `schemas/` for all request and response bodies — never raw `dict`.
- Return a consistent error shape: `{"detail": "...", "code": "SNAKE_CASE_CODE"}`.
- `async def` for routes that await I/O; `def` only for CPU-bound helpers.
- Dependency injection via `Depends()` — do not import service instances at module level.
- `GET /health` must stay unauthenticated and return `{"status": "ok"}`.

## Async and concurrency

- Prefer `asyncio`-native libraries; do not mix blocking I/O inside `async def` routes.
- Use `asyncio.gather` for concurrent independent awaits; avoid nested `await` inside loops.

## Config and secrets

- Load all config from env via `pydantic-settings`; never hardcode values or commit `.env`.
- Validate required vars at startup and fail fast with a clear message.

## Testing

- Use `pytest` with `httpx.AsyncClient` for async route tests.
- Mock external calls — unit tests should not hit real services.
