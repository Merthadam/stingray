// Git core + real adapters under the names and signatures the rest of the app and the existing tests use.
import { cloneGit } from '../../adapters/driven/git/clone';
import { ghRunner } from '../../adapters/driven/git/gh';
import { git } from '../../adapters/driven/git/runner';
import { nodeGitDirWatcher } from '../../adapters/driven/git/watcher';
import { nodeWorkspaceFiles } from '../../adapters/driven/fs/workspace-files';
import { sqliteStateRepository } from '../../adapters/driven/sqlite/state-repository';
import { GitService as CoreGitService, GitStateService as CoreGitStateService, PullRequestService as CorePullRequestService, Store as CoreStore,
  WorkspaceLifecycle, originMainBase as coreOriginMainBase, readGitLines as coreReadGitLines, type GitStateOptions, type GitStatePublisher, type LineRunner, type PRRunner } from '../../core/git';
import type { Change } from '../../../shared/contracts/git';
import './core-ports';
import { createRepoMapService } from './repo-map';

export { git, WorkspaceLifecycle };
export { parseStatus, parseNumstat } from '../../core/git';

export class Store extends CoreStore { constructor(directory: string) { super(directory, sqliteStateRepository(directory)); } }

export class GitService extends CoreGitService {
  /** hooks: legacy test hook pair, registered as a blocking beforeRemove listener and a removeFailed listener. */
  constructor(store: CoreStore, terminalCount: (id: string) => number = () => 0,
    hooks?: { beforeRemove(id: string): Promise<void>; removeFailed(id: string): void }, lifecycle = new WorkspaceLifecycle()) {
    if (hooks) { lifecycle.onBeforeRemove('hooks', hooks.beforeRemove, { blocking: true }); lifecycle.onRemoveFailed('hooks', hooks.removeFailed); }
    super({ store, runner: git, files: nodeWorkspaceFiles, cloner: cloneGit, lifecycle, terminalCount });
  }
  /** Repo Map for this service (production IPC and the existing tests' service.repoSnapshot/inspectFile). */
  readonly repoMap = createRepoMapService(this);
  repoSnapshot(id: string) { return this.repoMap.repoSnapshot(id); }
  inspectFile(id: string, relative: string) { return this.repoMap.inspectFile(id, relative); }
}

export class GitStateService extends CoreGitStateService {
  constructor(service: ConstructorParameters<typeof CoreGitStateService>[0], pullRequests: ConstructorParameters<typeof CoreGitStateService>[1],
    emit: GitStatePublisher, visible?: () => boolean, options?: GitStateOptions) {
    super(service, pullRequests, emit, visible, options, { watcher: nodeGitDirWatcher, runner: git });
  }
}

export class PullRequestService extends CorePullRequestService { constructor(execute: PRRunner = ghRunner, now = Date.now) { super(execute, now); } }

const lineRunner: LineRunner = (cwd, args) => git(cwd, args, { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
export const readGitLines = (cwd: string, changes: Change[], runner: LineRunner = lineRunner, base = 'HEAD') => coreReadGitLines(cwd, changes, runner, base);
export const originMainBase = (cwd: string, runner: LineRunner = lineRunner) => coreOriginMainBase(cwd, runner);
