from __future__ import annotations

import uuid
from typing import Optional

from pydantic import BaseModel, Field


class FileAttachInput(BaseModel):
    """File reference supplied by the client when sending a message.

    The client already has name/mime_type after completing the file-service
    prepare → upload → confirm flow. We denormalize them here so the message
    list endpoint never needs to call file-service.
    """

    file_id: uuid.UUID
    name: str = Field(min_length=1, max_length=512)
    mime_type: Optional[str] = Field(default=None, max_length=128)


class MessageCreate(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)
    conversation_id: Optional[uuid.UUID] = None
    # Empty means "server default" (`chat_default_model`); a pinned literal here would
    # silently win over that setting.
    model: str = Field(default="", max_length=128)
    files: list[FileAttachInput] = Field(default_factory=list, max_length=10)


class MessageJobResponse(BaseModel):
    job_id: uuid.UUID
    correlation_id: uuid.UUID
    conversation_id: uuid.UUID
    user_message_id: uuid.UUID


class RetryLastRequest(BaseModel):
    """Body for `POST /conversations/{id}/retry-last` (all fields optional)."""

    # Same contract as MessageCreate.model: empty means the server default.
    model: str = Field(default="", max_length=128)
