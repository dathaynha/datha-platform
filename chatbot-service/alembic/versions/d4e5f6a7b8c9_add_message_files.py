"""add message_files table

Revision ID: d4e5f6a7b8c9
Revises: a1b2c3d4e5f6
Create Date: 2026-05-07 00:00:00.000000

Associates uploaded files with user messages. Stores only the file_id UUID
reference — no cross-service foreign keys. name/mime_type are denormalized at
attach-time so the message list endpoint never needs to call file-service.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "message_files",
        sa.Column("message_id", UUID(as_uuid=True), nullable=False),
        sa.Column("file_id", UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("mime_type", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["messages.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("message_id", "file_id"),
    )


def downgrade() -> None:
    op.drop_table("message_files")
