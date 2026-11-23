import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { reviewPushStatus, mergedInto } from './worktree-removal';
import { removalConsentSchema, type RemovalConsent, type RemovalReview, type RemovalResult } from '../../../shared/contracts/git';
import { Store } from './store';
import { urlSchema } from '../../../shared/contracts/common';
import { repositoryUrlSchema, cloneDestinationSchema, type State, type Workspace, type GitStatus } from '../../../shared/contracts/git';
import { type RepoSnapshot } from '../../../shared/contracts/repo-map';
import { cloneGit } from '../../adapters/driven/git/clone';
import { repoSnapshot, inspectFile } from '../repo-map/repo-map';
import { readGitLines, originMainBase } from './git-lines';

const exec = promisify(execFile);
const snapshotsInFlight = new Map<string, Promise<RepoSnapshot>>();
export async function git(cwd: string, args: string[]) {
  try {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch {
    throw new Error('Git operation failed. Check the repository, branch, and worktree on disk. No force operation was attempted.');
  }
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
const isCacheDirectory = (root: string) => lstat(path.join(root, CACHE_DIR)).then(s => s.isDirectory(), () => false);
export class GitService {
  private pending: Promise<unknown> = Promise.resolve();
  /** Every status read (sidebar, Repo Map, file inspection) reports here so shared Git state stays consistent. */
  onStatus?: (id: string, status: GitStatus) => void;
  constructor(readonly store: Store, private terminalCount: (id: string) => number = () => 0,
    // Removal hooks: close the workspace's terminals and stop writers to the code-graph cache first; undo what can be undone if removal fails.
    private hooks: { beforeRemove(id: string): Promise<void>; removeFailed(id: string): void } = { beforeRemove: async () => {}, removeFailed: () => {} }) {}
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
      const candidate = await realpath(input);
      const workingRoot = await realpath((await git(candidate, ['rev-parse', '--show-toplevel'])).trim());
      // Git lists the primary checkout first. Opening a linked worktree must not
      // register it as another project (including paths inside that worktree).
      const primary = (await git(workingRoot, ['worktree', 'list', '--porcelain', '-z']))
        .split('\0').find(field => field.startsWith('worktree '))?.slice('worktree '.length);
      if (!primary) throw new Error('Git repository has no primary working directory.');
      const root = await realpath(primary);
      await git(root, ['rev-parse', '--show-toplevel']);
      const state = await this.store.load();
      if (state.repos.some(r => r.path === root)) return state;
      if (state.repos.length >= 100 || state.workspaces.length >= 200) throw new Error('Workspace capacity reached.');
      const branch = (await git(root, ['branch', '--show-current'])).trim() || 'detached HEAD';
      const repoId = randomUUID();
      state.repos.push({ id: repoId, name: path.basename(root), path: root });
      state.workspaces.push({ id: randomUUID(), repoId, path: root, branch, name: branch, managed: false, previewUrl: '' });
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
      try { parent = await realpath(path.dirname(destination)); } catch {
        throw new Error('The parent folder is unavailable. Choose an existing writable parent folder.');
      }
      const target = path.join(parent, path.basename(destination));
      // Exclusive mkdir refuses existing files, empty directories and symlinks.
      try { await mkdir(target, { mode: 0o700 }); } catch {
        throw new Error('The destination already exists or cannot be created. Choose a new folder inside an existing writable parent. Nothing was replaced.');
      }
      await cloneGit(input, target, parent);
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
      await git(repo.path, ['check-ref-format', '--branch', branch]);
      await git(repo.path, ['rev-parse', '--verify', 'HEAD']);
      const id = randomUUID();
      const parent = path.join(this.store.directory, 'worktrees', repo.id);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const target = path.join(await realpath(parent), id);
      await git(repo.path, ['worktree', 'add', '-b', branch, target, 'HEAD']);
      state.workspaces.push({ id, repoId, path: target, branch, name: branch, managed: true, previewUrl: '' });
      try { await this.store.save(state); } catch {
        throw new Error('Git created the worktree, but saving its registration failed. Recover it with git worktree list; its branch and files have been preserved.');
      }
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
    const expected = path.join(await realpath(path.join(this.store.directory, 'worktrees', w.repoId)), w.id);
    if (w.path !== expected || await realpath(w.path) !== expected) throw new Error('Worktree location changed. Removal refused.');
    const repo = state.repos.find(r => r.id === w.repoId);
    if (!repo) throw new Error('Repository not found.');
    const listing = await git(repo.path, ['worktree', 'list', '--porcelain', '-z']);
    const records = listing.split('\0\0').map(row => row.split('\0'));
    const record = records.find(rows => rows.includes('worktree ' + w.path));
    if (!record) throw new Error('Git no longer recognizes this worktree.');
    const branch = (await git(w.path, ['branch', '--show-current'])).trim();
    // Ignored files (node_modules, build output, caches) are regenerable and never block removal; they are
    // deleted with the folder. Only tracked changes and untracked files are reported as work that will be lost.
    const dirty = await git(w.path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    // Stingray's code-graph cache is not user work either.
    const cache = await isCacheDirectory(w.path);
    const changes = parseStatus(dirty).filter(c => !(cache && c.status === '??' && (c.path === CACHE_DIR + '/' || c.path.startsWith(CACHE_DIR + '/'))));
    const untracked = changes.filter(c => c.status === '??').length;
    const blockers: string[] = [];
    if (!branch) blockers.push('Detached HEAD: attach these commits to a branch before removing the worktree.');
    else if (branch !== w.branch) blockers.push(`The checked-out branch changed. Restore ${w.branch} before removing this worktree.`);
    if (record.some(row => row === 'locked' || row.startsWith('locked '))) blockers.push('This worktree is locked. Unlock it yourself only after checking why.');
    const { push } = branch ? await reviewPushStatus(args => git(w.path, args), branch)
      : { push: { kind: 'unknown' as const, message: 'Detached HEAD has no branch upstream.' } };
    // The branch may optionally be deleted, but only when Git proves it is merged and no other worktree uses it.
    const usedElsewhere = records.some(rows => !rows.includes('worktree ' + w.path) && rows.includes('branch refs/heads/' + w.branch));
    const merged = branch === w.branch && !usedElsewhere ? await mergedInto(repo.path, w.branch, git) : null;
    return {
      branch: w.branch, blockers, push, terminals: this.terminalCount(id), merged,
      changes: { tracked: changes.length - untracked, untracked, paths: changes.slice(0, 20).map(c => c.path) },
    };
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
      const { discard, deleteBranch } = parsedConsent.data;
      // Re-read ownership, files, branch and merge state instead of trusting a renderer's earlier result.
      const review = await this.removalReview(id);
      if (review.blockers.length) throw new Error(review.blockers.join(' '));
      const dirty = review.changes.tracked + review.changes.untracked > 0;
      if (dirty && !discard) throw new Error('This worktree has uncommitted changes. Confirm discarding them to remove it.');
      if (deleteBranch && !review.merged) throw new Error(`${w.branch} is not merged, so it was not deleted. Nothing was removed.`);
      await this.hooks.beforeRemove(id); // closes the workspace's terminals and stops its code graph
      try {
        if (await isCacheDirectory(w.path)) await git(w.path, ['clean', '-f', '-d', '-x', '-q', '--', CACHE_DIR + '/']);
        // Without discard consent Git itself refuses if changes appeared after the review.
        await git(repo.path, ['worktree', 'remove', ...(discard ? ['--force'] : []), '--', w.path]);
      } catch {
        this.hooks.removeFailed(id);
        throw new Error('Git could not remove the worktree. If files changed since the review, check again and confirm.');
      }
      state.workspaces = state.workspaces.filter(x => x.id !== id);
      await this.store.save(state);
      if (deleteBranch) {
        try { await git(repo.path, ['branch', '-D', w.branch]); } catch {
          return { state, warning: `The worktree was removed, but deleting branch ${w.branch} failed. The branch was kept.` };
        }
      }
      return { state };
    });
  }
  async status(id: string): Promise<GitStatus> {
    const w = await this.workspace(id);
    const [branch, output] = await Promise.all([
      git(w.path, ['branch', '--show-current']),
      git(w.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ]);
    const changes = parseStatus(output);
    const [uncommitted, base] = await Promise.all([readGitLines(w.path, changes), originMainBase(w.path)]);
    const lines = base ? await readGitLines(w.path, changes, undefined, base) : uncommitted;
    const result: GitStatus = { branch: branch.trim() || 'detached HEAD', changes, lines, uncommitted, base: base ? 'origin/main' : 'HEAD' };
    this.onStatus?.(id, result);
    return result;
  }
  async repoSnapshot(id: string) {
    const w = await this.workspace(id);
    const root = await realpath(w.path);
    let job = snapshotsInFlight.get(root);
    if (!job) {
      job = (async () => repoSnapshot(root, await this.status(id), true))();
      snapshotsInFlight.set(root, job);
    }
    try {
      // Concurrent requests share one entire status/inventory/count operation.
      return await job;
    } finally { if (snapshotsInFlight.get(root) === job) snapshotsInFlight.delete(root); }
  }
  async inspectFile(id: string, relative: string) {
    const w = await this.workspace(id);
    return inspectFile(w.path, relative, await repoSnapshot(w.path, await this.status(id), false));
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
