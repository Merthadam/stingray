import type { GitService } from '../git';
import { repoPathSchema } from '../../../shared/contracts/git';
import type { FileInspection, FileStamp, RepoSnapshot } from '../../../shared/contracts/repo-map';
import { inspectFile, repoSnapshot, type RepoMapPorts } from './repo-map';

export type RepoMapDeps = RepoMapPorts & { git: Pick<GitService, 'workspace' | 'status'> };

export class RepoMapService {
  private readonly inFlight = new Map<string, Promise<RepoSnapshot>>();
  private readonly last = new Map<string, RepoSnapshot>(); // last full snapshot per workspace (inspectFile reuses its entries)
  constructor(private readonly deps: RepoMapDeps) {}
  async repoSnapshot(id: string): Promise<RepoSnapshot> {
    const w = await this.deps.git.workspace(id);
    const root = await this.deps.files.realpath(w.path);
    let job = this.inFlight.get(root);
    if (!job) {
      job = (async () => repoSnapshot(root, await this.deps.git.status(id), true, this.deps))();
      this.inFlight.set(root, job);
    }
    // Concurrent requests share one entire status/inventory/count operation.
    try { const snapshot = await job; this.last.set(id, snapshot); return snapshot; } finally { if (this.inFlight.get(root) === job) this.inFlight.delete(root); }
  }
  async inspectFile(id: string, relative: string): Promise<FileInspection> {
    const w = await this.deps.git.workspace(id);
    const cached = this.last.get(id);
    // A path missing from the cached snapshot (e.g. a new file) falls back to today's status + inventory read.
    const snapshot = cached?.files.some(f => f.path === relative) ? cached : await repoSnapshot(w.path, await this.deps.git.status(id), false, this.deps);
    return inspectFile(w.path, relative, snapshot, this.deps);
  }
  async statFile(id: string, relative: string): Promise<FileStamp> {
    repoPathSchema.parse(relative);
    return this.deps.files.stat((await this.deps.git.workspace(id)).path, relative);
  }
  /** Workspace removed. */
  forget(id: string) { this.last.delete(id); }
}
