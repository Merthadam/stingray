"""Add conversations"""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0001"


def upgrade() -> None:
    op.create_table("conversations", sa.Column("id", sa.Uuid(), primary_key=True))


def downgrade() -> None:
    op.drop_table("conversations")
