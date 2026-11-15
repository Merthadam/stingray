"""Merge heads"""
from alembic import op

revision = "0004"
down_revision = ("0002", "0003")


def upgrade() -> None:
    op.alter_column("plans", "title", nullable=True)
    op.execute("UPDATE plans SET title = 'Untitled' WHERE title IS NULL")


def downgrade() -> None:
    op.alter_column("plans", "title", nullable=False)
