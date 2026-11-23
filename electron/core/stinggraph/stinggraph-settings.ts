// The codegraph.sharedBase setting (off by default) and the worktrees it applies to.
import type { SettingsRepository } from '../shared/ports';
import type { SharedBaseTarget, StateReader } from './ports';

export const SHARED_BASE_SETTING = 'codegraph.sharedBase';
export class StinggraphSettings {
  constructor(private settings: SettingsRepository, private readState: StateReader, private dataDir: string) {}
  sharedBaseEnabled(): boolean { return this.settings.get(SHARED_BASE_SETTING) === 'on'; }
  setSharedBase(enabled: boolean) { this.settings.set(SHARED_BASE_SETTING, enabled ? 'on' : 'off'); return { sharedBase: this.sharedBaseEnabled() }; }
  /** The shared base for a Stingray-managed worktree when the setting is on; null means its own full index. */
  sharedBaseTarget(workspaceId: string): SharedBaseTarget | null {
    if (!this.sharedBaseEnabled()) return null;
    const state = this.readState();
    const workspace = state.workspaces.find(w => w.id === workspaceId);
    const repo = workspace?.managed ? state.repos.find(r => r.id === workspace.repoId) : undefined;
    return repo ? { repoId: repo.id, repoPath: repo.path, dataDir: this.dataDir } : null;
  }
  /** The managed worktrees sharing `workspaceId`'s base, itself included. */
  sharedBaseWorkspaces(workspaceId: string): { target: SharedBaseTarget; workspaceIds: string[] } | null {
    const target = this.sharedBaseTarget(workspaceId);
    if (!target) return null;
    return { target, workspaceIds: this.readState().workspaces.filter(w => w.managed && w.repoId === target.repoId).map(w => w.id) };
  }
}
