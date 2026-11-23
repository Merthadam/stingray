// SQLite storage for agent activity history (`agent_activity` table of the app database).
import { database, transaction } from './database';
import { MAX_ACTIVITY_AGE_MS, MAX_ACTIVITY_PER_WORKSPACE, recordSchema, type ActivityRecord, type HistoryRepository } from '../../../core/activity';

// Created on first use, not by a schema migration: bumping user_version would lock older builds out of the database,
// while they simply ignore an extra table.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_activity (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  terminal_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  phase TEXT NOT NULL,
  needs_review INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS agent_activity_workspace ON agent_activity(workspace_id, last_event_at);
`;

export class SqliteActivityHistory implements HistoryRepository {
  constructor(readonly directory: string, private maxPerWorkspace = MAX_ACTIVITY_PER_WORKSPACE, private maxAgeMs = MAX_ACTIVITY_AGE_MS) {}

  /** Retained records, newest first. Invalid rows are skipped (and dropped by the next save); an unreadable database yields none. */
  load(now = Date.now()): ActivityRecord[] {
    try {
      const db = this.db();
      transaction(db, () => this.prune(db, now));
      const rows = db.prepare(`SELECT id, workspace_id, terminal_id, harness, phase, needs_review, started_at, last_event_at, completed_at
        FROM agent_activity ORDER BY last_event_at DESC, id`).all() as Record<string, unknown>[];
      return rows.flatMap(r => {
        const parsed = recordSchema.safeParse({ id: r.id, workspaceId: r.workspace_id, terminalId: r.terminal_id, harness: r.harness, phase: r.phase,
          needsReview: r.needs_review === 1 ? true : r.needs_review === 0 ? false : null, startedAt: r.started_at, lastEventAt: r.last_event_at, completedAt: r.completed_at });
        return parsed.success ? [parsed.data] : [];
      });
    } catch { return []; }
  }

  /** Replace all records with `records` in one transaction; invalid records and records of unknown workspaces are dropped. */
  save(records: ActivityRecord[], now = Date.now()) {
    const db = this.db();
    transaction(db, () => {
      db.exec('DELETE FROM agent_activity');
      const insert = db.prepare(`INSERT INTO agent_activity (id, workspace_id, terminal_id, harness, phase, needs_review, started_at, last_event_at, completed_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?)`);
      for (const record of records) {
        const parsed = recordSchema.safeParse(record);
        if (!parsed.success) continue;
        const r = parsed.data;
        insert.run(r.id, r.workspaceId, r.terminalId, r.harness, r.phase, r.needsReview ? 1 : 0, r.startedAt, r.lastEventAt, r.completedAt, r.workspaceId);
      }
      this.prune(db, now);
    });
  }

  private db() {
    const db = database(this.directory);
    db.exec(SCHEMA);
    return db;
  }

  private prune(db: ReturnType<typeof database>, now: number) {
    db.prepare('DELETE FROM agent_activity WHERE last_event_at < ?').run(now - this.maxAgeMs);
    db.prepare(`DELETE FROM agent_activity WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER
      (PARTITION BY workspace_id ORDER BY needs_review DESC, last_event_at DESC, id) AS n FROM agent_activity) WHERE n > ?)`).run(this.maxPerWorkspace);
  }
}
