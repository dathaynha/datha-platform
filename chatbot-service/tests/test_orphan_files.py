"""Orphan file_id resolution for conversation delete (platform/chatbot-file-events.md)."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.orphan_files import list_orphan_file_ids_for_conversation

from tests.conftest import add_conversation, add_message, attach_file

OWNER = "google_sub_1"
OTHER_OWNER = "google_sub_2"


async def _orphans(
    session: AsyncSession,
    conversation_id: uuid.UUID,
    *,
    owner_id: str = OWNER,
) -> list[uuid.UUID]:
    return await list_orphan_file_ids_for_conversation(
        session,
        conversation_id=conversation_id,
        owner_id=owner_id,
    )


async def test_empty_conversation_returns_no_orphans(db_session: AsyncSession) -> None:
    conv = await add_conversation(db_session, owner_id=OWNER)
    await add_message(db_session, conversation_id=conv.id)

    assert await _orphans(db_session, conv.id) == []


async def test_conversation_with_files_all_orphan(db_session: AsyncSession) -> None:
    conv = await add_conversation(db_session, owner_id=OWNER)
    msg = await add_message(db_session, conversation_id=conv.id)
    f1, f2 = uuid.uuid4(), uuid.uuid4()
    await attach_file(db_session, message_id=msg.id, file_id=f1)
    await attach_file(db_session, message_id=msg.id, file_id=f2)

    result = await _orphans(db_session, conv.id)
    assert set(result) == {f1, f2}


async def test_shared_file_excluded_when_referenced_in_other_conversation(
    db_session: AsyncSession,
) -> None:
    conv_a = await add_conversation(db_session, owner_id=OWNER)
    conv_b = await add_conversation(db_session, owner_id=OWNER)
    msg_a = await add_message(db_session, conversation_id=conv_a.id)
    msg_b = await add_message(db_session, conversation_id=conv_b.id)

    shared = uuid.uuid4()
    orphan_only = uuid.uuid4()
    await attach_file(db_session, message_id=msg_a.id, file_id=shared)
    await attach_file(db_session, message_id=msg_a.id, file_id=orphan_only)
    await attach_file(db_session, message_id=msg_b.id, file_id=shared)

    result = await _orphans(db_session, conv_a.id)
    assert result == [orphan_only]


async def test_other_owner_conversation_does_not_block_orphan(
    db_session: AsyncSession,
) -> None:
    conv_a = await add_conversation(db_session, owner_id=OWNER)
    conv_b = await add_conversation(db_session, owner_id=OTHER_OWNER)
    msg_a = await add_message(db_session, conversation_id=conv_a.id)
    msg_b = await add_message(db_session, conversation_id=conv_b.id)

    same_file = uuid.uuid4()
    await attach_file(db_session, message_id=msg_a.id, file_id=same_file)
    await attach_file(db_session, message_id=msg_b.id, file_id=same_file)

    result = await _orphans(db_session, conv_a.id, owner_id=OWNER)
    assert result == [same_file]


async def test_duplicate_file_on_same_conversation_deduped(
    db_session: AsyncSession,
) -> None:
    conv = await add_conversation(db_session, owner_id=OWNER)
    msg1 = await add_message(db_session, conversation_id=conv.id)
    msg2 = await add_message(db_session, conversation_id=conv.id)
    fid = uuid.uuid4()
    await attach_file(db_session, message_id=msg1.id, file_id=fid)
    await attach_file(db_session, message_id=msg2.id, file_id=fid)

    result = await _orphans(db_session, conv.id)
    assert result == [fid]


async def test_target_conversation_with_no_files_returns_empty(
    db_session: AsyncSession,
) -> None:
    conv_a = await add_conversation(db_session, owner_id=OWNER)
    conv_b = await add_conversation(db_session, owner_id=OWNER)
    msg_b = await add_message(db_session, conversation_id=conv_b.id)
    await attach_file(db_session, message_id=msg_b.id, file_id=uuid.uuid4())
    await add_message(db_session, conversation_id=conv_a.id)

    assert await _orphans(db_session, conv_a.id) == []


async def test_all_files_shared_returns_empty(db_session: AsyncSession) -> None:
    conv_a = await add_conversation(db_session, owner_id=OWNER)
    conv_b = await add_conversation(db_session, owner_id=OWNER)
    msg_a = await add_message(db_session, conversation_id=conv_a.id)
    msg_b = await add_message(db_session, conversation_id=conv_b.id)

    f1, f2 = uuid.uuid4(), uuid.uuid4()
    await attach_file(db_session, message_id=msg_a.id, file_id=f1)
    await attach_file(db_session, message_id=msg_a.id, file_id=f2)
    await attach_file(db_session, message_id=msg_b.id, file_id=f1)
    await attach_file(db_session, message_id=msg_b.id, file_id=f2)

    assert await _orphans(db_session, conv_a.id) == []


async def test_unknown_conversation_returns_empty(db_session: AsyncSession) -> None:
    assert await _orphans(db_session, uuid.uuid4()) == []
