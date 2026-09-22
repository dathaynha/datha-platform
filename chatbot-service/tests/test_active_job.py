"""GET /conversations/{id}/active-job — stream re-attach lookup."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import redis_conv_active_job_key, redis_job_meta_key
from app.routers.conversations import get_active_job
from app.schemas.conversations import ActiveJobOut

from tests.conftest import add_conversation, add_message

OWNER = "owner-1"


def _redis(*, job_id: str | None, meta: dict[str, str] | None) -> AsyncMock:
    r = AsyncMock()
    r.get = AsyncMock(return_value=job_id)
    r.hgetall = AsyncMock(return_value=meta or {})
    return r


async def _seed(session: AsyncSession) -> tuple[uuid.UUID, uuid.UUID]:
    conv = await add_conversation(session, owner_id=OWNER)
    msg = await add_message(session, conversation_id=conv.id)
    return conv.id, msg.id


@pytest.mark.parametrize("status", ["pending", "processing"])
async def test_returns_job_while_generating(
    db_session: AsyncSession, status: str
) -> None:
    conv_id, msg_id = await _seed(db_session)
    job_id = str(uuid.uuid4())
    redis = _redis(
        job_id=job_id,
        meta={
            "status": status,
            "conversation_id": str(conv_id),
            "user_message_id": str(msg_id),
        },
    )

    result = await get_active_job(
        conversation_id=conv_id, session=db_session, owner_id=OWNER, redis=redis
    )

    assert isinstance(result, ActiveJobOut)
    assert str(result.job_id) == job_id
    assert result.user_message_id == msg_id
    assert result.status == status
    redis.get.assert_awaited_once_with(redis_conv_active_job_key(str(conv_id)))
    redis.hgetall.assert_awaited_once_with(redis_job_meta_key(job_id))


@pytest.mark.parametrize("status", ["done", "failed"])
async def test_finished_job_returns_204(db_session: AsyncSession, status: str) -> None:
    conv_id, msg_id = await _seed(db_session)
    redis = _redis(
        job_id=str(uuid.uuid4()),
        meta={
            "status": status,
            "conversation_id": str(conv_id),
            "user_message_id": str(msg_id),
        },
    )

    result = await get_active_job(
        conversation_id=conv_id, session=db_session, owner_id=OWNER, redis=redis
    )

    assert isinstance(result, Response)
    assert result.status_code == 204


async def test_no_key_returns_204(db_session: AsyncSession) -> None:
    conv_id, _ = await _seed(db_session)
    redis = _redis(job_id=None, meta=None)

    result = await get_active_job(
        conversation_id=conv_id, session=db_session, owner_id=OWNER, redis=redis
    )

    assert isinstance(result, Response)
    assert result.status_code == 204


async def test_expired_job_meta_returns_204(db_session: AsyncSession) -> None:
    """Key outlived its job hash (TTL skew) — treat as nothing running."""
    conv_id, _ = await _seed(db_session)
    redis = _redis(job_id=str(uuid.uuid4()), meta={})

    result = await get_active_job(
        conversation_id=conv_id, session=db_session, owner_id=OWNER, redis=redis
    )

    assert isinstance(result, Response)
    assert result.status_code == 204


async def test_meta_for_other_conversation_returns_204(
    db_session: AsyncSession,
) -> None:
    """Guards against a stale key pointing at a job from another thread."""
    conv_id, msg_id = await _seed(db_session)
    redis = _redis(
        job_id=str(uuid.uuid4()),
        meta={
            "status": "processing",
            "conversation_id": str(uuid.uuid4()),
            "user_message_id": str(msg_id),
        },
    )

    result = await get_active_job(
        conversation_id=conv_id, session=db_session, owner_id=OWNER, redis=redis
    )

    assert isinstance(result, Response)
    assert result.status_code == 204


async def test_other_owner_gets_404(db_session: AsyncSession) -> None:
    conv_id, msg_id = await _seed(db_session)
    redis = _redis(
        job_id=str(uuid.uuid4()),
        meta={
            "status": "processing",
            "conversation_id": str(conv_id),
            "user_message_id": str(msg_id),
        },
    )

    with pytest.raises(HTTPException) as exc:
        await get_active_job(
            conversation_id=conv_id,
            session=db_session,
            owner_id="someone-else",
            redis=redis,
        )

    assert exc.value.status_code == 404
    redis.get.assert_not_awaited()


async def test_unknown_conversation_gets_404(db_session: AsyncSession) -> None:
    redis = _redis(job_id=None, meta=None)

    with pytest.raises(HTTPException) as exc:
        await get_active_job(
            conversation_id=uuid.uuid4(),
            session=db_session,
            owner_id=OWNER,
            redis=redis,
        )

    assert exc.value.status_code == 404
