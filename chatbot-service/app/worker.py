"""Consume `chatbot:jobs` (Redis list), stream Gemini, publish chunks, persist assistant message."""

from __future__ import annotations

import json
import logging
import os
import random
import time
import uuid
from dataclasses import dataclass

import httpx
import redis
from prometheus_client import Counter, Histogram, start_http_server
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings, redis_job_meta_key, redis_stream_key
from app.core.logging import configure_logging, correlation_id_var
from app.models.conversation import Conversation
from app.models.event_outbox import EventOutbox  # noqa: F401 — register ORM
from app.models.message import Message  # noqa: F401 — register ORM
from app.services.conversation_title_ai import try_sidebar_title_with_fallback_models
from app.services.events import enqueue_message_sent_sync
from app.services.file_client import build_inline_data
from app.services.gemini_stream import (
    delta_from_chunks,
    iter_sse_json_lines,
    stream_generate_url,
)
from app.services.generation_errors import (
    NormalizedGenerationError,
    normalize_gemini_http_error,
    normalize_simple,
    provider_retry_delay,
)
from app.utils.conversation_title import sidebar_title_from_user_text

logger = logging.getLogger(__name__)

JOBS_TOTAL = Counter(
    "chatbot_worker_jobs_total",
    "Jobs consumed from chatbot:jobs by outcome.",
    # retried counts one extra provider attempt; retry_exhausted counts a job that
    # still failed after retrying (it also counts as generation_failed).
    [
        "status"
    ],  # processed | generation_failed | unhandled_error | retried | retry_exhausted
)
JOB_DURATION = Histogram(
    "chatbot_worker_job_duration_seconds",
    "Wall time to process one job (Gemini stream included).",
)


def _build_gemini_contents(
    messages: list[Message],
    *,
    user_message_id: uuid.UUID,
    file_parts: list[dict],
) -> list[dict]:
    """Build the `contents` list for Gemini streamGenerateContent.

    For the current user message (identified by user_message_id), file parts are
    prepended before the text part so Gemini receives them as a multimodal turn.
    Historical messages are sent as plain text — re-fetching bytes for every prior
    turn on each request would be expensive and is not needed for most use cases.
    """
    out: list[dict] = []
    for m in messages:
        if m.role == "user":
            role = "user"
        elif m.role == "assistant":
            role = "model"
        else:
            continue

        parts: list[dict] = []
        if m.role == "user" and m.id == user_message_id and file_parts:
            # Gemini REST JSON uses snake_case: inline_data.mime_type (see AI Studio REST docs).
            parts.extend(
                {"inline_data": {"mime_type": fp["mime_type"], "data": fp["data"]}}
                for fp in file_parts
            )
        parts.append({"text": m.content})

        out.append({"role": role, "parts": parts})
    return out


def _xadd(r: redis.Redis, stream_key: str, payload: dict, ttl: int) -> None:
    """Append a chunk to the Redis Stream and (re)set its TTL.

    maxlen=1000 keeps memory bounded; approximate trimming ('~') is faster.
    TTL is set after every entry so the key expires even if the worker crashes
    before publishing the done event.
    """
    r.xadd(stream_key, {"data": json.dumps(payload)}, maxlen=1000, approximate=True)
    r.expire(stream_key, ttl)


def _persist_failed_assistant(
    SessionLocal: sessionmaker,
    conversation_id: uuid.UUID,
    err: NormalizedGenerationError,
) -> uuid.UUID:
    """Persist an assistant row that represents a failed generation (for history / ops)."""
    with SessionLocal() as session:
        row = Message(
            conversation_id=conversation_id,
            role="assistant",
            content=err.summary,
            generation_error_code=err.code,
            generation_error_summary=err.summary,
            generation_error_detail=err.detail,
        )
        session.add(row)
        session.commit()
        return row.id


