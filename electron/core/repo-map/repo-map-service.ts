import type { GitService } from '../git';
import { repoPathSchema } from '../../../shared/contracts/git';
import type { FileInspection, FileStamp, RepoMapScope, RepoSnapshot } from '../../../shared/contracts/repo-map';
import { inspectFile, repoSnapshot, type RepoMapPorts } from './repo-map';

export type RepoMapDeps = RepoMapPorts & { git: Pick<GitService, 'workspace' | 'status'> };

export class RepoMapService {
  private readonly inFlight = new Map<string, Promise<RepoSnapshot>>(); // per worktree root and scope
  private readonly last = new Map<string, RepoSnapshot>(); // last full snapshot per workspace and scope (inspectFile reuses its entries)
  private readonly forgets = new Map<string, number>(); // per-workspace forget count: a load that spans a forget is not cached
  constructor(private readonly deps: RepoMapDeps) {}
  async repoSnapshot(id: string, scope: RepoMapScope = 'branch'): Promise<RepoSnapshot> {
    const generation = this.forgets.get(id) ?? 0;
    const w = await this.deps.git.workspace(id);
    const root = await this.deps.files.realpath(w.path);
    const key = `${root}\0${scope}`;
    let job = this.inFlight.get(key);
    if (!job) {
      job = (async () => repoSnapshot(root, await this.deps.git.status(id), true, this.deps, scope))();
      this.inFlight.set(key, job);
    }
    // Concurrent requests share one entire status/inventory/count operation.
    try { const snapshot = await job; if ((this.forgets.get(id) ?? 0) === generation) this.last.set(`${id}\0${scope}`, snapshot); return snapshot; } finally { if (this.inFlight.get(key) === job) this.inFlight.delete(key); }
  }
  /** scope: the snapshot the renderer shows, so committed-only files and the branch diff resolve against the same base. */
  async inspectFile(id: string, relative: string, scope: RepoMapScope = 'branch'): Promise<FileInspection> {
    const w = await this.deps.git.workspace(id);
    const cached = this.last.get(`${id}\0${scope}`);
    // A path missing from the cached snapshot (e.g. a new file) falls back to today's status + inventory read.
    const snapshot = cached?.files.some(f => f.path === relative) ? cached : await repoSnapshot(w.path, await this.deps.git.status(id), false, this.deps, scope);
    return inspectFile(w.path, relative, snapshot, this.deps);
  }
  async statFile(id: string, relative: string): Promise<FileStamp> {
    repoPathSchema.parse(relative);
    return this.deps.files.stat((await this.deps.git.workspace(id)).path, relative);
  }
  /** Workspace removed. */
  forget(id: string) { for (const scope of ['branch', 'uncommitted'] as const) this.last.delete(`${id}\0${scope}`); this.forgets.set(id, (this.forgets.get(id) ?? 0) + 1); }
}
