"""Orphan file_id resolution for conversation delete (platform/chatbot-file-events.md)."""

from __future__ import annotations

import uuid

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.conversation import Conversation
from app.models.message import Message
from app.models.message_file import MessageFile


async def list_orphan_file_ids_for_conversation(
    session: AsyncSession,
    *,
    conversation_id: uuid.UUID,
    owner_id: str,
) -> list[uuid.UUID]:
    """file_ids on this conversation not referenced by any other conversation for owner."""
    mf = MessageFile
    mf_other = aliased(MessageFile)
    m_other = aliased(Message)

    referenced_elsewhere = exists(
        select(1)
        .select_from(mf_other)
        .join(m_other, m_other.id == mf_other.message_id)
        .join(Conversation, Conversation.id == m_other.conversation_id)
        .where(
            mf_other.file_id == mf.file_id,
            Conversation.owner_id == owner_id,
            m_other.conversation_id != conversation_id,
        )
    )

    stmt = (
        select(mf.file_id)
        .distinct()
        .join(Message, Message.id == mf.message_id)
        .where(
            Message.conversation_id == conversation_id,
            ~referenced_elsewhere,
        )
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())