def _emit_generation_failure(
    *,
    r: redis.Redis,
    stream_key: str,
    job_key: str,
    ttl: int,
    SessionLocal: sessionmaker,
    conversation_id: uuid.UUID,
    normalized: NormalizedGenerationError,
    raw_sse_body: str | None = None,
    legacy_detail: str | None = None,
) -> None:
    JOBS_TOTAL.labels(status="generation_failed").inc()
    assistant_id: uuid.UUID | None = None
    try:
        assistant_id = _persist_failed_assistant(
            SessionLocal, conversation_id, normalized
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "could not persist generation failure row stream=%s", stream_key
        )

    r.hset(job_key, "status", "failed")
    if assistant_id is not None:
        r.hset(job_key, "assistant_message_id", str(assistant_id))

    payload: dict[str, object] = {
        "type": "error",
        "detail": legacy_detail or normalized.summary,
        "error_code": normalized.code,
        "error_summary": normalized.summary,
        "error_detail": normalized.detail,
    }
    if assistant_id is not None:
        payload["assistant_message_id"] = str(assistant_id)
    if raw_sse_body is not None:
        payload["body"] = raw_sse_body[:2000]

    _xadd(r, stream_key, payload, ttl)


@dataclass(frozen=True)
class _AttemptFailure:
    """One failed Gemini attempt, in the shape `_emit_generation_failure` needs."""

    normalized: NormalizedGenerationError
    legacy_detail: str
    raw_sse_body: str | None = None
    retry_after: float | None = None


def _retryable_transport_error(exc: BaseException) -> bool:
    """Connect/read/timeout/protocol failures may succeed on a second attempt.

    httpx.TransportError covers TimeoutException, NetworkError and ProtocolError.
    Anything else (a bug in our own chunk handling, a JSON error) is not retried.
    """
    return isinstance(exc, httpx.TransportError)


def _attempt_generation(
    *,
    url: str,
    api_key: str,
    contents: list[dict],
    r: redis.Redis,
    stream_key: str,
    ttl: int,
    full_text: list[str],
) -> _AttemptFailure | None:
    """Run one Gemini stream, publishing deltas as they arrive.

    Returns None on success. Deltas are appended to `full_text`, so the caller can
    see whether anything was already published before deciding to retry.
    """
    try:
        with httpx.Client(timeout=180.0) as client:
            with client.stream(
                "POST",
                url,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": api_key,
                },
                json={"contents": contents},
            ) as resp:
                if resp.status_code != 200:
                    body = resp.read().decode("utf-8", errors="replace")[:2000]
                    return _AttemptFailure(
                        normalized=normalize_gemini_http_error(resp.status_code, body),
                        legacy_detail=f"Gemini HTTP {resp.status_code}",
                        raw_sse_body=body,
                        retry_after=provider_retry_delay(
                            resp.headers.get("retry-after"), body
                        ),
                    )

                chunk_iter = iter_sse_json_lines(resp.iter_lines())
                for delta, _cum in delta_from_chunks(chunk_iter):
                    full_text.append(delta)
                    _xadd(r, stream_key, {"type": "chunk", "text": delta}, ttl)
    except Exception as exc:  # noqa: BLE001
        logger.exception("gemini attempt failed")
        return _AttemptFailure(
            normalized=normalize_simple(
                "worker_exception",
                "Something went wrong while contacting the AI service. Please try again.",
                detail=str(exc),
                retryable=_retryable_transport_error(exc),
            ),
            legacy_detail=str(exc),
        )
    return None


def _retry_wait_seconds(attempt: int, retry_after: float | None, settings) -> float:
    """Provider-requested delay when there is one, else full-jitter exponential backoff.

    Both are capped: a wait longer than the frontend's first-event watchdog reads as a
    hang, and the client would give up before the retry could land.
    """
    cap = settings.generation_retry_max_delay_seconds
    if retry_after is not None:
        return min(max(retry_after, 0.0), cap)
    window = min(
        settings.generation_retry_base_delay_seconds * (2 ** (attempt - 1)), cap
    )
    return random.uniform(window / 2, window)


