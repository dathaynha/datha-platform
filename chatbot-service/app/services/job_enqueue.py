"""Push a generation job onto `chatbot:jobs` — shared by POST /messages and retry-last."""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from typing import TypedDict

from redis.asyncio import Redis

from app.core.config import (
    JOB_META_KEY_PREFIX,
    Settings,
    redis_conv_active_job_key,
    redis_job_meta_key,
)


class JobFileRef(TypedDict):
    """Attachment descriptor as the worker expects it in the job payload."""

    file_id: str
    name: str
    mime_type: str | None


class JobEnqueueError(RuntimeError):
    """Redis was unreachable — the caller turns this into a 503."""


async def enqueue_generation_job(
    redis: Redis,
    settings: Settings,
    *,
    job_id: uuid.UUID,
    correlation_id: uuid.UUID,
    conversation_id: uuid.UUID,
    user_message_id: uuid.UUID,
    model: str,
    owner_id: str,
    files: Sequence[JobFileRef],
) -> None:
    """Write job meta, mark the conversation's active job, then queue the work.

    Order matters: the meta hash and the `conv_active_job` pointer must exist before
    the worker can claim the job, or a revisit could find a job it cannot describe.
    """
    meta = {
        "conversation_id": str(conversation_id),
        "user_message_id": str(user_message_id),
        "model": model,
        "status": "pending",
        "correlation_id": str(correlation_id),
    }
    payload = json.dumps(
        {
            "job_id": str(job_id),
            "correlation_id": str(correlation_id),
            "conversation_id": str(conversation_id),
            "user_message_id": str(user_message_id),
            "model": model,
            "owner_id": owner_id,
            "files": list(files),
        }
    )
    try:
        await redis.hset(redis_job_meta_key(str(job_id)), mapping=meta)
        await redis.expire(
            redis_job_meta_key(str(job_id)), settings.job_meta_ttl_seconds
        )
        # Lets a revisit find this job and re-attach to its stream; status filtering
        # in GET /conversations/{id}/active-job discards it once the job finishes.
        await redis.set(
            redis_conv_active_job_key(str(conversation_id)),
            str(job_id),
            ex=settings.job_meta_ttl_seconds,
        )
        await redis.rpush(settings.queue_key, payload)
    except Exception as exc:  # noqa: BLE001 — surface infra failures to the caller
        raise JobEnqueueError(str(exc)) from exc


# Claim the conversation's "a job is running" slot atomically. A read-then-write in
# the router leaves a window where two retries both see an idle conversation and both
# enqueue; doing the check and the set in one Lua call closes it, because Redis runs
# the script without interleaving other commands.
_CLAIM_SLOT_LUA = """
local current = redis.call('GET', KEYS[1])
if current then
  local meta_key = ARGV[4] .. current
  local status = redis.call('HGET', meta_key, 'status')
  local conversation = redis.call('HGET', meta_key, 'conversation_id')
  if status and conversation == ARGV[2]
     and (status == 'pending' or status == 'processing') then
    return current
  end
end
local claimed_meta = ARGV[4] .. ARGV[1]
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
-- Stamp the meta hash in the same script: the pointer alone is not enough, because a
-- second claim arriving before `enqueue_generation_job` writes the meta would read an
-- empty hash, judge the pointer stale, and claim on top of a live job.
redis.call('HSET', claimed_meta, 'status', 'pending', 'conversation_id', ARGV[2])
redis.call('EXPIRE', claimed_meta, ARGV[3])
return false
"""


async def claim_conversation_slot(
    redis: Redis,
    settings: Settings,
    *,
    conversation_id: uuid.UUID,
    job_id: uuid.UUID,
) -> str | None:
    """Reserve this conversation for `job_id`.

    Returns None when the slot was claimed, or the id of the job already running for
    this conversation. A pointer left by a finished job (or by a different
    conversation) is stale and gets overwritten — same rules as
    `GET /conversations/{id}/active-job`.

    Claiming also stamps `status=pending` on the new job's meta hash, so the claim is
    visible to a racing caller immediately rather than only once the job is enqueued.
    """
    busy = await redis.eval(
        _CLAIM_SLOT_LUA,
        1,
        redis_conv_active_job_key(str(conversation_id)),
        str(job_id),
        str(conversation_id),
        str(settings.job_meta_ttl_seconds),
        JOB_META_KEY_PREFIX,
    )
    if not busy:
        return None
    return busy.decode() if isinstance(busy, bytes) else str(busy)
