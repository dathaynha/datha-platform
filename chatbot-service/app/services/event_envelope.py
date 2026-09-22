"""Platform event subjects and envelope builders (platform/event-store-architecture.md)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

SERVICE_NAME = "chatbot-service"

SUBJECT_CONVERSATION_DELETED = "events.chatbot.conversation.deleted"
SUBJECT_MESSAGE_SENT = "events.chatbot.message.sent"

TYPE_CONVERSATION_DELETED = "chatbot.conversation.deleted"
TYPE_MESSAGE_SENT = "chatbot.message.sent"

# Sentinel entity for orphan backfill (no conversation row — see platform/chatbot-file-events.md).
RECONCILE_SENTINEL_CONVERSATION_ID = "00000000-0000-0000-0000-000000000001"


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_envelope(
    *,
    event_type: str,
    entity_id: str,
    owner_id: str,
    correlation_id: str | None,
    payload: dict[str, Any],
    event_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": event_id or str(uuid.uuid4()),
        "type": event_type,
        "service": SERVICE_NAME,
        "entity_id": entity_id,
        "owner_id": owner_id,
        "correlation_id": correlation_id,
        "timestamp": utc_iso(),
        "payload": payload,
    }


def conversation_deleted_envelope(
    *,
    conversation_id: uuid.UUID,
    owner_id: str,
    correlation_id: str | None,
    file_ids: list[uuid.UUID],
) -> dict[str, Any]:
    return build_envelope(
        event_type=TYPE_CONVERSATION_DELETED,
        entity_id=str(conversation_id),
        owner_id=owner_id,
        correlation_id=correlation_id,
        payload={
            "conversation_id": str(conversation_id),
            "file_ids": [str(fid) for fid in file_ids],
        },
    )


def conversation_deleted_reconcile_envelope(
    *,
    owner_id: str,
    file_ids: list[str],
    run_id: str,
) -> dict[str, Any]:
    """Orphan backfill publish — same subject/type as normal delete; sentinel conversation_id."""
    return build_envelope(
        event_type=TYPE_CONVERSATION_DELETED,
        entity_id=RECONCILE_SENTINEL_CONVERSATION_ID,
        owner_id=owner_id,
        correlation_id=f"reconcile-orphans-{run_id}",
        payload={
            "conversation_id": RECONCILE_SENTINEL_CONVERSATION_ID,
            "file_ids": file_ids,
            "reconciliation": True,
        },
    )


def message_sent_envelope(
    *,
    message_id: uuid.UUID,
    conversation_id: uuid.UUID,
    owner_id: str,
    correlation_id: str | None,
    role: str,
    model: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "conversation_id": str(conversation_id),
        "message_id": str(message_id),
        "role": role,
    }
    if model:
        payload["model"] = model
    return build_envelope(
        event_type=TYPE_MESSAGE_SENT,
        entity_id=str(message_id),
        owner_id=owner_id,
        correlation_id=correlation_id,
        payload=payload,
    )
