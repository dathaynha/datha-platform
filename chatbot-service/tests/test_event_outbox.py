"""Outbox backoff and publish helpers (no real NATS)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.event_outbox import backoff_seconds, dispatch_event, try_publish


@pytest.mark.parametrize(
    ("attempts", "cap", "expected"),
    [
        (0, 3600, 1),
        (1, 3600, 2),
        (2, 3600, 4),
        (3, 3600, 8),
        (20, 3600, 3600),
        (5, 10, 10),
    ],
)
def test_backoff_seconds(attempts: int, cap: int, expected: int) -> None:
    assert backoff_seconds(attempts, cap=cap) == expected


def _outbox_session() -> MagicMock:
    session = MagicMock()
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    return session


@pytest.mark.asyncio
async def test_try_publish_false_when_js_missing() -> None:
    assert (
        await try_publish(None, subject="events.test", envelope={"type": "t"}) is False
    )


@pytest.mark.asyncio
async def test_try_publish_true_when_js_publishes() -> None:
    js = AsyncMock()
    ok = await try_publish(js, subject="events.test", envelope={"type": "t", "id": "1"})
    assert ok is True
    js.publish.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatch_enqueues_when_nats_unavailable() -> None:
    session = _outbox_session()
    await dispatch_event(
        session,
        None,
        subject="events.chatbot.conversation.deleted",
        envelope={"type": "chatbot.conversation.deleted"},
    )
    session.add.assert_called_once()
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatch_publishes_directly_when_nats_up() -> None:
    js = AsyncMock()
    session = MagicMock()
    await dispatch_event(
        session,
        js,
        subject="events.chatbot.message.sent",
        envelope={"type": "chatbot.message.sent"},
    )
    js.publish.assert_awaited_once()
    session.add.assert_not_called()
    session.commit.assert_not_called()


@pytest.mark.asyncio
async def test_dispatch_enqueues_when_publish_raises() -> None:
    js = AsyncMock()
    js.publish = AsyncMock(side_effect=RuntimeError("broker down"))
    session = _outbox_session()
    await dispatch_event(
        session,
        js,
        subject="events.chatbot.message.sent",
        envelope={"type": "chatbot.message.sent"},
    )
    session.add.assert_called_once()
    session.commit.assert_awaited_once()
