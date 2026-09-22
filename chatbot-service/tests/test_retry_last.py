"""POST /conversations/{id}/retry-last — re-run the last user turn, no second message."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import (
    JOB_META_KEY_PREFIX,
    redis_conv_active_job_key,
    redis_job_meta_key,
)
from app.models.message import Message
from app.routers import conversations as router
from app.schemas.messages import RetryLastRequest

from tests.conftest import add_conversation, attach_file

OWNER = "owner-1"
MODEL = "gemini-3.6-flash"

STUB_SETTINGS = SimpleNamespace(queue_key="chatbot:jobs", job_meta_ttl_seconds=60)


@pytest.fixture(autouse=True)
def stub_settings_and_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the endpoint off .env and off Google's models.list."""
    monkeypatch.setattr(router, "get_settings", lambda: STUB_SETTINGS)
    monkeypatch.setattr(router, "resolve_requested_model", lambda _s, _m: MODEL)


def _redis(*, busy_job: str | None = None):
    """`busy_job` = what the claim script reports; None means the slot was free."""
    r = AsyncMock()
    r.eval = AsyncMock(return_value=busy_job)
    return r


def _queued_payload(redis: AsyncMock) -> dict:
    redis.rpush.assert_awaited_once()
    key, raw = redis.rpush.await_args.args
    assert key == STUB_SETTINGS.queue_key
    return json.loads(raw)


async def _add(
    session: AsyncSession,
    *,
    conversation_id: uuid.UUID,
    role: str,
    content: str = "hello",
    error_code: str | None = None,
    minutes_ago: int = 0,
) -> Message:
    msg = Message(
        conversation_id=conversation_id,
        role=role,
        content=content,
        generation_error_code=error_code,
        generation_error_summary=error_code and "provider said no",
        created_at=datetime.now(timezone.utc) - timedelta(minutes=minutes_ago),
    )
    session.add(msg)
    await session.flush()
    return msg


async def _seed_failed_turn(
    session: AsyncSession,
) -> tuple[uuid.UUID, Message, Message]:
    conv = await add_conversation(session, owner_id=OWNER)
    user_msg = await _add(session, conversation_id=conv.id, role="user", minutes_ago=2)
    failed = await _add(
        session,
        conversation_id=conv.id,
        role="assistant",
        content="The AI service could not complete this request.",
        error_code="provider_http_503",
        minutes_ago=1,
    )
    return conv.id, user_msg, failed


async def _call(
    conv_id: uuid.UUID,
    session: AsyncSession,
    redis: AsyncMock,
    *,
    owner: str = OWNER,
    body: RetryLastRequest | None = None,
):
    return await router.retry_last_generation(
        conversation_id=conv_id,
        session=session,
        owner_id=owner,
        redis=redis,
        body=body,
    )


async def test_deletes_the_failed_reply_and_requeues_the_same_user_turn(
    db_session: AsyncSession,
) -> None:
    conv_id, user_msg, failed = await _seed_failed_turn(db_session)
    redis = _redis()

    result = await _call(conv_id, db_session, redis)

    assert result.user_message_id == user_msg.id
    assert result.conversation_id == conv_id
    # job_id doubles as correlation_id, as on the send path.
    assert result.correlation_id == result.job_id

    payload = _queued_payload(redis)
    assert payload["user_message_id"] == str(user_msg.id)
    assert payload["job_id"] == str(result.job_id)
    assert payload["model"] == MODEL
    assert payload["owner_id"] == OWNER
    assert payload["files"] == []

    # The dead bubble is gone and no second user message was created.
    assert await db_session.get(Message, failed.id) is None
    total = await db_session.scalar(
        select(func.count(Message.id)).where(Message.conversation_id == conv_id)
    )
    assert total == 1


async def test_writes_job_meta_and_active_job_pointer(
    db_session: AsyncSession,
) -> None:
    conv_id, user_msg, _failed = await _seed_failed_turn(db_session)
    redis = _redis()

    result = await _call(conv_id, db_session, redis)

    redis.hset.assert_awaited_once()
    (meta_key,) = redis.hset.await_args.args
    assert meta_key == redis_job_meta_key(str(result.job_id))
    assert redis.hset.await_args.kwargs["mapping"]["status"] == "pending"
    redis.set.assert_awaited_once_with(
        redis_conv_active_job_key(str(conv_id)),
        str(result.job_id),
        ex=STUB_SETTINGS.job_meta_ttl_seconds,
    )
    assert (
        str(user_msg.id) == redis.hset.await_args.kwargs["mapping"]["user_message_id"]
    )


async def test_retries_a_user_turn_that_never_got_a_reply(
    db_session: AsyncSession,
) -> None:
    """The worker can die before persisting anything — the turn is still retryable."""
    conv = await add_conversation(db_session, owner_id=OWNER)
    user_msg = await _add(db_session, conversation_id=conv.id, role="user")
    redis = _redis()

    result = await _call(conv.id, db_session, redis)

    assert result.user_message_id == user_msg.id
    assert _queued_payload(redis)["user_message_id"] == str(user_msg.id)


