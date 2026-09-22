"""Chat history: list conversations and messages for a thread."""

from __future__ import annotations

import logging
import uuid
from typing import Annotated, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request
from fastapi.responses import Response
from redis.asyncio import Redis
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import (
    get_settings,
    redis_conv_active_job_key,
    redis_job_meta_key,
)
from app.db.session import AsyncSessionLocal, get_session
from app.dependencies.identity import get_owner_id
from app.dependencies.redis import get_redis_client
from app.models.conversation import Conversation
from app.models.message import Message
from app.models.message_file import MessageFile
from app.schemas.conversations import (
    ActiveJobOut,
    ConversationSummaryOut,
    ConversationTitleOut,
    ConversationTitlePatch,
    MessageOut,
    MessagesPageOut,
)
from app.schemas.messages import MessageJobResponse, RetryLastRequest
from app.services.chat_models import resolve_requested_model
from app.services.events import publish_conversation_deleted
from app.services.job_enqueue import (
    JobEnqueueError,
    JobFileRef,
    claim_conversation_slot,
    enqueue_generation_job,
)
from app.services.orphan_files import list_orphan_file_ids_for_conversation

logger = logging.getLogger(__name__)

router = APIRouter(tags=["conversations"])


@router.get("/conversations", response_model=list[ConversationSummaryOut])
async def list_conversations(
    session: Annotated[AsyncSession, Depends(get_session)],
    owner_id: Annotated[str, Depends(get_owner_id)],
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[ConversationSummaryOut]:
    """Newest activity first (by latest message time, then conversation creation).

    Uses an aggregate subquery on ``messages`` then joins to ``conversations``, so we
    avoid ``conversation ⋈ message`` expansion before ``GROUP BY`` (which was O(rows)
    on large histories).
    """
    msg_agg = (
        select(
            Message.conversation_id.label("conversation_id"),
            func.count(Message.id).label("message_count"),
            func.max(Message.created_at).label("last_message_at"),
        )
        .group_by(Message.conversation_id)
        .subquery()
    )

    stmt = (
        select(
            Conversation.id,
            Conversation.created_at,
            Conversation.title,
            func.coalesce(msg_agg.c.message_count, 0).label("message_count"),
            msg_agg.c.last_message_at.label("last_message_at"),
        )
        .select_from(Conversation)
        .outerjoin(msg_agg, msg_agg.c.conversation_id == Conversation.id)
        .where(Conversation.owner_id == owner_id)
        .order_by(
            msg_agg.c.last_message_at.desc().nulls_last(),
            Conversation.created_at.desc(),
        )
        .limit(limit)
        .offset(offset)
    )
    result = await session.execute(stmt)
    rows = result.all()
    return [
        ConversationSummaryOut(
            id=row.id,
            created_at=row.created_at,
            title=row.title or "",
            message_count=int(row.message_count or 0),
            last_message_at=row.last_message_at,
        )
        for row in rows
    ]


ACTIVE_JOB_STATUSES = frozenset({"pending", "processing"})


@router.get(
    "/conversations/{conversation_id}/active-job",
    response_model=ActiveJobOut,
    responses={204: {"description": "No generation is running for this conversation."}},
)
async def get_active_job(
    conversation_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    owner_id: Annotated[str, Depends(get_owner_id)],
    redis: Annotated[Redis, Depends(get_redis_client)],
) -> ActiveJobOut | Response:
    """Return the job still generating for this conversation, so the client can re-attach.

    204 when nothing is running: no key, expired job meta, a finished/failed job, or a
    key left behind by an older job (meta must still name this conversation).
    """
    conv = await session.get(Conversation, conversation_id)
    if conv is None or conv.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="conversation not found")

    no_content = Response(status_code=204)

    job_id = await redis.get(redis_conv_active_job_key(str(conversation_id)))
    if not job_id:
        return no_content

    meta = await redis.hgetall(redis_job_meta_key(str(job_id)))
    if not meta:
        return no_content

    if (meta.get("status") or "") not in ACTIVE_JOB_STATUSES:
        return no_content

    if (meta.get("conversation_id") or "") != str(conversation_id):
        return no_content

    user_message_id = (meta.get("user_message_id") or "").strip()
    if not user_message_id:
        return no_content

    try:
        return ActiveJobOut(
            job_id=uuid.UUID(str(job_id)),
            user_message_id=uuid.UUID(user_message_id),
            status=meta["status"],
        )
    except ValueError:
        return no_content


