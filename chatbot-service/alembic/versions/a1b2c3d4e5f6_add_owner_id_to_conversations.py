"""add owner_id to conversations

Revision ID: a1b2c3d4e5f6
Revises: 67594ea08441
Create Date: 2026-05-05 00:00:00.000000

Adds the owner_id column that the api-gateway populates via the X-Owner-ID header.
Existing rows get an empty string — they will not appear in any user's conversation
list until they are re-created through the gateway.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "67594ea08441"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column(
            "owner_id",
            sa.String(length=128),
            server_default=sa.text("''"),
            nullable=False,
        ),
    )
    op.create_index(
        op.f("ix_conversations_owner_id"),
        "conversations",
        ["owner_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_conversations_owner_id"), table_name="conversations")
    op.drop_column("conversations", "owner_id")
