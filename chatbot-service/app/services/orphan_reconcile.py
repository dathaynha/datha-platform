"""Orphan file backfill + outbox sweep (manual CLI; ADO cron later)."""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from sqlalchemy import distinct, exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models.conversation import Conversation
from app.models.event_outbox import EventOutbox
from app.models.message_file import MessageFile
from app.services.event_envelope import (
    SUBJECT_CONVERSATION_DELETED,
    conversation_deleted_reconcile_envelope,
)
from app.services.event_outbox import drain_outbox_batch
from app.services.file_client import list_files_for_owner

if TYPE_CHECKING:
    from nats.js import JetStreamContext

logger = logging.getLogger(__name__)

ORPHAN_FILE_MIN_AGE_HOURS = 24
FILE_ORIGIN_CHATBOT = "chatbot"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class ReconcileStats:
    outbox_would_publish: int = 0
    outbox_published: int = 0
    owners_scanned: int = 0
    orphan_candidates: int = 0
    orphan_events_published: int = 0
    errors: list[str] = field(default_factory=list)


async def _pending_outbox_rows(session: AsyncSession) -> list[EventOutbox]:
    now = _utcnow()
    stmt = (
        select(EventOutbox)
        .where(
            EventOutbox.status == "pending",
            EventOutbox.next_attempt_at <= now,
        )
        .order_by(EventOutbox.created_at)
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def sweep_outbox(
    session: AsyncSession,
    js: JetStreamContext | None,
    settings: Settings,
    *,
    execute: bool,
    stats: ReconcileStats,
) -> None:
    if not execute:
        rows = await _pending_outbox_rows(session)
        stats.outbox_would_publish = len(rows)
        for row in rows:
            logger.info(
                "[dry-run] would publish outbox id=%s subject=%s type=%s",
                row.id,
                row.subject,
                row.envelope.get("type"),
            )
        return

    if js is None:
        stats.errors.append("NATS unavailable; outbox drain skipped")
        logger.warning("NATS unavailable; outbox drain skipped")
        return

    total = 0
    while True:
        n = await drain_outbox_batch(
            session,
            js,
            batch_size=settings.event_outbox_batch_size,
            max_backoff_seconds=settings.event_outbox_max_backoff_seconds,
        )
        total += n
        if n == 0:
            break
    stats.outbox_published = total


async def _owner_ids_to_scan(session: AsyncSession) -> list[str]:
    from_conversations = await session.execute(
        select(distinct(Conversation.owner_id)).where(Conversation.owner_id != "")
    )
    owners = {row[0] for row in from_conversations.all() if row[0]}

    outbox_rows = await session.execute(
        select(EventOutbox.envelope).where(
            EventOutbox.subject == SUBJECT_CONVERSATION_DELETED,
        )
    )
    for (envelope,) in outbox_rows.all():
        if isinstance(envelope, dict):
            oid = envelope.get("owner_id")
            if isinstance(oid, str) and oid:
                owners.add(oid)

    return sorted(owners)


async def _is_file_referenced(session: AsyncSession, file_id: uuid.UUID) -> bool:
    stmt = select(exists().where(MessageFile.file_id == file_id))
    result = await session.execute(stmt)
    return bool(result.scalar())


def _parse_created_at(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        text = raw.replace("Z", "+00:00")
        return datetime.fromisoformat(text)
    except ValueError:
        return None


async def scan_orphan_files(
    session: AsyncSession,
    js: JetStreamContext | None,
    settings: Settings,
    *,
    execute: bool,
    run_id: str,
    stats: ReconcileStats,
) -> None:
    min_age = timedelta(hours=ORPHAN_FILE_MIN_AGE_HOURS)
    cutoff = datetime.now(timezone.utc) - min_age
    correlation_id = f"reconcile-orphans-{run_id}"

    owners = await _owner_ids_to_scan(session)
    stats.owners_scanned = len(owners)

    for owner_id in owners:
        try:
            files = list_files_for_owner(
                owner_id=owner_id,
                correlation_id=correlation_id,
                file_service_url=settings.file_service_url,
                origin=FILE_ORIGIN_CHATBOT,
            )
        except Exception as exc:
            msg = f"list files failed owner={owner_id}: {exc}"
            stats.errors.append(msg)
            logger.warning(msg)
            continue

        orphan_ids: list[str] = []
        for f in files:
            file_id_str = f.get("id")
            if not file_id_str:
                continue
            try:
                file_uuid = uuid.UUID(str(file_id_str))
            except ValueError:
                continue

            created = _parse_created_at(f.get("createdAt"))
            if created is not None and created > cutoff:
                continue

            if await _is_file_referenced(session, file_uuid):
                continue

            orphan_ids.append(str(file_uuid))

        if not orphan_ids:
            continue

        stats.orphan_candidates += len(orphan_ids)
        envelope = conversation_deleted_reconcile_envelope(
            owner_id=owner_id,
            file_ids=orphan_ids,
            run_id=run_id,
        )

        if not execute:
            logger.info(
                "[dry-run] would publish conversation.deleted reconcile owner=%s file_count=%d ids=%s",
                owner_id,
                len(orphan_ids),
                orphan_ids,
            )
            continue

        if js is None:
            stats.errors.append(
                f"NATS unavailable; orphan publish skipped owner={owner_id}"
            )
            continue

        await js.publish(
            SUBJECT_CONVERSATION_DELETED,
            json.dumps(envelope).encode("utf-8"),
        )
        stats.orphan_events_published += 1
        logger.info(
            "published reconcile conversation.deleted owner=%s file_count=%d",
            owner_id,
            len(orphan_ids),
        )


async def run_reconcile(
    session: AsyncSession,
    js: JetStreamContext | None,
    settings: Settings,
    *,
    execute: bool,
) -> ReconcileStats:
    run_id = uuid.uuid4().hex[:12]
    stats = ReconcileStats()
    mode = "execute" if execute else "dry-run"
    logger.info("orphan reconcile starting mode=%s run_id=%s", mode, run_id)

    await sweep_outbox(session, js, settings, execute=execute, stats=stats)
    await scan_orphan_files(
        session, js, settings, execute=execute, run_id=run_id, stats=stats
    )

    logger.info(
        "orphan reconcile finished mode=%s run_id=%s stats=%s errors=%d",
        mode,
        run_id,
        stats,
        len(stats.errors),
    )
    return stats
