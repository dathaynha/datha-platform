"""add generation error columns on messages

Revision ID: f1e2d3c4b5a6
Revises: d4e5f6a7b8c9
Create Date: 2026-05-07 12:00:00.000000

Stores normalized assistant-generation failures so thread history and ops can
see user-facing summaries without relying on Redis stream TTL alone.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "f1e2d3c4b5a6"
down_revision: Union[str, Sequence[str], None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("generation_error_code", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("generation_error_summary", sa.Text(), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("generation_error_detail", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "generation_error_detail")
    op.drop_column("messages", "generation_error_summary")
    op.drop_column("messages", "generation_error_code")
