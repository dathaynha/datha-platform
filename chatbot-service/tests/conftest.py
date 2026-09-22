"""Shared pytest fixtures — in-memory SQLite (no Postgres required)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import pytest
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles

from app.db.base import Base
from app.models.conversation import Conversation  # noqa: F401 — register metadata
from app.models.message import Message  # noqa: F401
from app.models.message_file import MessageFile  # noqa: F401


@compiles(UUID, "sqlite")
def _compile_uuid_sqlite(type_: UUID, compiler, **kw: object) -> str:
    return "CHAR(36)"


@pytest.fixture
async def db_session() -> AsyncIterator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    def _create_tables(sync_conn) -> None:
        # Conversation defines owner_id index twice (column index=True + __table_args__);
        # SQLite create_all fails on the duplicate name.
        table = Conversation.__table__
        owner_indexes = [
            idx for idx in table.indexes if "owner_id" in {c.name for c in idx.columns}
        ]
        while len(owner_indexes) > 1:
            table.indexes.discard(owner_indexes.pop())
        Base.metadata.create_all(
            sync_conn,
            tables=[Conversation.__table__, Message.__table__, MessageFile.__table__],
        )

    async with engine.begin() as conn:
        await conn.run_sync(_create_tables)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session

    await engine.dispose()


async def add_conversation(session: AsyncSession, *, owner_id: str) -> Conversation:
    conv = Conversation(owner_id=owner_id, title="test")
    session.add(conv)
    await session.flush()
    return conv


async def add_message(session: AsyncSession, *, conversation_id: uuid.UUID) -> Message:
    msg = Message(conversation_id=conversation_id, role="user", content="hello")
    session.add(msg)
    await session.flush()
    return msg


async def attach_file(
    session: AsyncSession,
    *,
    message_id: uuid.UUID,
    file_id: uuid.UUID,
    name: str = "doc.pdf",
) -> MessageFile:
    row = MessageFile(message_id=message_id, file_id=file_id, name=name)
    session.add(row)
    await session.flush()
    return row