def process_one_job(
    raw: str,
    *,
    settings,
    r: redis.Redis,
    SessionLocal: sessionmaker,
) -> None:
    payload = json.loads(raw)
    job_id = payload["job_id"]
    stream_key = redis_stream_key(job_id)
    job_key = redis_job_meta_key(job_id)
    ttl = settings.job_meta_ttl_seconds

    conversation_id = uuid.UUID(payload["conversation_id"])

    api_key = (settings.gemini_api_key or "").strip()
    if not api_key:
        _emit_generation_failure(
            r=r,
            stream_key=stream_key,
            job_key=job_key,
            ttl=ttl,
            SessionLocal=SessionLocal,
            conversation_id=conversation_id,
            normalized=normalize_simple(
                "service_unconfigured",
                "Chat is not fully configured. Please try again later.",
            ),
            legacy_detail="GEMINI_API_KEY is not configured",
        )
        return

    user_message_id = uuid.UUID(payload["user_message_id"])
    model = payload["model"]
    owner_id = payload.get("owner_id", "")
    correlation_id = payload.get("correlation_id", job_id)
    # Single-threaded worker: next job overwrites; job logs carry the request's id.
    correlation_id_var.set(str(correlation_id))
    file_descriptors: list[dict] = payload.get("files", [])

    r.hset(job_key, "status", "processing")
    # Worker acknowledgment for the SSE stream — lets the frontend watchdog
    # distinguish "worker picked the job" from "nothing is listening at all".
    _xadd(r, stream_key, {"type": "claimed"}, ttl)

    # Fetch inline data for all file attachments on the current user message.
    # Done before the DB query so Gemini gets files + conversation history together.
    file_parts: list[dict] = []
    if file_descriptors and owner_id:
        for fd in file_descriptors:
            inline = build_inline_data(
                file_id=fd["file_id"],
                mime_type=fd.get("mime_type"),
                owner_id=owner_id,
                correlation_id=correlation_id,
                file_service_url=settings.file_service_url,
            )
            if inline is not None:
                file_parts.append(inline)

    if file_descriptors and len(file_parts) < len(file_descriptors):
        logger.warning(
            "job %s: only %d/%d attachments loaded for Gemini (check file-service URL, "
            "ownership, sizes, or blob download)",
            job_id,
            len(file_parts),
            len(file_descriptors),
        )

    with SessionLocal() as session:
        messages = (
            session.execute(
                select(Message)
                .where(Message.conversation_id == conversation_id)
                .order_by(Message.created_at)
            )
            .scalars()
            .all()
        )
        contents = _build_gemini_contents(
            list(messages),
            user_message_id=user_message_id,
            file_parts=file_parts,
        )
        if not contents:
            _emit_generation_failure(
                r=r,
                stream_key=stream_key,
                job_key=job_key,
                ttl=ttl,
                SessionLocal=SessionLocal,
                conversation_id=conversation_id,
                normalized=normalize_simple(
                    "internal_empty_history",
                    "Could not build this reply because conversation messages were unavailable.",
                    detail="no messages in conversation",
                ),
                legacy_detail="no messages in conversation",
            )
            return

    url = stream_generate_url(model)
    full_text: list[str] = []
    max_attempts = max(1, settings.generation_retry_attempts)

    for attempt in range(1, max_attempts + 1):
        failure = _attempt_generation(
            url=url,
            api_key=api_key,
            contents=contents,
            r=r,
            stream_key=stream_key,
            ttl=ttl,
            full_text=full_text,
        )
        if failure is None:
            break

        # `not full_text` is the constraint that keeps re-attach correct: once deltas
        # are in the Redis Stream, a retry would duplicate text for any client
        # replaying from entry 0. A mid-stream break therefore fails as before.
        if not (
            failure.normalized.retryable and not full_text and attempt < max_attempts
        ):
            if attempt > 1:
                JOBS_TOTAL.labels(status="retry_exhausted").inc()
            _emit_generation_failure(
                r=r,
                stream_key=stream_key,
                job_key=job_key,
                ttl=ttl,
                SessionLocal=SessionLocal,
                conversation_id=conversation_id,
                normalized=failure.normalized,
                raw_sse_body=failure.raw_sse_body,
                legacy_detail=failure.legacy_detail,
            )
            return

        wait = _retry_wait_seconds(attempt, failure.retry_after, settings)
        logger.warning(
            "job %s attempt %d/%d failed (%s), retrying in %.1fs",
            job_id,
            attempt,
            max_attempts,
            failure.normalized.code,
            wait,
        )
        JOBS_TOTAL.labels(status="retried").inc()
        # Keeps a waiting client informed instead of staring at a frozen bubble.
        _xadd(
            r,
            stream_key,
            {
                "type": "retrying",
                "attempt": attempt + 1,
                "max_attempts": max_attempts,
            },
            ttl,
        )
        time.sleep(wait)

    assistant_body = "".join(full_text)

    try:
        with SessionLocal() as session:
            assistant = Message(
                conversation_id=conversation_id,
                role="assistant",
                content=assistant_body,
            )
            session.add(assistant)
            session.commit()
            assistant_id = assistant.id
            if owner_id:
                try:
                    enqueue_message_sent_sync(
                        session,
                        message_id=assistant_id,
                        conversation_id=conversation_id,
                        owner_id=owner_id,
                        correlation_id=str(correlation_id),
                        role="assistant",
                        model=model,
                    )
                except Exception:
                    logger.exception(
                        "failed to enqueue chatbot.message.sent (assistant) job %s",
                        job_id,
                    )
    except Exception as exc:  # noqa: BLE001
        logger.exception("persist assistant for job %s", job_id)
        _emit_generation_failure(
            r=r,
            stream_key=stream_key,
            job_key=job_key,
            ttl=ttl,
            SessionLocal=SessionLocal,
            conversation_id=conversation_id,
            normalized=normalize_simple(
                "db_persist_error",
                "The reply could not be saved. Please try sending your message again.",
                detail=str(exc),
            ),
            legacy_detail=f"db error: {exc}",
        )
        return

    try:
        with SessionLocal() as session:
            conv = session.get(Conversation, conversation_id)
            user_msg = session.get(Message, user_message_id)
            if (
                conv is not None
                and user_msg is not None
                and not (conv.title or "").strip()
            ):
                title_model = (
                    settings.gemini_title_model or "gemini-flash-lite-latest"
                ).strip()
                new_title = try_sidebar_title_with_fallback_models(
                    api_key=api_key,
                    primary_model=title_model,
                    fallback_model="",
                    user_text=user_msg.content or "",
                    assistant_text=assistant_body,
                )
                if not new_title:
                    fb = sidebar_title_from_user_text(user_msg.content or "")
                    if fb and fb != "New chat":
                        new_title = fb[:200]
                if new_title:
                    conv.title = new_title[:200]
                    session.commit()
                    logger.info(
                        "job %s set conversation title for %s",
                        job_id,
                        conversation_id,
                    )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "conversation title generation skipped for job %s: %s", job_id, exc
        )

    conversation_title = ""
    try:
        with SessionLocal() as session:
            conv_out = session.get(Conversation, conversation_id)
            if conv_out is not None:
                conversation_title = (conv_out.title or "").strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not read conversation title for job %s: %s", job_id, exc)

    r.hset(job_key, "status", "done")
    r.hset(job_key, "assistant_message_id", str(assistant_id))
    _xadd(
        r,
        stream_key,
        {
            "type": "done",
            "assistant_message_id": str(assistant_id),
            "full_text": assistant_body,
            "conversation_id": str(conversation_id),
            "conversation_title": conversation_title,
        },
        ttl,
    )
    JOBS_TOTAL.labels(status="processed").inc()


def main() -> None:
    configure_logging("chatbot-worker")
    settings = get_settings()
    r = redis.from_url(settings.redis_url, decode_responses=True)
    engine = create_engine(settings.sync_database_url, pool_pre_ping=True)
    SessionLocal = sessionmaker(bind=engine, class_=Session, expire_on_commit=False)

    metrics_port = int(os.getenv("CHATBOT_WORKER_METRICS_PORT", "8051"))
    start_http_server(metrics_port)

    logger.info("worker started; blocking on %s", settings.queue_key)
    while True:
        item = r.blpop(settings.queue_key, timeout=5)
        if item is None:
            continue
        _, raw = item
        start = time.perf_counter()
        try:
            # outcome counters live inside process_one_job / _emit_generation_failure
            process_one_job(raw, settings=settings, r=r, SessionLocal=SessionLocal)
        except Exception:  # noqa: BLE001
            JOBS_TOTAL.labels(status="unhandled_error").inc()
            logger.exception("unhandled job error raw=%s", raw[:500] if raw else "")
        finally:
            JOB_DURATION.observe(time.perf_counter() - start)


if __name__ == "__main__":
    main()
