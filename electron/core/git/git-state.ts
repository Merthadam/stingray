import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { GitStatus, PullRequestStatus, WorkspaceGitState } from '../../../shared/contracts/git';
import { git, type GitService } from './git';
import type { PullRequestService } from './pull-requests';

type Tracked = { path: string; gitDir: string; common: string; remote: string | null; timer?: NodeJS.Timeout; forcePr: boolean };
export type GitStateOptions = { debounceMs?: number; pollMs?: number; prPollMs?: number; concurrency?: number };

// One Git + PR state per workspace, shared by every renderer view. Updates come from a watcher on the
// repository's common .git directory (commits, checkouts, staging, fetches and pushes), a slow fallback
// poll, Repo Map/status reads (GitService.onStatus) and a repository-level PR poll while the window is visible.
export class GitStateService {
  private states = new Map<string, WorkspaceGitState>();
  private tracked = new Map<string, Tracked>();
  private tracking = new Map<string, Promise<void>>();
  private watchers = new Map<string, { ids: Set<string>; watcher: FSWatcher }>();
  private refreshing = new Map<string, Promise<WorkspaceGitState>>();
  private queued = new Map<string, { force: boolean; promise: Promise<WorkspaceGitState> }>();
  private revision = 0;
  private listVersion = 0;
  private timers: NodeJS.Timeout[];
  private debounceMs: number;
  private slots: number;
  private waiting: (() => void)[] = [];
  constructor(private git: Pick<GitService, 'workspace' | 'status'>, private pullRequests: Pick<PullRequestService, 'resolve'>,
    private emit: (state: WorkspaceGitState) => void, private visible: () => boolean = () => true, options: GitStateOptions = {}) {
    const { debounceMs = 300, pollMs = 60000, prPollMs = 20000, concurrency = 3 } = options;
    this.debounceMs = debounceMs; this.slots = concurrency;
    this.timers = [
      setInterval(() => { if (this.visible()) for (const id of this.tracked.keys()) void this.refresh(id).catch(() => {}); }, pollMs),
      setInterval(() => { if (this.visible()) this.pollPullRequests(); }, prPollMs),
    ];
    for (const timer of this.timers) timer.unref();
  }

  async get(id: string) {
    await this.track(id);
    return this.states.get(id) ?? this.refresh(id);
  }

  /** forcePr bypasses the PR freshness window (still subject to the 5s retry cooldown). */
  refresh(id: string, forcePr = false): Promise<WorkspaceGitState> {
    const queued = this.queued.get(id);
    if (queued) { queued.force ||= forcePr; return queued.promise; }
    const running = this.refreshing.get(id);
    if (!running) return this.start(id, forcePr);
    // Changes during a read need one more read; further requests share it.
    const entry = { force: forcePr, promise: undefined as unknown as Promise<WorkspaceGitState> };
    entry.promise = running.catch(() => undefined).then(() => { this.queued.delete(id); return this.start(id, entry.force); });
    this.queued.set(id, entry);
    return entry.promise;
  }

  /** Status read elsewhere (e.g. a Repo Map snapshot): adopt it so every view shows the same numbers. */
  observe(id: string, status: GitStatus) {
    const current = this.states.get(id);
    if (!current || !this.tracked.has(id) || this.refreshing.has(id)) return;
    if (current.status?.branch !== status.branch) { void this.refresh(id).catch(() => {}); return; }
    this.apply(id, { status, error: '', pr: current.pr });
  }

  forget(id: string) {
    const t = this.tracked.get(id);
    clearTimeout(t?.timer);
    this.tracked.delete(id); this.states.delete(id); this.tracking.delete(id);
    if (!t) return;
    const watcher = this.watchers.get(t.common);
    watcher?.ids.delete(id);
    if (watcher && !watcher.ids.size) { watcher.watcher.close(); this.watchers.delete(t.common); }
  }

  dispose() {
    for (const timer of this.timers) clearInterval(timer);
    for (const id of [...this.tracked.keys()]) this.forget(id);
  }

  private track(id: string) {
    const t = this.tracked.get(id);
    if (t) {
      // Re-watch after a watcher error (e.g. .git was removed and recreated).
      if (t.common && !this.watchers.get(t.common)?.ids.has(id)) this.watch(t.common, id);
      return Promise.resolve();
    }
    let job = this.tracking.get(id);
    if (!job) {
      let current!: Promise<void>;
      current = (async () => {
        const w = await this.git.workspace(id);
        let gitDir = '', common = '';
        try {
          [gitDir, common] = (await git(w.path, ['rev-parse', '--git-dir', '--git-common-dir'])).trim().split('\n').map(dir => path.resolve(w.path, dir));
        } catch { /* Unreadable repository: the fallback poll and manual refresh still report it. */ }
        if (this.tracking.get(id) !== current) return; // forget() ran meanwhile
        this.tracked.set(id, { path: w.path, gitDir, common, remote: null, forcePr: false });
        if (common) this.watch(common, id);
      })().finally(() => { if (this.tracking.get(id) === current) this.tracking.delete(id); });
      this.tracking.set(id, job = current);
    }
    return job;
  }

