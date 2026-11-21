import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import type { WorkspaceGitState } from './shared';

// Renderer mirror of the main process's per-workspace Git state. Sidebar rows, the selected
// workspace and Repo Map all read this one store, fed by 'git-state-changed' events.
const states = new Map<string, WorkspaceGitState>();
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;
function publish(state: WorkspaceGitState) {
  const current = states.get(state.workspaceId);
  if (current && current.revision > state.revision) return;
  states.set(state.workspaceId, state);
  listeners.forEach(listener => listener());
}
const failed = (workspaceId: string, error: unknown): WorkspaceGitState =>
  ({ workspaceId, revision: 0, status: null, pr: null, error: (error as Error).message || 'Git is unavailable for this workspace. Retry after checking repository access.' });
function subscribe(listener: () => void) {
  unsubscribe ??= api.onGitStateChanged(publish);
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useGitState(workspaceId: string) {
  const state = useSyncExternalStore(subscribe, () => states.get(workspaceId) ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!workspaceId) return;
    api.gitState(workspaceId).then(publish, error => { if (!states.has(workspaceId)) publish(failed(workspaceId, error)); });
  }, [workspaceId]);
  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setBusy(true);
    try { publish(await api.refreshGitState(workspaceId)); } catch (error) { publish({ ...failed(workspaceId, error), revision: states.get(workspaceId)?.revision ?? 0 }); }
    finally { setBusy(false); }
  }, [workspaceId]);
  return { state, busy: busy || !state, refresh };
}
