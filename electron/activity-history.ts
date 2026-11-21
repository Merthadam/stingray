// Agent activity metadata kept across app restarts, in the `agent_activity` table of the app database. Only
// renderer-safe metadata: never tokens, sockets, prompts or output. Rows go with their workspace (ON DELETE CASCADE).
import { z } from 'zod';
import { database, transaction } from './database';

export const MAX_ACTIVITY_PER_WORKSPACE = 20, MAX_ACTIVITY_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const recordSchema = z.strictObject({
  id: z.string().uuid(), workspaceId: z.string().uuid(), terminalId: z.string().uuid(),
  harness: z.enum(['pi', 'claude', 'codex']),
  phase: z.enum(['idle', 'working', 'waiting', 'failed', 'interrupted', 'unknown']),
  needsReview: z.boolean(), startedAt: time, lastEventAt: time, completedAt: time.nullable(),
});
export type ActivityRecord = z.infer<typeof recordSchema>;

export class ActivityHistory {
  constructor(readonly directory: string, private maxPerWorkspace = MAX_ACTIVITY_PER_WORKSPACE, private maxAgeMs = MAX_ACTIVITY_AGE_MS) {}

  /** Retained records, newest first. Invalid rows are skipped (and dropped by the next save); an unreadable database yields none. */
  load(now = Date.now()): ActivityRecord[] {
    try {
      const db = database(this.directory);
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

  /** Replace all records with `records` in one transaction; records of unknown workspaces are dropped. */
  save(records: ActivityRecord[], now = Date.now()) {
    const db = database(this.directory);
    transaction(db, () => {
      db.exec('DELETE FROM agent_activity');
      const insert = db.prepare(`INSERT INTO agent_activity (id, workspace_id, terminal_id, harness, phase, needs_review, started_at, last_event_at, completed_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?)`);
      for (const record of records) {
        const r = recordSchema.parse(record);
        insert.run(r.id, r.workspaceId, r.terminalId, r.harness, r.phase, r.needsReview ? 1 : 0, r.startedAt, r.lastEventAt, r.completedAt, r.workspaceId);
      }
      this.prune(db, now);
    });
  }

  private prune(db: ReturnType<typeof database>, now: number) {
    db.prepare('DELETE FROM agent_activity WHERE last_event_at < ?').run(now - this.maxAgeMs);
    db.prepare(`DELETE FROM agent_activity WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER
      (PARTITION BY workspace_id ORDER BY last_event_at DESC, id) AS n FROM agent_activity) WHERE n > ?)`).run(this.maxPerWorkspace);
  }
}
