// Per-user Views state (hidden nodes, positions, expansions) per worktree and view, in the `view_state` table of the
// app database. Never written to the repo. Rows go with their workspace (ON DELETE CASCADE).
import type { ViewLocalState } from '../src/views';
import { database, transaction, viewLocalStateSchema } from './database';

export { viewLocalStateSchema };
export const MAX_VIEW_STATES = 200, MAX_VIEW_STATE_BYTES = 5 * 1024 * 1024;

type Row = { hidden: string; positions: string; expanded: string };

export class ViewStateStore {
  constructor(readonly directory: string) {}

  async get(workspaceId: string, viewId: string): Promise<ViewLocalState | null> {
    const row = database(this.directory).prepare('SELECT hidden, positions, expanded FROM view_state WHERE workspace_id = ? AND view_id = ?')
      .get(workspaceId, viewId) as Row | undefined;
    if (!row) return null;
    const parsed = viewLocalStateSchema.safeParse({ hidden: JSON.parse(row.hidden), positions: JSON.parse(row.positions), expanded: JSON.parse(row.expanded) });
    return parsed.success ? parsed.data : null;
  }

  /** Saves the state of a known workspace; least recently updated views go first when over the count or size cap. */
  async set(workspaceId: string, viewId: string, state: ViewLocalState): Promise<void> {
    const parsed = viewLocalStateSchema.parse(state);
    const db = database(this.directory);
    transaction(db, () => {
      const known = db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId);
      if (!known) throw new Error('Workspace not found.');
      // REPLACE gives the row a new rowid, which orders views updated within the same millisecond.
      db.prepare(`INSERT OR REPLACE INTO view_state (workspace_id, view_id, hidden, positions, expanded, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(workspaceId, viewId, JSON.stringify(parsed.hidden), JSON.stringify(parsed.positions),
        JSON.stringify(parsed.expanded), Date.now());
      db.prepare(`DELETE FROM view_state WHERE rowid NOT IN (SELECT rowid FROM view_state ORDER BY updated_at DESC, rowid DESC LIMIT ?)`)
        .run(MAX_VIEW_STATES);
      const oldest = db.prepare('SELECT rowid FROM view_state ORDER BY updated_at, rowid LIMIT 1');
      const size = db.prepare('SELECT COALESCE(SUM(length(hidden) + length(positions) + length(expanded)), 0) AS bytes FROM view_state');
      while (Number((size.get() as { bytes: number }).bytes) > MAX_VIEW_STATE_BYTES) {
        const row = oldest.get() as { rowid: number } | undefined;
        if (!row) break;
        db.prepare('DELETE FROM view_state WHERE rowid = ?').run(row.rowid);
      }
    });
  }

  /** Drop all views of a workspace (also done by the foreign key when the workspace row goes). */
  async forget(workspaceId: string): Promise<void> {
    database(this.directory).prepare('DELETE FROM view_state WHERE workspace_id = ?').run(workspaceId);
  }
}
