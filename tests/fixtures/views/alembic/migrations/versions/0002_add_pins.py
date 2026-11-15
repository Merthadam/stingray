"""Add destination pins"""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"


def upgrade() -> None:
    op.create_table("destination_pins", sa.Column("id", sa.Uuid(), primary_key=True), sa.Column("plan_id", sa.Uuid()))
    op.create_foreign_key("fk_pins_plan", "destination_pins", "plans", ["plan_id"], ["id"])
    op.add_column("plans", sa.Column("budget", sa.Numeric(10, 2)))


def downgrade() -> None:
    op.drop_column("plans", "budget")
    op.drop_table("destination_pins")
