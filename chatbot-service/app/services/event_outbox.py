"""Postgres outbox: enqueue failed/skipped NATS publishes; drain when JetStream is up."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.models.event_outbox import EventOutbox

if TYPE_CHECKING:
    from nats.js import JetStreamContext

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def backoff_seconds(attempts: int, *, cap: int) -> int:
    """Exponential backoff after a failed publish (1, 2, 4, … capped)."""
    return min(cap, max(1, 2 ** min(attempts, 12)))


async def enqueue_outbox(
    session: AsyncSession,
    *,
    subject: str,
    envelope: dict[str, Any],
) -> uuid.UUID:
    row = EventOutbox(
        subject=subject,
        envelope=envelope,
        status="pending",
        next_attempt_at=_utcnow(),
    )
    session.add(row)
    await session.flush()
    logger.info(
        "enqueued outbox id=%s subject=%s type=%s",
        row.id,
        subject,
        envelope.get("type"),
    )
    return row.id


def enqueue_outbox_sync(
    session: Session,
    *,
    subject: str,
    envelope: dict[str, Any],
) -> None:
    row = EventOutbox(
        subject=subject,
        envelope=envelope,
        status="pending",
        next_attempt_at=_utcnow(),
    )
    session.add(row)
    session.flush()
    logger.info(
        "enqueued outbox id=%s subject=%s type=%s",
        row.id,
        subject,
        envelope.get("type"),
    )


async def try_publish(
    js: JetStreamContext | None,
    *,
    subject: str,
    envelope: dict[str, Any],
) -> bool:
    if js is None:
        return False
    await js.publish(subject, json.dumps(envelope).encode("utf-8"))
    return True


async def dispatch_event(
    session: AsyncSession,
    js: JetStreamContext | None,
    *,
    subject: str,
    envelope: dict[str, Any],
) -> None:
    """Publish immediately when NATS is up; otherwise persist to outbox."""
    try:
        if await try_publish(js, subject=subject, envelope=envelope):
            logger.info(
                "published %s type=%s entity_id=%s",
                subject,
                envelope.get("type"),
                envelope.get("entity_id"),
            )
            return
    except Exception:
        logger.warning(
            "direct publish failed for %s; enqueueing outbox",
            subject,
            exc_info=True,
        )
    await enqueue_outbox(session, subject=subject, envelope=envelope)
    await session.commit()


async def drain_outbox_batch(
    session: AsyncSession,
    js: JetStreamContext | None,
    *,
    batch_size: int,
    max_backoff_seconds: int,
) -> int:
    if js is None:
        return 0

    now = _utcnow()
    stmt = (
        select(EventOutbox)
        .where(
            EventOutbox.status == "pending",
            EventOutbox.next_attempt_at <= now,
        )
        .order_by(EventOutbox.created_at)
        .limit(batch_size)
        .with_for_update(skip_locked=True)
    )
    result = await session.execute(stmt)
    rows = list(result.scalars().all())
    if not rows:
        return 0

    published = 0
    for row in rows:
        try:
            await js.publish(
                row.subject,
                json.dumps(row.envelope).encode("utf-8"),
            )
            row.status = "published"
            row.published_at = _utcnow()
            row.last_error = None
            published += 1
            logger.info(
                "outbox published id=%s subject=%s type=%s",
                row.id,
                row.subject,
                row.envelope.get("type"),
            )
        except Exception as exc:
            row.attempts += 1
            row.last_error = str(exc)[:2000]
            delay = backoff_seconds(row.attempts, cap=max_backoff_seconds)
            row.next_attempt_at = now + timedelta(seconds=delay)
            logger.warning(
                "outbox publish failed id=%s attempts=%d next_in=%ds: %s",
                row.id,
                row.attempts,
                delay,
                exc,
            )

    await session.commit()
    return published


async def outbox_drain_loop(
    *,
    js_getter: Any,
    poll_interval_seconds: float,
    batch_size: int,
    max_backoff_seconds: int,
    stop_event: asyncio.Event,
) -> None:
    from app.db.session import AsyncSessionLocal

    while not stop_event.is_set():
        js = js_getter()
        try:
            async with AsyncSessionLocal() as session:
                await drain_outbox_batch(
                    session,
                    js,
                    batch_size=batch_size,
                    max_backoff_seconds=max_backoff_seconds,
                )
        except Exception:
            logger.exception("outbox drain batch failed")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=poll_interval_seconds)
        except asyncio.TimeoutError:
            continue
