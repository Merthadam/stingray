// Every side effect of removing a workspace, as WorkspaceLifecycle listeners (rule 3). Blocking: terminals and the
// code-graph release only. afterRemove order: git-state, view state, activity, repo map, overlay, webview session (last, audit 20).
import type { WorkspaceLifecycle } from '../core/git';
import { releaseWorkspace, type GraphReleaseHost } from '../core/stinggraph';

export interface RemovalParticipants {
  terminals: { closeWorkspace(id: string): void };
  views: { release(id: string): Promise<void>; reopen(id: string): void };
  graph: GraphReleaseHost;
  gitState: { forget(id: string): void };
  viewState: { forget(id: string): Promise<void> };
  activity: { forgetWorkspace(id: string): void };
  repoMap: { forget(id: string): void };
  overlays: { repoOf(id: string): Promise<string | undefined>; remove(repoId: string, id: string): Promise<void> };
  sessions: { clearWorkspaceSession(id: string): Promise<void> };
}

export function registerRemovalListeners(lifecycle: WorkspaceLifecycle, p: RemovalParticipants) {
  const overlayRepos = new Map<string, string>(); // repoId captured while the registration still exists
  lifecycle.onBeforeRemove('terminals', id => p.terminals.closeWorkspace(id), { blocking: true });
  lifecycle.onBeforeRemove('views', id => p.views.release(id));
  lifecycle.onBeforeRemove('stinggraph', id => releaseWorkspace(p.graph, id), { blocking: true });
  lifecycle.onBeforeRemove('stinggraph overlay', async id => { const repoId = await p.overlays.repoOf(id); if (repoId) overlayRepos.set(id, repoId); });
  lifecycle.onRemoveFailed('views', id => p.views.reopen(id));
  lifecycle.onRemoveFailed('stinggraph overlay', id => { overlayRepos.delete(id); });
  lifecycle.onAfterRemove('git-state', id => p.gitState.forget(id));
  lifecycle.onAfterRemove('view state', id => p.viewState.forget(id));
  lifecycle.onAfterRemove('activity', id => p.activity.forgetWorkspace(id));
  lifecycle.onAfterRemove('repo map', id => p.repoMap.forget(id));
  lifecycle.onAfterRemove('stinggraph overlay', async id => { const repoId = overlayRepos.get(id); overlayRepos.delete(id); if (repoId) await p.overlays.remove(repoId, id); });
  lifecycle.onAfterRemove('webview session', id => p.sessions.clearWorkspaceSession(id));
}