async def test_reattaches_the_user_message_attachments(
    db_session: AsyncSession,
) -> None:
    conv_id, user_msg, _failed = await _seed_failed_turn(db_session)
    file_id = uuid.uuid4()
    await attach_file(
        db_session, message_id=user_msg.id, file_id=file_id, name="report.pdf"
    )
    redis = _redis()

    await _call(conv_id, db_session, redis)

    assert _queued_payload(redis)["files"] == [
        {"file_id": str(file_id), "name": "report.pdf", "mime_type": None}
    ]


async def test_successful_last_reply_is_not_retryable(
    db_session: AsyncSession,
) -> None:
    conv = await add_conversation(db_session, owner_id=OWNER)
    await _add(db_session, conversation_id=conv.id, role="user", minutes_ago=2)
    await _add(
        db_session,
        conversation_id=conv.id,
        role="assistant",
        content="A real answer.",
        minutes_ago=1,
    )
    redis = _redis()

    with pytest.raises(HTTPException) as exc:
        await _call(conv.id, db_session, redis)

    assert exc.value.status_code == 404
    redis.rpush.assert_not_awaited()


async def test_empty_conversation_has_nothing_to_retry(
    db_session: AsyncSession,
) -> None:
    conv = await add_conversation(db_session, owner_id=OWNER)
    redis = _redis()

    with pytest.raises(HTTPException) as exc:
        await _call(conv.id, db_session, redis)

    assert exc.value.status_code == 404
    redis.rpush.assert_not_awaited()


async def test_another_owner_gets_404(db_session: AsyncSession) -> None:
    conv_id, _user_msg, _failed = await _seed_failed_turn(db_session)
    redis = _redis()

    with pytest.raises(HTTPException) as exc:
        await _call(conv_id, db_session, redis, owner="someone-else")

    assert exc.value.status_code == 404
    # Ownership is checked before any Redis read.
    redis.get.assert_not_awaited()


async def test_conflicts_when_the_slot_is_already_claimed(
    db_session: AsyncSession,
) -> None:
    conv_id, _user_msg, failed = await _seed_failed_turn(db_session)
    redis = _redis(busy_job=str(uuid.uuid4()))

    with pytest.raises(HTTPException) as exc:
        await _call(conv_id, db_session, redis)

    assert exc.value.status_code == 409
    redis.rpush.assert_not_awaited()
    # The loser of the race must not delete the failed reply the winner will replace.
    assert await db_session.get(Message, failed.id) is not None


async def test_claim_runs_before_anything_is_mutated(
    db_session: AsyncSession,
) -> None:
    """A 404/400 must not leave a conversation pointer behind."""
    conv = await add_conversation(db_session, owner_id=OWNER)
    await _add(db_session, conversation_id=conv.id, role="user", minutes_ago=2)
    await _add(
        db_session,
        conversation_id=conv.id,
        role="assistant",
        content="A real answer.",
        minutes_ago=1,
    )
    redis = _redis()

    with pytest.raises(HTTPException) as exc:
        await _call(conv.id, db_session, redis)

    assert exc.value.status_code == 404
    redis.eval.assert_not_awaited()


async def test_claim_is_one_atomic_call_naming_this_conversation(
    db_session: AsyncSession,
) -> None:
    conv_id, _user_msg, _failed = await _seed_failed_turn(db_session)
    redis = _redis()

    result = await _call(conv_id, db_session, redis)

    redis.eval.assert_awaited_once()
    script, numkeys, key, claimed_job, conversation, ttl, prefix = (
        redis.eval.await_args.args
    )
    assert numkeys == 1
    assert key == redis_conv_active_job_key(str(conv_id))
    assert claimed_job == str(result.job_id)
    assert conversation == str(conv_id)
    assert ttl == str(STUB_SETTINGS.job_meta_ttl_seconds)
    assert prefix == JOB_META_KEY_PREFIX


async def test_rejected_model_is_a_400(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    conv_id, _user_msg, _failed = await _seed_failed_turn(db_session)

    def _reject(_settings: object, _requested: str) -> str:
        raise ValueError("model not allowed")

    monkeypatch.setattr(router, "resolve_requested_model", _reject)
    redis = _redis()

    with pytest.raises(HTTPException) as exc:
        await _call(conv_id, db_session, redis, body=RetryLastRequest(model="nope"))

    assert exc.value.status_code == 400
    assert exc.value.detail == "model not allowed"
    redis.rpush.assert_not_awaited()


async def test_redis_failure_is_a_503(db_session: AsyncSession) -> None:
    conv_id, _user_msg, _failed = await _seed_failed_turn(db_session)
    redis = _redis()
    redis.rpush = AsyncMock(side_effect=RuntimeError("redis down"))

    with pytest.raises(HTTPException) as exc:
        await _call(conv_id, db_session, redis)

    assert exc.value.status_code == 503
