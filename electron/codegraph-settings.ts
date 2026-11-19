// The codegraph.sharedBase setting (off by default) in the app database's settings table, and the worktrees it applies to.
import { database, readState } from './database';
import type { SharedBaseTarget } from './codegraph-overlay';

export const SHARED_BASE_SETTING = 'codegraph.sharedBase';

export function sharedBaseEnabled(directory: string): boolean {
  const row = database(directory).prepare('SELECT value FROM settings WHERE key = ?').get(SHARED_BASE_SETTING) as { value: string } | undefined;
  return row?.value === 'on';
}

export function setSharedBase(directory: string, enabled: boolean) {
  database(directory).prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(SHARED_BASE_SETTING, enabled ? 'on' : 'off');
  return { sharedBase: sharedBaseEnabled(directory) };
}

/** The shared base for a Stingray-managed worktree when the setting is on; null means its own full index. */
export function sharedBaseTarget(directory: string, workspaceId: string): SharedBaseTarget | null {
  if (!sharedBaseEnabled(directory)) return null;
  const state = readState(database(directory));
  const workspace = state.workspaces.find(w => w.id === workspaceId);
  const repo = workspace?.managed ? state.repos.find(r => r.id === workspace.repoId) : undefined;
  return repo ? { repoId: repo.id, repoPath: repo.path, dataDir: directory } : null;
}

/** The managed worktrees sharing `workspaceId`'s base, itself included. */
export function sharedBaseWorkspaces(directory: string, workspaceId: string): { target: SharedBaseTarget; workspaceIds: string[] } | null {
  const target = sharedBaseTarget(directory, workspaceId);
  if (!target) return null;
  const ids = readState(database(directory)).workspaces.filter(w => w.managed && w.repoId === target.repoId).map(w => w.id);
  return { target, workspaceIds: ids };
}
