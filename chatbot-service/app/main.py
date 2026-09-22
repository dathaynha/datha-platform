import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from prometheus_fastapi_instrumentator import Instrumentator
from redis import asyncio as aioredis

from app.core.config import get_settings
from app.core.logging import configure_logging, correlation_id_var
from app.db.session import engine
from app.routers import conversations, google_token, messages, models
from app.services.event_outbox import outbox_drain_loop
from app.services.nats_lifecycle import connect_nats_optional

configure_logging("chatbot-service")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.redis = aioredis.from_url(
        settings.redis_url,
        decode_responses=True,
    )
    nc, js = await connect_nats_optional(settings.nats_url)
    app.state.nats = nc
    app.state.js = js

    stop_outbox = asyncio.Event()
    outbox_task = asyncio.create_task(
        outbox_drain_loop(
            js_getter=lambda: app.state.js,
            poll_interval_seconds=settings.event_outbox_poll_seconds,
            batch_size=settings.event_outbox_batch_size,
            max_backoff_seconds=settings.event_outbox_max_backoff_seconds,
            stop_event=stop_outbox,
        )
    )

    try:
        yield
    finally:
        stop_outbox.set()
        outbox_task.cancel()
        with suppress(asyncio.CancelledError):
            await outbox_task
        await app.state.redis.aclose()
        if nc is not None:
            await nc.drain()
        await engine.dispose()


app = FastAPI(title="chatbot-service", version="0.1.0", lifespan=lifespan)

Instrumentator(excluded_handlers=["/metrics", "/health"]).instrument(
    app, metric_namespace="chatbot_service"
).expose(app, include_in_schema=False)


@app.middleware("http")
async def correlation_and_request_log(request: Request, call_next):
    # Adopt the gateway's correlation id so one id spans gateway + service logs.
    cid = request.headers.get("x-correlation-id") or str(uuid.uuid4())
    token = correlation_id_var.set(cid)
    start = time.perf_counter()
    try:
        response = await call_next(request)
        if request.url.path not in ("/metrics", "/health"):
            logger.info(
                "request",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "duration_ms": round((time.perf_counter() - start) * 1000),
                },
            )
    finally:
        correlation_id_var.reset(token)

    response.headers["X-Correlation-ID"] = cid
    return response


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(google_token.router, prefix="/api/v1")
app.include_router(models.router, prefix="/api/v1")
app.include_router(messages.router, prefix="/api/v1")
app.include_router(conversations.router, prefix="/api/v1")
