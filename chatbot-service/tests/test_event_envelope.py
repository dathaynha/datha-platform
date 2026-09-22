"""Envelope builders for platform events."""

from __future__ import annotations

import uuid

from app.services.event_envelope import (
    RECONCILE_SENTINEL_CONVERSATION_ID,
    SUBJECT_CONVERSATION_DELETED,
    SUBJECT_MESSAGE_SENT,
    TYPE_CONVERSATION_DELETED,
    TYPE_MESSAGE_SENT,
    conversation_deleted_envelope,
    conversation_deleted_reconcile_envelope,
    message_sent_envelope,
)


def test_conversation_deleted_envelope_shape() -> None:
    cid = uuid.uuid4()
    fid = uuid.uuid4()
    env = conversation_deleted_envelope(
        conversation_id=cid,
        owner_id="google_sub",
        correlation_id="corr-1",
        file_ids=[fid],
    )
    assert env["type"] == TYPE_CONVERSATION_DELETED
    assert env["service"] == "chatbot-service"
    assert env["entity_id"] == str(cid)
    assert env["payload"]["file_ids"] == [str(fid)]


def test_conversation_deleted_reconcile_envelope() -> None:
    env = conversation_deleted_reconcile_envelope(
        owner_id="google_sub",
        file_ids=["f1", "f2"],
        run_id="abc123",
    )
    assert env["entity_id"] == RECONCILE_SENTINEL_CONVERSATION_ID
    assert env["payload"]["reconciliation"] is True
    assert env["payload"]["file_ids"] == ["f1", "f2"]
    assert env["correlation_id"] == "reconcile-orphans-abc123"


def test_message_sent_subject_constants() -> None:
    mid = uuid.uuid4()
    cid = uuid.uuid4()
    env = message_sent_envelope(
        message_id=mid,
        conversation_id=cid,
        owner_id="entra_oid",
        correlation_id=None,
        role="assistant",
        model="gemini-flash-latest",
    )
    assert env["type"] == TYPE_MESSAGE_SENT
    assert env["payload"]["role"] == "assistant"
    assert env["payload"]["model"] == "gemini-flash-latest"
    assert SUBJECT_MESSAGE_SENT == "events.chatbot.message.sent"
    assert SUBJECT_CONVERSATION_DELETED == "events.chatbot.conversation.deleted"
