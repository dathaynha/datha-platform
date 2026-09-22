"""Claim script against a real Redis — Lua semantics cannot be proven with a fake.

Skipped when no Redis is reachable (unit CI), so it never turns into a flaky gate.
"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace

import pytest
from redis.asyncio import Redis

from app.core.config import redis_conv_active_job_key, redis_job_meta_key
from app.services.job_enqueue import claim_conversation_slot

SETTINGS = SimpleNamespace(job_meta_ttl_seconds=60)


@pytest.fixture
async def redis():
    client = Redis.from_url("redis://localhost:6379/15", decode_responses=True)
    try:
        await client.ping()
    except Exception:  # noqa: BLE001 — no local Redis: not a failure
        await client.aclose()
        pytest.skip("no Redis on localhost:6379")
    await client.flushdb()
    yield client
    await client.flushdb()
    await client.aclose()


async def _claim(
    redis: Redis, conversation_id: uuid.UUID
) -> tuple[uuid.UUID, str | None]:
    job_id = uuid.uuid4()
    busy = await claim_conversation_slot(
        redis, SETTINGS, conversation_id=conversation_id, job_id=job_id
    )
    return job_id, busy


async def test_free_slot_is_claimed_and_marked_pending(redis: Redis) -> None:
    conv = uuid.uuid4()

    job_id, busy = await _claim(redis, conv)

    assert busy is None
    assert await redis.get(redis_conv_active_job_key(str(conv))) == str(job_id)
    meta = await redis.hgetall(redis_job_meta_key(str(job_id)))
    # Stamped inside the script so a racing claim sees it immediately.
    assert meta["status"] == "pending"
    assert meta["conversation_id"] == str(conv)
    assert 0 < await redis.ttl(redis_job_meta_key(str(job_id))) <= 60


@pytest.mark.parametrize("status", ["pending", "processing"])
async def test_running_job_blocks_and_keeps_the_pointer(
    redis: Redis, status: str
) -> None:
    conv = uuid.uuid4()
    first, _ = await _claim(redis, conv)
    await redis.hset(redis_job_meta_key(str(first)), "status", status)

    second, busy = await _claim(redis, conv)

    assert busy == str(first)
    assert await redis.get(redis_conv_active_job_key(str(conv))) == str(first)
    assert not await redis.exists(redis_job_meta_key(str(second)))


@pytest.mark.parametrize("status", ["done", "failed"])
async def test_finished_job_pointer_is_overwritten(redis: Redis, status: str) -> None:
    conv = uuid.uuid4()
    first, _ = await _claim(redis, conv)
    await redis.hset(redis_job_meta_key(str(first)), "status", status)

    second, busy = await _claim(redis, conv)

    assert busy is None
    assert await redis.get(redis_conv_active_job_key(str(conv))) == str(second)


async def test_pointer_from_another_conversation_is_overwritten(redis: Redis) -> None:
    conv, other = uuid.uuid4(), uuid.uuid4()
    stale, _ = await _claim(redis, other)
    await redis.set(redis_conv_active_job_key(str(conv)), str(stale))

    mine, busy = await _claim(redis, conv)

    assert busy is None
    assert await redis.get(redis_conv_active_job_key(str(conv))) == str(mine)


async def test_expired_meta_frees_the_slot(redis: Redis) -> None:
    conv = uuid.uuid4()
    first, _ = await _claim(redis, conv)
    await redis.delete(redis_job_meta_key(str(first)))

    second, busy = await _claim(redis, conv)

    assert busy is None
    assert await redis.get(redis_conv_active_job_key(str(conv))) == str(second)


async def test_only_one_of_many_simultaneous_claims_wins(redis: Redis) -> None:
    """The whole point: the check and the set are one script, so ties cannot both pass."""
    conv = uuid.uuid4()

    results = await asyncio.gather(*(_claim(redis, conv) for _ in range(8)))

    winners = [job_id for job_id, busy in results if busy is None]
    assert len(winners) == 1
    assert await redis.get(redis_conv_active_job_key(str(conv))) == str(winners[0])
