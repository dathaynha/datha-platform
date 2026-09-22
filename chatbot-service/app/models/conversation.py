from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Index, String, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.message import Message


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # Prefixed owner identifier set by the api-gateway (e.g. "google_<sub>", "entra_<oid>").
    # Populated by the gateway via X-Owner-ID header; never set by clients directly.
    owner_id: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        default="",
        server_default=text("''"),
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    title: Mapped[str] = mapped_column(
        String(200),
        nullable=False,
        default="",
        server_default=text("''"),
    )

    messages: Mapped[list[Message]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan"
    )

    __table_args__ = (Index("ix_conversations_owner_id", "owner_id"),)
