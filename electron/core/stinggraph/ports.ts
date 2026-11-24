import type { OverlayConflicts } from '@colbymchenry/codegraph';
import type { State } from '../../../shared/contracts/git';

/** Where a managed worktree's shared base lives; null/absent means the full per-worktree index. */
export interface SharedBaseTarget { repoId: string; repoPath: string; dataDir: string }
/** The worker host as the release needs it: close one workspace's graph, or stop the whole worker. */
export interface GraphReleaseHost { close(workspaceId: string): Promise<void>; kill(): Promise<void> }
/** Overlay conflicts between managed worktrees (implemented by the worker process host). */
export interface ConflictsSource { conflicts(shared: SharedBaseTarget, workspaceIds: string[]): Promise<OverlayConflicts | null> }
export type StateReader = () => State;