@router.post(
    "/conversations/{conversation_id}/retry-last",
    response_model=MessageJobResponse,
)
async def retry_last_generation(
    conversation_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    owner_id: Annotated[str, Depends(get_owner_id)],
    redis: Annotated[Redis, Depends(get_redis_client)],
    body: Optional[RetryLastRequest] = None,
) -> MessageJobResponse:
    """Re-run generation for the last user turn — no second user message is created.

    Retryable when the newest row is a failed assistant reply (deleted here so history
    keeps no dead bubble) or a user message that never got one (the worker died before
    persisting). 409 while a job for this conversation is still running.
    """
    conv = await session.get(Conversation, conversation_id)
    if conv is None or conv.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="conversation not found")

    tail = (
        (
            await session.execute(
                select(Message)
                .where(Message.conversation_id == conversation_id)
                .order_by(Message.created_at.desc())
                .limit(2)
            )
        )
        .scalars()
        .all()
    )
    if not tail:
        raise HTTPException(status_code=404, detail="nothing to retry")

    last = tail[0]
    failed_reply: Optional[Message] = None
    if last.role == "assistant":
        if not last.generation_error_code:
            raise HTTPException(status_code=404, detail="last reply did not fail")
        failed_reply = last
        previous = tail[1] if len(tail) > 1 else None
        if previous is None or previous.role != "user":
            raise HTTPException(status_code=404, detail="nothing to retry")
        user_msg = previous
    elif last.role == "user":
        user_msg = last
    else:
        raise HTTPException(status_code=404, detail="nothing to retry")

    settings = get_settings()
    try:
        model = resolve_requested_model(settings, body.model if body else "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    attachments = (
        (
            await session.execute(
                select(MessageFile).where(MessageFile.message_id == user_msg.id)
            )
        )
        .scalars()
        .all()
    )
    files: list[JobFileRef] = [
        {
            "file_id": str(f.file_id),
            "name": f.name,
            "mime_type": f.mime_type,
        }
        for f in attachments
    ]

    job_id = uuid.uuid4()
    # Atomic claim, not a read-then-check: two retries firing together would both see
    # an idle conversation and both enqueue. Whoever loses gets the 409. Placed after
    # the rejection paths so a 404/400 never leaves a pointer behind.
    if await claim_conversation_slot(
        redis, settings, conversation_id=conversation_id, job_id=job_id
    ):
        raise HTTPException(
            status_code=409,
            detail="a generation is already running for this conversation",
        )

    user_message_id = user_msg.id
    if failed_reply is not None:
        await session.delete(failed_reply)
        await session.commit()

    # The user message was already published as chatbot.message.sent on the original
    # send; re-publishing here would duplicate the event for one turn.
    try:
        await enqueue_generation_job(
            redis,
            settings,
            job_id=job_id,
            correlation_id=job_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            model=model,
            owner_id=owner_id,
            files=files,
        )
    except JobEnqueueError as exc:
        raise HTTPException(
            status_code=503, detail=f"Failed to enqueue job: {exc}"
        ) from exc

    return MessageJobResponse(
        job_id=job_id,
        correlation_id=job_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
    )


@router.delete(
    "/conversations/{conversation_id}",
    status_code=204,
)
async def delete_conversation(
    request: Request,
    conversation_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    owner_id: Annotated[str, Depends(get_owner_id)],
    correlation_id: Annotated[str | None, Header(alias="X-Correlation-ID")] = None,
) -> None:
    conv = await session.get(Conversation, conversation_id)
    if conv is None or conv.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="conversation not found")

    orphan_file_ids = await list_orphan_file_ids_for_conversation(
        session,
        conversation_id=conversation_id,
        owner_id=owner_id,
    )
    await session.delete(conv)
    await session.commit()

    try:
        async with AsyncSessionLocal() as pub_session:
            await publish_conversation_deleted(
                pub_session,
                request.app.state.js,
                conversation_id=conversation_id,
                owner_id=owner_id,
                correlation_id=correlation_id,
                file_ids=orphan_file_ids,
            )
    except Exception:
        logger.exception(
            "failed to publish or enqueue conversation.deleted "
            "(conversation already deleted)"
        )


@router.patch(
    "/conversations/{conversation_id}",
    response_model=ConversationTitleOut,
)
async def patch_conversation_title(
    conversation_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    owner_id: Annotated[str, Depends(get_owner_id)],
    body: Annotated[ConversationTitlePatch, Body()],
) -> ConversationTitleOut:
    conv = await session.get(Conversation, conversation_id)
    if conv is None or conv.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="conversation not found")
    conv.title = (body.title or "").strip()[:200]
    await session.commit()
    return ConversationTitleOut(id=conv.id, title=conv.title)


@router.get(
    "/conversations/{conversation_id}/messages",
    response_model=MessagesPageOut,
)
async def list_messages(
    conversation_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    owner_id: Annotated[str, Depends(get_owner_id)],
    limit: Annotated[int, Query(ge=1, le=100)] = 40,
    before_id: Annotated[
        Optional[uuid.UUID],
        Query(description="Return messages strictly older than this message id."),
    ] = None,
) -> MessagesPageOut:
    conv = await session.get(Conversation, conversation_id)
    if conv is None or conv.owner_id != owner_id:
        raise HTTPException(status_code=404, detail="conversation not found")

    role_filter = Message.role.in_(("user", "assistant"))
    base_where = [
        Message.conversation_id == conversation_id,
        role_filter,
    ]

    if before_id is not None:
        anchor = await session.get(Message, before_id)
        if anchor is None or anchor.conversation_id != conversation_id:
            raise HTTPException(status_code=404, detail="anchor message not found")
        older_than_anchor = or_(
            Message.created_at < anchor.created_at,
            and_(Message.created_at == anchor.created_at, Message.id < anchor.id),
        )
        base_where.append(older_than_anchor)

    id_stmt = (
        select(Message.id)
        .where(and_(*base_where))
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(limit + 1)
    )
    id_rows = (await session.execute(id_stmt)).all()
    ids_desc = [row[0] for row in id_rows]
    has_more = len(ids_desc) > limit
    ids_desc = ids_desc[:limit]

    if not ids_desc:
        return MessagesPageOut(messages=[], has_more=False)

    ids_chrono = list(reversed(ids_desc))

    stmt_msgs = (
        select(Message)
        .where(Message.id.in_(ids_chrono))
        .options(selectinload(Message.files))
    )
    fetched = (await session.scalars(stmt_msgs)).all()
    by_id = {m.id: m for m in fetched}
    ordered = [by_id[i] for i in ids_chrono if i in by_id]

    return MessagesPageOut(
        messages=[MessageOut.model_validate(m) for m in ordered],
        has_more=has_more,
    )
