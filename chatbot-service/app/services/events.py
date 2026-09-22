"""NATS JetStream publishers for platform business events."""

from __future__ import annotations

import logging
import uuid
from typing import TYPE_CHECKING

from app.services.event_envelope import (
    SUBJECT_CONVERSATION_DELETED,
    SUBJECT_MESSAGE_SENT,
    conversation_deleted_envelope,
    message_sent_envelope,
)
from app.services.event_outbox import dispatch_event, enqueue_outbox_sync

if TYPE_CHECKING:
    from nats.js import JetStreamContext
    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


async def publish_conversation_deleted(
    session: AsyncSession,
    js: JetStreamContext | None,
    *,
    conversation_id: uuid.UUID,
    owner_id: str,
    correlation_id: str | None,
    file_ids: list[uuid.UUID],
) -> None:
    envelope = conversation_deleted_envelope(
        conversation_id=conversation_id,
        owner_id=owner_id,
        correlation_id=correlation_id,
        file_ids=file_ids,
    )
    await dispatch_event(
        session,
        js,
        subject=SUBJECT_CONVERSATION_DELETED,
        envelope=envelope,
    )


async def publish_message_sent(
    session: AsyncSession,
    js: JetStreamContext | None,
    *,
    message_id: uuid.UUID,
    conversation_id: uuid.UUID,
    owner_id: str,
    correlation_id: str | None,
    role: str,
    model: str | None = None,
) -> None:
    envelope = message_sent_envelope(
        message_id=message_id,
        conversation_id=conversation_id,
        owner_id=owner_id,
        correlation_id=correlation_id,
        role=role,
        model=model,
    )
    await dispatch_event(
        session,
        js,
        subject=SUBJECT_MESSAGE_SENT,
        envelope=envelope,
    )


def enqueue_message_sent_sync(
    session: Session,
    *,
    message_id: uuid.UUID,
    conversation_id: uuid.UUID,
    owner_id: str,
    correlation_id: str | None,
    role: str,
    model: str | None = None,
) -> None:
    """Worker path: persist outbox row; API outbox loop publishes to JetStream."""
    envelope = message_sent_envelope(
        message_id=message_id,
        conversation_id=conversation_id,
        owner_id=owner_id,
        correlation_id=correlation_id,
        role=role,
        model=model,
    )
    enqueue_outbox_sync(
        session,
        subject=SUBJECT_MESSAGE_SENT,
        envelope=envelope,
    )
    session.commit()
