from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class ConversationSummaryOut(BaseModel):
    """One row for the conversation list (sidebar / picker)."""

    id: uuid.UUID
    created_at: datetime
    title: str = ""
    message_count: int = Field(ge=0)
    last_message_at: Optional[datetime] = None


class ConversationTitlePatch(BaseModel):
    title: str = Field(default="", max_length=200)


class ConversationTitleOut(BaseModel):
    id: uuid.UUID
    title: str = ""


class FileAttachOut(BaseModel):
    """File attachment metadata returned alongside a message."""

    model_config = ConfigDict(from_attributes=True)

    file_id: uuid.UUID
    name: str
    mime_type: Optional[str] = None


class MessageOut(BaseModel):
    """A persisted chat turn."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    conversation_id: uuid.UUID
    role: str
    content: str
    generation_error_code: Optional[str] = None
    generation_error_summary: Optional[str] = None
    generation_error_detail: Optional[str] = None
    created_at: datetime
    files: list[FileAttachOut] = []


class MessagesPageOut(BaseModel):
    """Paginated messages for a conversation (chronological within `messages`)."""

    messages: list[MessageOut]
    has_more: bool = Field(description="True when older rows exist before this page.")


class ActiveJobOut(BaseModel):
    """A still-running generation job for a conversation, for stream re-attach."""

    job_id: uuid.UUID
    user_message_id: uuid.UUID
    status: str = Field(
        description="pending (queued) or processing (worker claimed it)."
    )
