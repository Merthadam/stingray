import type { GitService } from '../git';
import type { FileInspection, RepoSnapshot } from '../../../shared/contracts/repo-map';
import { inspectFile, repoSnapshot, type RepoMapPorts } from './repo-map';

export type RepoMapDeps = RepoMapPorts & { git: Pick<GitService, 'workspace' | 'status'> };

export class RepoMapService {
  private readonly inFlight = new Map<string, Promise<RepoSnapshot>>();
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
    try { return await job; } finally { if (this.inFlight.get(root) === job) this.inFlight.delete(root); }
  }
  async inspectFile(id: string, relative: string): Promise<FileInspection> {
    const w = await this.deps.git.workspace(id);
    return inspectFile(w.path, relative, await repoSnapshot(w.path, await this.deps.git.status(id), false, this.deps), this.deps);
  }
}
