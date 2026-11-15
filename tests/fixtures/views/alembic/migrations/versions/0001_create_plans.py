"""create plans

Revision ID: 0001
Revises:
Create Date: 2026-01-01
"""
import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None


def upgrade() -> None:
    op.create_table(
        "plans",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("title", sa.String(255), nullable=False),
    )
    op.create_index(op.f("ix_plans_title"), "plans", ["title"])


def downgrade() -> None:
    op.drop_index(op.f("ix_plans_title"), table_name="plans")
    op.drop_table("plans")
