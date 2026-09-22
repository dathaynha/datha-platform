from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Optional

from sqlalchemy import ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.message import Message


class MessageFile(Base):
    __tablename__ = "message_files"

    message_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("messages.id", ondelete="CASCADE"),
        primary_key=True,
    )
    file_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
    )
    # Denormalized at attach-time so the message list endpoint never calls file-service.
    name: Mapped[str] = mapped_column(Text, nullable=False)
    mime_type: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    message: Mapped[Message] = relationship(back_populates="files")
