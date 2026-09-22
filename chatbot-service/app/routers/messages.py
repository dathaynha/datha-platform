"""POST /messages (persist + enqueue) and GET /stream/{job_id} (SSE via Redis pub/sub)."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Annotated, Any, AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import (
    get_settings,
    redis_job_meta_key,
    redis_stream_key,
)
from app.db.session import AsyncSessionLocal, get_session
from app.dependencies.identity import get_owner_id
from app.dependencies.redis import get_redis_client
from app.models.conversation import Conversation
from app.models.message import Message
from app.models.message_file import MessageFile
from app.schemas.messages import MessageCreate, MessageJobResponse
from app.services.chat_models import resolve_requested_model
from app.services.events import publish_message_sent
from app.services.job_enqueue import (
    JobEnqueueError,
    JobFileRef,
    enqueue_generation_job,
)

router = APIRouter(tags=["messages"])
logger = logging.getLogger(__name__)


@router.post("/messages", response_model=MessageJobResponse)
async def post_message(
    request: Request,
    body: MessageCreate,
    session: Annotated[AsyncSession, Depends(get_session)],
    redis: Annotated[Redis, Depends(get_redis_client)],
    owner_id: Annotated[str, Depends(get_owner_id)],
) -> MessageJobResponse:
    settings = get_settings()
    try:
        model = resolve_requested_model(settings, body.model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")

    job_id = uuid.uuid4()
    correlation_id = job_id

    if body.conversation_id is not None:
        conv = await session.get(Conversation, body.conversation_id)
        if conv is None or conv.owner_id != owner_id:
            raise HTTPException(status_code=404, detail="conversation not found")
    else:
        conv = Conversation(owner_id=owner_id)
        session.add(conv)
        await session.flush()

    user_msg = Message(
        conversation_id=conv.id,
        role="user",
        content=text,
    )
    session.add(user_msg)
    await session.flush()

    for f in body.files:
        session.add(
            MessageFile(
                message_id=user_msg.id,
                file_id=f.file_id,
                name=f.name,
                mime_type=f.mime_type,
            )
        )

    await session.commit()

    try:
        async with AsyncSessionLocal() as pub_session:
            await publish_message_sent(
                pub_session,
                request.app.state.js,
                message_id=user_msg.id,
                conversation_id=conv.id,
                owner_id=owner_id,
                correlation_id=str(correlation_id),
                role="user",
                model=model,
            )
    except Exception:
        logger.exception("failed to publish or enqueue chatbot.message.sent (user)")

    files: list[JobFileRef] = [
        {
            "file_id": str(f.file_id),
            "name": f.name,
            "mime_type": f.mime_type,
        }
        for f in body.files
    ]
    try:
        await enqueue_generation_job(
            redis,
            settings,
            job_id=job_id,
            correlation_id=correlation_id,
            conversation_id=conv.id,
            user_message_id=user_msg.id,
            model=model,
            owner_id=owner_id,
            files=files,
        )
    except JobEnqueueError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Failed to enqueue job: {exc}",
        ) from exc

    return MessageJobResponse(
        job_id=job_id,
        correlation_id=correlation_id,
        conversation_id=conv.id,
        user_message_id=user_msg.id,
    )


async def _enrich_done_sse_payload(
    job_id: uuid.UUID,
    redis: Redis,
    parsed: dict[str, Any],
) -> dict[str, Any]:
    """
    Attach latest `conversation_id` / `conversation_title` from Postgres on `done`.

    Title generation runs only in the worker; this avoids duplicate Gemini calls.
    """
    if parsed.get("type") != "done":
        return parsed

    job_key = redis_job_meta_key(str(job_id))
    meta = await redis.hgetall(job_key)
    conversation_id_str = (
        parsed.get("conversation_id") or meta.get("conversation_id") or ""
    ).strip()
    if not conversation_id_str:
        return {
            **parsed,
            "conversation_id": "",
            "conversation_title": (parsed.get("conversation_title") or "").strip(),
        }

    try:
        conversation_id = uuid.UUID(conversation_id_str)
    except ValueError:
        return {
            **parsed,
            "conversation_id": conversation_id_str,
            "conversation_title": (parsed.get("conversation_title") or "").strip(),
        }

    async with AsyncSessionLocal() as session:
        conv = await session.get(Conversation, conversation_id)
        if conv is None:
            return {
                **parsed,
                "conversation_id": conversation_id_str,
                "conversation_title": (parsed.get("conversation_title") or "").strip(),
            }

        title = (conv.title or "").strip() or (
            parsed.get("conversation_title") or ""
        ).strip()
        return {
            **parsed,
            "conversation_id": str(conv.id),
            "conversation_title": title,
        }


async def _sse_generator(
    job_id: uuid.UUID, redis: Redis, cursor: str
) -> AsyncGenerator[str, None]:
    """Yield SSE events from a Redis Stream, replaying from `cursor` on reconnect.

    Each event carries an `id:` field matching the Redis Stream entry ID so the
    browser sends `Last-Event-ID` on any reconnect — allowing seamless replay.
    """
    stream_key = redis_stream_key(str(job_id))

    while True:
        # XREAD with a 30-second blocking timeout; returns None on timeout.
        results = await redis.xread(
            streams={stream_key: cursor},
            count=50,
            block=30_000,
        )

        if not results:
            yield ": keepalive\n\n"
            continue

        for _, messages in results:
            for entry_id, fields in messages:
                cursor = entry_id if isinstance(entry_id, str) else entry_id.decode()
                raw = fields.get("data") or ""
                if isinstance(raw, bytes):
                    raw = raw.decode()

                out_line = raw
                try:
                    parsed = json.loads(raw)
                    if parsed.get("type") == "done":
                        enriched = await _enrich_done_sse_payload(job_id, redis, parsed)
                        out_line = json.dumps(enriched)
                except json.JSONDecodeError:
                    pass

                yield f"id: {cursor}\ndata: {out_line}\n\n"

                try:
                    if json.loads(out_line).get("type") in ("done", "error"):
                        return
                except json.JSONDecodeError:
                    pass


@router.get("/stream/{job_id}")
async def stream_job(
    job_id: uuid.UUID,
    request: Request,
    redis: Annotated[Redis, Depends(get_redis_client)],
) -> StreamingResponse:
    stream_key = redis_stream_key(str(job_id))
    job_key = redis_job_meta_key(str(job_id))

    if not await redis.exists(job_key) and not await redis.exists(stream_key):
        raise HTTPException(status_code=404, detail="job not found")

    # Browser sends Last-Event-ID on reconnect; resume from that entry.
    # "0" means start from the beginning of the stream.
    last_event_id = request.headers.get("last-event-id", "0")

    return StreamingResponse(
        _sse_generator(job_id, redis, last_event_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
