import * as path from '../shared/posix-path';
import { sha256 } from '../shared/ports';
import { reviewPushStatus, mergedInto } from './worktree-removal';
import { removalConsentSchema, type Change, type RemovalConsent, type RemovalReview, type RemovalResult } from '../../../shared/contracts/git';
import type { Store } from './store';
import type { Cloner, GitRunner, WorkspaceFiles } from './ports';
import type { WorkspaceLifecycle } from './workspace-lifecycle';
import { urlSchema } from '../../../shared/contracts/common';
import { repositoryUrlSchema, cloneDestinationSchema, type State, type Workspace, type GitStatus } from '../../../shared/contracts/git';
import { readGitLines, originMainBase } from './git-lines';

/** Consent identity of a removal review: any change to it invalidates an earlier confirmation (audit 3). */
export function removalFingerprint(r: { branch: string; changes: Change[]; blockers: string[]; push: RemovalReview['push']; merged: string | null; identity: string }): string {
  const changes = r.changes.map(c => JSON.stringify([c.path, c.status, c.originalPath ?? null])).sort();
  return sha256(JSON.stringify({ branch: r.branch, changes, blockers: r.blockers, push: r.push, merged: r.merged, identity: r.identity }));
}
export function parseStatus(output: string) {
  const entries = output.split('\0');
  const changes: GitStatus['changes'] = [];
  for (let i = 0; i < entries.length; i++) {
    const row = entries[i];
    if (!row) continue;
    const status = row.slice(0, 2);
    const renamed = status.includes('R') || status.includes('C');
    changes.push({ status, path: row.slice(3), ...(renamed ? { originalPath: entries[++i] } : {}) });
  }
  return changes;
}
const CACHE_DIR = '.codegraph';
export interface GitServiceDeps { store: Store; runner: GitRunner; files: WorkspaceFiles; cloner: Cloner; lifecycle: WorkspaceLifecycle; terminalCount?: (id: string) => number }
export class GitService {
  private pending: Promise<unknown> = Promise.resolve();
  /** Every status read (sidebar, Repo Map, file inspection) reports here so shared Git state stays consistent. */
  onStatus?: (id: string, status: GitStatus) => void;
  readonly store: Store;
  private readonly runner: GitRunner; private readonly files: WorkspaceFiles; private readonly cloner: Cloner;
  // Removal side effects of other features (close terminals, stop code-graph writers first; undo on failure).
  private readonly lifecycle: WorkspaceLifecycle; private readonly terminalCount: (id: string) => number;
  constructor(deps: GitServiceDeps) {
    this.store = deps.store; this.runner = deps.runner; this.files = deps.files; this.cloner = deps.cloner;
    this.lifecycle = deps.lifecycle; this.terminalCount = deps.terminalCount ?? (() => 0);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action, action); this.pending = next.catch(() => undefined); return next;
  }
  useWorkspace<T>(id: string, action: (w: Workspace) => T | Promise<T>) {
    return this.serial(async () => action(await this.workspace(id)));
  }
  async workspace(id: string): Promise<Workspace> {
    const state = await this.store.load();
    const workspace = state.workspaces.find(w => w.id === id);
    if (!workspace) throw new Error('Workspace not found.');
    return workspace;
  }
  openRepository(input: string) {
    return this.serial(() => this.registerRepository(input));
  }
  private async registerRepository(input: string) {
      if (!path.isAbsolute(input) || input.length > 4096) throw new Error('Choose an absolute repository folder.');
      const candidate = await this.files.realpath(input);
      const workingRoot = await this.files.realpath((await this.runner(candidate, ['rev-parse', '--show-toplevel'])).trim());
      // Git lists the primary checkout first. Opening a linked worktree must not
      // register it as another project (including paths inside that worktree).
      const primary = (await this.runner(workingRoot, ['worktree', 'list', '--porcelain', '-z']))
        .split('\0').find(field => field.startsWith('worktree '))?.slice('worktree '.length);
      if (!primary) throw new Error('Git repository has no primary working directory.');
      const root = await this.files.realpath(primary);
      await this.runner(root, ['rev-parse', '--show-toplevel']);
      const state = await this.store.load();
      if (state.repos.some(r => r.path === root)) return state;
      if (state.repos.length >= 100 || state.workspaces.length >= 200) throw new Error('Workspace capacity reached.');
      const branch = (await this.runner(root, ['branch', '--show-current'])).trim() || 'detached HEAD';
      const repoId = globalThis.crypto.randomUUID();
      state.repos.push({ id: repoId, name: path.basename(root), path: root });
      state.workspaces.push({ id: globalThis.crypto.randomUUID(), repoId, path: root, branch, name: branch, managed: false, previewUrl: '' });
      await this.store.save(state);
      return state;
  }
  cloneRepository(input: string, destination: string) {
    return this.serial(async () => {
      if (!repositoryUrlSchema.safeParse(input).success) throw new Error('Use an HTTPS or SSH Git URL without passwords, tokens, query strings, or fragments.');
      if (!cloneDestinationSchema.safeParse(destination).success) throw new Error('Choose a new absolute folder path, without trailing slash or dot segments.');
      const state = await this.store.load();
      if (state.repos.length >= 100 || state.workspaces.length >= 200) throw new Error('Workspace capacity reached.');
      let parent: string;
      try { parent = await this.files.realpath(path.dirname(destination)); } catch {
        throw new Error('The parent folder is unavailable. Choose an existing writable parent folder.');
      }
      const target = path.join(parent, path.basename(destination));
      // Exclusive mkdir refuses existing files, empty directories and symlinks.
      try { await this.files.mkdirExclusive(target, 0o700); } catch {
        throw new Error('The destination already exists or cannot be created. Choose a new folder inside an existing writable parent. Nothing was replaced.');
      }
      await this.cloner(input, target, parent);
      try { return await this.registerRepository(target); } catch {
        throw new Error('Clone completed, but project registration failed. Its files were preserved. Use Local folder to register the completed repository; do not clone over it.');
      }
    });
  }
  createWorkspace(repoId: string, branch: string) {
    return this.serial(async () => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch)) throw new Error('Use a branch name of 1–100 letters, numbers, dots, slashes, underscores, or hyphens.');
      const state = await this.store.load();
      const repo = state.repos.find(r => r.id === repoId);
      if (!repo) throw new Error('Repository not found.');
      if (state.workspaces.length >= 200) throw new Error('Workspace capacity reached.');
      await this.runner(repo.path, ['check-ref-format', '--branch', branch]);
      await this.runner(repo.path, ['rev-parse', '--verify', 'HEAD']);
      const exists = await this.runner(repo.path, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]).then(() => true, () => false);
      if (exists) throw new Error(`Branch ${branch} already exists. Choose another name.`);
      const id = globalThis.crypto.randomUUID();
      const parent = path.join(this.store.directory, 'worktrees', repo.id);
      await this.files.mkdirp(parent, 0o700);
      const target = path.join(await this.files.realpath(parent), id);
      await this.runner(repo.path, ['worktree', 'add', '-b', branch, target, 'HEAD']);
      state.workspaces.push({ id, repoId, path: target, branch, name: branch, managed: true, previewUrl: '' });
      try { await this.store.save(state); } catch {
        throw new Error('Git created the worktree, but saving its registration failed. Recover it with git worktree list; its branch and files have been preserved.');
      }
      await this.lifecycle.runCreated(id);
      return state;
    });
  }
  reviewRemoval(id: string) {
    return this.serial(() => this.removalReview(id));
  }
  private async removalReview(id: string): Promise<RemovalReview> {
    const state = await this.store.load();
    const w = state.workspaces.find(w => w.id === id);
    if (!w || !w.managed) throw new Error('Only worktrees created by Stingray can be removed.');
    const expected = path.join(await this.files.realpath(path.join(this.store.directory, 'worktrees', w.repoId)), w.id);
    if (w.path !== expected || await this.files.realpath(w.path) !== expected) throw new Error('Worktree location changed. Removal refused.');
    const repo = state.repos.find(r => r.id === w.repoId);
    if (!repo) throw new Error('Repository not found.');
    const listing = await this.runner(repo.path, ['worktree', 'list', '--porcelain', '-z']);
    const records = listing.split('\0\0').map(row => row.split('\0'));
    const record = records.find(rows => rows.includes('worktree ' + w.path));
    if (!record) throw new Error('Git no longer recognizes this worktree.');
    const branch = (await this.runner(w.path, ['branch', '--show-current'])).trim();
    // Ignored files (node_modules, build output, caches) are regenerable and never block removal; they are
    // deleted with the folder. Only tracked changes and untracked files are reported as work that will be lost.
    const dirty = await this.runner(w.path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    // Stingray's code-graph cache is not user work either.
    const cache = await this.files.isDirectory(path.join(w.path, CACHE_DIR));
    const userWork = (output: string) => parseStatus(output).filter(c => !(cache && c.status === '??' && (c.path === CACHE_DIR + '/' || c.path.startsWith(CACHE_DIR + '/'))));
    const changes = userWork(dirty);
    // The consent covers every untracked file, not just the folders the preview collapses them into.
    const files = userWork(await this.runner(w.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxBuffer: 16 * 1024 * 1024 }));
    const untracked = changes.filter(c => c.status === '??').length;
    const blockers: string[] = [];
    if (!branch) blockers.push('Detached HEAD: attach these commits to a branch before removing the worktree.');
    else if (branch !== w.branch) blockers.push(`The checked-out branch changed. Restore ${w.branch} before removing this worktree.`);
    if (record.some(row => row === 'locked' || row.startsWith('locked '))) blockers.push('This worktree is locked. Unlock it yourself only after checking why.');
    const { push, identity } = branch ? await reviewPushStatus(args => this.runner(w.path, args), branch)
      : { push: { kind: 'unknown' as const, message: 'Detached HEAD has no branch upstream.' }, identity: 'detached' };
    // The branch may optionally be deleted, but only when Git proves it is merged and no other worktree uses it.
    const usedElsewhere = records.some(rows => !rows.includes('worktree ' + w.path) && rows.includes('branch refs/heads/' + w.branch));
    const merged = branch === w.branch && !usedElsewhere ? await mergedInto(repo.path, w.branch, (cwd, args) => this.runner(cwd, args)) : null;
    const review = { branch: w.branch, blockers, push, terminals: this.terminalCount(id), merged,
      changes: { tracked: changes.length - untracked, untracked, paths: changes.slice(0, 20).map(c => c.path) } };
    return { ...review, fingerprint: removalFingerprint({ branch: w.branch, changes: files, blockers, push, merged, identity }) };
  }
  removeWorkspace(id: string, consent?: RemovalConsent) {
    return this.serial(async (): Promise<RemovalResult> => {
      const state = await this.store.load();
      const w = state.workspaces.find(w => w.id === id);
      if (!w || !w.managed) throw new Error('Only worktrees created by Stingray can be removed.');
      const repo = state.repos.find(r => r.id === w.repoId);
      if (!repo) throw new Error('Repository not found.');
      const parsedConsent = removalConsentSchema.safeParse(consent);
      if (!parsedConsent.success) throw new Error('Confirm the removal first.');
      const { discard, deleteBranch, fingerprint } = parsedConsent.data;
      // Re-read ownership, files, branch and merge state instead of trusting a renderer's earlier result.
      const review = await this.removalReview(id);
      if (review.blockers.length) throw new Error(review.blockers.join(' '));
      // Anything the user did not see (new changes, moved upstream) refuses the removal untouched.
      if (review.fingerprint !== fingerprint) return { stale: review };
      const dirty = review.changes.tracked + review.changes.untracked > 0;
      if (dirty && !discard) throw new Error('This worktree has uncommitted changes. Confirm discarding them to remove it.');
      if (deleteBranch && !review.merged) throw new Error(`${w.branch} is not merged, so it was not deleted. Nothing was removed.`);
      try { await this.lifecycle.runBeforeRemove(id); } catch (error) { await this.lifecycle.runRemoveFailed(id); throw error; }
      let force: boolean;
      try {
        // Listeners (terminals, writers) may have changed files while they ran: the consent must still match.
        const fresh = await this.removalReview(id);
        if (fresh.fingerprint !== fingerprint) { await this.lifecycle.runRemoveFailed(id); return { stale: fresh }; }
        force = fresh.changes.tracked + fresh.changes.untracked > 0 && discard;
      } catch (error) { await this.lifecycle.runRemoveFailed(id); throw error; }
      try {
        if (await this.files.isDirectory(path.join(w.path, CACHE_DIR))) await this.runner(w.path, ['clean', '-f', '-d', '-x', '-q', '--', CACHE_DIR + '/']);
        // Force only for reviewed, consented changes; otherwise Git itself refuses if changes appeared since.
        await this.runner(repo.path, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', w.path]);
      } catch {
        await this.lifecycle.runRemoveFailed(id);
        throw new Error('Git could not remove the worktree. If files changed since the review, check again and confirm.');
      }
      state.workspaces = state.workspaces.filter(x => x.id !== id);
      await this.store.save(state);
      let result: RemovalResult = { state };
      if (deleteBranch) {
        try { await this.runner(repo.path, ['branch', '-D', w.branch]); } catch {
          result = { state, warning: `The worktree was removed, but deleting branch ${w.branch} failed. The branch was kept.` };
        }
      }
      await this.lifecycle.runAfterRemove(id);
      return result;
    });
  }
  async status(id: string): Promise<GitStatus> {
    const w = await this.workspace(id);
    const [branch, output] = await Promise.all([
      this.runner(w.path, ['branch', '--show-current']),
      this.runner(w.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxBuffer: 16 * 1024 * 1024 }),
    ]);
    const changes = parseStatus(output);
    const lines = (cwd: string, args: string[]) => this.runner(cwd, args, { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    const [uncommitted, base] = await Promise.all([readGitLines(w.path, changes, lines), originMainBase(w.path, lines)]);
    const lineStats = base ? await readGitLines(w.path, changes, lines, base) : uncommitted;
    const result: GitStatus = { branch: branch.trim() || 'detached HEAD', changes, lines: lineStats, uncommitted, base: base ? 'origin/main' : 'HEAD' };
    this.onStatus?.(id, result);
    return result;
  }
  preview(id: string, input: string) {
    return this.serial(async () => {
      const url = input === '' ? '' : urlSchema.parse(input);
      const state = await this.store.load();
      const w = state.workspaces.find(w => w.id === id);
      if (!w) throw new Error('Workspace not found.');
      w.previewUrl = url; await this.store.save(state); return state;
    });
  }
}