  // One recursive watcher per repository; linked worktrees keep their HEAD/index under worktrees/<name>/.
  private watch(common: string, id: string) {
    let entry = this.watchers.get(common);
    if (!entry) {
      const ids = new Set<string>();
      let watcher: FSWatcher;
      try {
        watcher = watch(common, { recursive: true }, (_event, filename) => this.changed(common, ids, filename?.toString() ?? ''));
      } catch { return; /* Watching unavailable here: the fallback poll still runs and the next track() retries. */ }
      const created = { ids, watcher };
      watcher.on('error', () => { watcher.close(); if (this.watchers.get(common) === created) this.watchers.delete(common); });
      this.watchers.set(common, entry = created);
    }
    entry.ids.add(id);
  }

  private changed(common: string, ids: Set<string>, filename: string) {
    const name = filename.split(path.sep).join('/');
    if (name.startsWith('objects/') || name.endsWith('.lock')) return;
    // Commits, checkouts, fetches and pushes move refs/HEAD: re-query GitHub right away instead of waiting for the poll.
    const refChange = !name || /(^|\/)(HEAD|packed-refs)$|(^|\/)refs\//.test(name);
    // Refs and config are shared; worktrees/<name>/ belongs to that linked worktree; other top-level files
    // (index, HEAD, logs/HEAD, ORIG_HEAD, FETCH_HEAD, ...) belong to the main checkout only.
    const shared = !name || name === 'packed-refs' || name === 'config' || name.startsWith('refs/');
    const owner = shared ? '' : path.join(common, /^worktrees\/[^/]+/.exec(name)?.[0] ?? '');
    for (const id of ids) {
      const t = this.tracked.get(id);
      if (!t || (owner && owner !== t.gitDir)) continue;
      t.forcePr ||= refChange;
      clearTimeout(t.timer);
      t.timer = setTimeout(() => { const force = t.forcePr; t.forcePr = false; void this.refresh(id, force).catch(() => {}); }, this.debounceMs);
    }
  }

  private start(id: string, forcePr: boolean) {
    const job: Promise<WorkspaceGitState> = this.limit(() => this.compute(id, forcePr))
      .finally(() => { if (this.refreshing.get(id) === job) this.refreshing.delete(id); });
    this.refreshing.set(id, job);
    return job;
  }

  private async compute(id: string, forcePr: boolean) {
    await this.track(id);
    const t = this.tracked.get(id);
    if (!t) throw new Error('Workspace not found.');
    let status: GitStatus | null = null, error = '';
    try { status = await this.git.status(id); } catch (e) {
      error = (e as Error).message;
      if (error === 'Workspace not found.') { this.forget(id); throw e; }
    }
    if (status) t.remote = await git(t.path, ['config', '--get', 'remote.origin.url']).then(value => value.trim(), () => null);
    let pr: PullRequestStatus | null = null;
    // A repository list that changed mid-lookup (e.g. another workspace's forced re-query) is matched again.
    for (let attempt = 0, version = -1; status && attempt < 2 && version !== this.listVersion; attempt++) {
      version = this.listVersion;
      pr = await this.pullRequests.resolve(t.path, status.branch === 'detached HEAD' ? '' : status.branch, t.remote, forcePr && !attempt);
    }
    return this.apply(id, { status, error, pr });
  }

  /** A repository PR list changed: match every workspace's branch again (local, no request while lists are fresh). */
  listChanged() { this.listVersion++; this.pollPullRequests(); }

  // Every workspace asks; PullRequestService turns that into one conditional request per repository.
  private pollPullRequests() {
    for (const [id, t] of this.tracked) {
      const branch = this.states.get(id)?.status?.branch;
      if (!branch || this.refreshing.has(id)) continue;
      void this.pullRequests.resolve(t.path, branch === 'detached HEAD' ? '' : branch, t.remote).then(pr => {
        const latest = this.states.get(id);
        if (latest?.status?.branch === branch && this.tracked.has(id) && !this.refreshing.has(id)) this.apply(id, { status: latest.status, error: latest.error, pr });
      }, () => {});
    }
  }

  private apply(id: string, next: Pick<WorkspaceGitState, 'status' | 'error' | 'pr'>) {
    const previous = this.states.get(id);
    // A 304 only moves checkedAt: not a change worth a renderer update.
    const key = (value: typeof next) => JSON.stringify([value.status, value.error, value.pr && { ...value.pr, checkedAt: 0 }]);
    if (previous && key(previous) === key(next)) return previous;
    const state: WorkspaceGitState = { workspaceId: id, revision: ++this.revision, ...next };
    if (!this.tracked.has(id)) return state;
    this.states.set(id, state);
    this.emit(state);
    return state;
  }

  private async limit<T>(action: () => Promise<T>) {
    if (this.slots > 0) this.slots--; else await new Promise<void>(resolve => this.waiting.push(resolve));
    try { return await action(); } finally { const next = this.waiting.shift(); if (next) next(); else this.slots++; }
  }
}
