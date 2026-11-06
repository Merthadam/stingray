import type { State } from './shared';

export type ProjectSelection = { repoId: string; workspaceId: string } | null;
export const navigationKey = 'stingray-navigation-v1';

export function parseSelection(raw: string | null): ProjectSelection {
  try {
    const value = JSON.parse(raw || 'null');
    return value && typeof value.repoId === 'string' && typeof value.workspaceId === 'string'
      ? { repoId: value.repoId, workspaceId: value.workspaceId } : null;
  } catch { return null; }
}

// A missing/deleted workspace may fall back only within its own project.
export function resolveSelection(state: State, selection: ProjectSelection): ProjectSelection {
  if (!selection || !state.repos.some(repo => repo.id === selection.repoId)) return null;
  const workspaces = state.workspaces.filter(w => w.repoId === selection.repoId);
  const workspace = workspaces.find(w => w.id === selection.workspaceId)
    ?? workspaces.find(w => !w.managed) ?? workspaces[0];
  return workspace ? { repoId: selection.repoId, workspaceId: workspace.id } : null;
}
