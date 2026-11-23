// Stingray's app state in one SQLite database, <userData>/stingray.db (node:sqlite: built into Node/Electron, no native
// module). Small, single-writer data (requestSingleInstanceLock); calls are synchronous and each change is one transaction.
// Schema changes are ordered MIGRATIONS tracked in PRAGMA user_version. Migration 1 also imports the JSON files used
// before (workspaces.json, view-state.json, editor.json) and renames them to *.migrated; it rolls back as a whole on error.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { stateSchema } from '../shared/contracts/git';
import { viewLocalStateSchema } from '../shared/contracts/views';

export const DATABASE_FILE = 'stingray.db';
export const STORAGE_ERROR = 'Workspace storage could not be read. Your saved file was not overwritten. Restore a valid workspaces.json to continue.';

const legacyViewStateSchema = z.strictObject({
  version: z.literal(1),
  views: z.record(z.string().max(400), z.strictObject({ updatedAt: z.number(), state: viewLocalStateSchema })),
});

// Never edit a shipped schema: add SCHEMA_V2 with a new migration.
const SCHEMA_V1 = `
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  position INTEGER NOT NULL
) STRICT;
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  managed INTEGER NOT NULL CHECK (managed IN (0, 1)),
  preview_url TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL
) STRICT;
CREATE TABLE view_state (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  view_id TEXT NOT NULL,
  hidden TEXT NOT NULL, -- hidden, positions and expanded are JSON, always read whole
  positions TEXT NOT NULL,
  expanded TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, view_id)
) STRICT;
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE INDEX workspaces_repo ON workspaces(repo_id);
`;

type Migration = (db: DatabaseSync, directory: string, imported: string[]) => void;
const MIGRATIONS: Migration[] = [
  (db, directory, imported) => {
    db.exec(SCHEMA_V1);
    importLegacyJson(db, directory, imported);
  },
];

const open = new Map<string, DatabaseSync>();

/** The database in `directory`, created and migrated on first use; one connection per directory per process. */
export function database(directory: string): DatabaseSync {
  const file = path.resolve(directory, DATABASE_FILE);
  const existing = open.get(file);
  if (existing) return existing;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
    migrate(db, path.dirname(file));
  } catch (error) { db.close(); throw error; }
  open.set(file, db);
  return db;
}

/** Close the connection for `directory` (tests, app quit). */
export function closeDatabase(directory: string) {
  const file = path.resolve(directory, DATABASE_FILE);
  open.get(file)?.close();
  open.delete(file);
}

/** Run `action` in a transaction (BEGIN IMMEDIATE); rolls back and rethrows on error. */
export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function migrate(db: DatabaseSync, directory: string) {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version > MIGRATIONS.length) throw new Error('This data was written by a newer Stingray. Update Stingray to continue.');
  const imported: string[] = [];
  for (let v = version; v < MIGRATIONS.length; v++) {
    transaction(db, () => { MIGRATIONS[v]!(db, directory, imported); db.exec(`PRAGMA user_version = ${v + 1}`); });
  }
  // Only after the import committed: keep the old files next to the database for inspection and rollback.
  for (const file of imported) { try { renameSync(file, file + '.migrated'); } catch { /* already gone */ } }
}

function readJson(file: string): unknown | undefined {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(raw);
}

function importLegacyJson(db: DatabaseSync, directory: string, imported: string[]) {
  const workspacesFile = path.join(directory, 'workspaces.json');
  if (existsSync(workspacesFile)) {
    let state;
    try { state = stateSchema.parse(readJson(workspacesFile)); } catch { throw new Error(STORAGE_ERROR); }
    const repoIds = new Set(state.repos.map(r => r.id));
    // A workspace of an unknown repo cannot satisfy the foreign key; the original file is kept as workspaces.json.migrated.
    writeState(db, { ...state, workspaces: state.workspaces.filter(w => repoIds.has(w.repoId)) });
    imported.push(workspacesFile);
  }

  const viewStateFile = path.join(directory, 'view-state.json');
  if (existsSync(viewStateFile)) {
    let views: z.infer<typeof legacyViewStateSchema>['views'] = {};
    try { views = legacyViewStateSchema.parse(readJson(viewStateFile)).views; } catch { /* unreadable UI state starts empty */ }
    const insert = db.prepare(`INSERT OR REPLACE INTO view_state (workspace_id, view_id, hidden, positions, expanded, updated_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?)`);
    for (const [key, { updatedAt, state }] of Object.entries(views)) {
      const split = key.indexOf(':');
      if (split < 0) continue;
      const workspaceId = key.slice(0, split);
      insert.run(workspaceId, key.slice(split + 1), JSON.stringify(state.hidden), JSON.stringify(state.positions),
        JSON.stringify(state.expanded), Math.trunc(updatedAt), workspaceId); // views of removed worktrees are dropped
    }
    imported.push(viewStateFile);
  }

  const editorFile = path.join(directory, 'editor.json');
  if (existsSync(editorFile)) {
    try {
      const { selected } = z.object({ selected: z.string().max(40) }).parse(readJson(editorFile));
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('editor', selected);
    } catch { /* invalid setting: fall back to detection */ }
    imported.push(editorFile);
  }
}

type State = z.infer<typeof stateSchema>;

/** Replace repos and workspaces with `state`, keeping rows (and their view state) that stay. */
export function writeState(db: DatabaseSync, state: State) {
  const repo = db.prepare(`INSERT INTO repos (id, name, path, position) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path, position = excluded.position`);
  state.repos.forEach((r, i) => repo.run(r.id, r.name, r.path, i));
  const workspace = db.prepare(`INSERT INTO workspaces (id, repo_id, name, branch, path, managed, preview_url, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET repo_id = excluded.repo_id, name = excluded.name, branch = excluded.branch,
      path = excluded.path, managed = excluded.managed, preview_url = excluded.preview_url, position = excluded.position`);
  state.workspaces.forEach((w, i) => workspace.run(w.id, w.repoId, w.name, w.branch, w.path, w.managed ? 1 : 0, w.previewUrl, i));
  const keep = (ids: string[]) => JSON.stringify(ids);
  db.prepare('DELETE FROM workspaces WHERE id NOT IN (SELECT value FROM json_each(?))').run(keep(state.workspaces.map(w => w.id)));
  db.prepare('DELETE FROM repos WHERE id NOT IN (SELECT value FROM json_each(?))').run(keep(state.repos.map(r => r.id)));
}

export function readState(db: DatabaseSync): State {
  const repos = db.prepare('SELECT id, name, path FROM repos ORDER BY position, rowid').all() as { id: string; name: string; path: string }[];
  const workspaces = (db.prepare(`SELECT id, repo_id, name, branch, path, managed, preview_url FROM workspaces
    ORDER BY position, rowid`).all() as Record<string, string | number>[]).map(w => ({
    id: String(w.id), repoId: String(w.repo_id), name: String(w.name), branch: String(w.branch), path: String(w.path),
    managed: w.managed === 1, previewUrl: String(w.preview_url),
  }));
  return stateSchema.parse({ version: 1, repos: repos.map(r => ({ ...r })), workspaces });
}
