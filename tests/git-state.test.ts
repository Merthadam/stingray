import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, GitService } from '../electron/git';
import { Store } from '../electron/store';
import { GitStateService } from '../electron/git-state';
import type { PullRequestStatus, WorkspaceGitState } from '../shared/contracts/git';

const commit = (repo: string) => git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
async function waitFor<T>(read: () => T | undefined, ms = 8000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 25))) { const value = read(); if (value) return value; }
  throw new Error('Timed out');
}
async function fixture(options: { visible?: () => boolean; prPollMs?: number } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'stingray-git-state-')));
  const repo = path.join(root, 'repo');
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'text'), 'one\n'); await git(repo, ['add', '.']); await commit(repo);
  await git(repo, ['remote', 'add', 'origin', 'https://github.com/owner/app']);
  await git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const service = new GitService(new Store(path.join(root, 'data')));
  const state = await service.openRepository(repo);
  const resolves: { cwd: string; branch: string; remote: string | null; refresh: boolean }[] = [];
  const events: WorkspaceGitState[] = [];
  let checkedAt = 0;
  const gitState = new GitStateService(service, {
    resolve: async (cwd, branch, remote, refresh = false): Promise<PullRequestStatus> => {
      resolves.push({ cwd, branch, remote, refresh });
      return { kind: 'none', branch, repository: 'owner/app', checkedAt: ++checkedAt };
    },
  }, event => events.push(event), options.visible, { debounceMs: 20, prPollMs: options.prPollMs ?? 60000 });
  service.onStatus = (id, status) => gitState.observe(id, status);
  return { root, repo, service, gitState, resolves, events, repoId: state.repos[0].id, id: state.workspaces[0].id,
    cleanup: async () => { gitState.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test('shared state reports merge-base lines and the PR from the origin remote, and follows commits and pushes', async () => {
  const f = await fixture();
  try {
    const first = await f.gitState.get(f.id);
    assert.equal(first.status?.base, 'origin/main');
    assert.deepEqual(first.pr, { kind: 'none', branch: 'main', repository: 'owner/app', checkedAt: 1 });
    assert.deepEqual(f.resolves[0], { cwd: f.repo, branch: 'main', remote: 'https://github.com/owner/app', refresh: false });
    assert.equal((await f.gitState.get(f.id)).revision, first.revision, 'cached until something changes');
    // A commit: watcher refresh with an immediate GitHub re-query.
    await git(f.repo, ['checkout', '-q', '-b', 'feature']);
    await writeFile(path.join(f.repo, 'text'), 'one\ntwo\n'); await git(f.repo, ['add', '.']); await commit(f.repo);
    // A snapshot can land between `git add` and `git commit` (staged, not committed); wait for the clean post-commit one.
    const committed = await waitFor(() => f.events.find(e => e.status?.branch === 'feature' && e.status.lines.kind === 'available' && e.status.lines.added === 1
      && e.status.changes.length === 0));
    assert.deepEqual(committed.status?.uncommitted, { kind: 'available', added: 0, deleted: 0, binaryFiles: 0 });
    await waitFor(() => f.resolves.some(r => r.branch === 'feature' && r.refresh));
    // A push moves refs/remotes/origin/<branch>.
    f.resolves.length = 0;
    await git(f.repo, ['update-ref', 'refs/remotes/origin/feature', 'HEAD']);
    await waitFor(() => f.resolves.some(r => r.branch === 'feature' && r.refresh));
  } finally { await f.cleanup(); }
});

test('status read elsewhere (Repo Map) updates the same state; forgotten workspaces stop reporting', async () => {
  const f = await fixture();
  try {
    await f.gitState.get(f.id);
    const before = f.events.length;
    await writeFile(path.join(f.repo, 'text'), 'one\nedited\n'); // working-tree only: no .git change
    const status = await f.service.status(f.id);
    const observed = await waitFor(() => f.events.slice(before).find(e => e.status?.lines.kind === 'available' && e.status.lines.added === 1));
    assert.deepEqual(observed.status, status);
    f.gitState.forget(f.id);
    const count = f.events.length;
    await git(f.repo, ['add', '.']); await commit(f.repo);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(f.events.length, count);
  } finally { await f.cleanup(); }
});

test('linked worktree changes refresh only that workspace; PR poll runs only while visible', async () => {
  let visible = false;
  const f = await fixture({ visible: () => visible, prPollMs: 50 });
  try {
    const state = await f.service.createWorkspace(f.repoId, 'feature/other');
    const other = state.workspaces.find(w => w.branch === 'feature/other')!;
    await Promise.all([f.gitState.get(f.id), f.gitState.get(other.id)]);
    await new Promise(resolve => setTimeout(resolve, 300));
    f.events.length = 0; f.resolves.length = 0;
    await writeFile(path.join(other.path, 'text'), 'one\nstaged\n'); await git(other.path, ['add', 'text']);
    await waitFor(() => f.events.find(e => e.workspaceId === other.id && e.status?.changes.length === 1));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(f.events.every(e => e.workspaceId === other.id), 'main checkout was not re-read');
    assert.ok(f.resolves.every(r => !r.refresh), 'staging alone does not force a GitHub re-query');
    // The main checkout's top-level index/logs do not wake linked worktrees.
    const reads: string[] = [], status = f.service.status.bind(f.service);
    f.service.status = id => { reads.push(id); return status(id); };
    await writeFile(path.join(f.repo, 'text'), 'one\nmain\n'); await git(f.repo, ['add', 'text']);
    await waitFor(() => f.events.find(e => e.workspaceId === f.id && e.status?.changes.length === 1));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(reads.length && reads.every(id => id === f.id), 'linked worktree was not re-read');
    f.service.status = status;
    f.resolves.length = 0;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.resolves.length, 0, 'hidden window: no PR polling');
    f.events.length = 0; visible = true;
    await waitFor(() => new Set(f.resolves.map(r => r.cwd)).size === 2 && f.resolves.length >= 6);
    assert.ok(f.resolves.every(r => !r.refresh));
    assert.equal(f.events.length, 0, 'unchanged PR state (only checkedAt moved) is not re-emitted');
    visible = false; await new Promise(resolve => setTimeout(resolve, 100)); f.resolves.length = 0;
    f.gitState.listChanged(); // another workspace's re-query changed the repository list
    assert.deepEqual(f.resolves.map(r => r.cwd).sort(), [f.repo, other.path].sort());
  } finally { await f.cleanup(); }
});

test('a failed watcher is re-created on the next refresh; forget() during track() leaves nothing registered', async () => {
  const f = await fixture();
  try {
    await f.gitState.get(f.id);
    const watchers = (f.gitState as unknown as { watchers: Map<string, { watcher: import('node:fs').FSWatcher }> }).watchers;
    const [common] = [...watchers.keys()];
    watchers.get(common)!.watcher.emit('error', new Error('watch failed'));
    assert.equal(watchers.size, 0);
    await f.gitState.refresh(f.id);
    assert.ok(watchers.has(common), 're-watched');
    f.events.length = 0;
    await writeFile(path.join(f.repo, 'text'), 'one\nwatched\n'); await git(f.repo, ['add', 'text']);
    await waitFor(() => f.events.find(e => e.status?.changes.length === 1));

    f.gitState.forget(f.id);
    assert.equal(watchers.size, 0);
    const internals = f.gitState as unknown as { tracked: Map<string, unknown>; track(id: string): Promise<void> };
    const tracking = internals.track(f.id);
    f.gitState.forget(f.id);
    await tracking;
    assert.equal(internals.tracked.size, 0, 'not registered after forget()');
    assert.equal(watchers.size, 0, 'not watched after forget()');
  } finally { await f.cleanup(); }
});

test('a failing status read makes no PR lookup', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'stingray-git-state-nogit-')));
  const branches: string[] = [];
  const gitState = new GitStateService({
    workspace: async id => ({ id, repoId: id, name: 'x', branch: 'x', path: root, managed: false, previewUrl: '' }),
    status: async () => { throw new Error('Git operation failed.'); },
  }, {
    resolve: async (_cwd, branch): Promise<PullRequestStatus> => { branches.push(branch); return { kind: 'none', branch, repository: 'owner/app', checkedAt: 0 }; },
  }, () => {});
  try {
    const state = await gitState.refresh('00000000-0000-4000-8000-000000000001');
    assert.equal(state.status, null);
    assert.equal(state.pr, null);
    assert.equal(state.error, 'Git operation failed.');
    assert.deepEqual(branches, [], 'no PR lookup without a status');
  } finally { gitState.dispose(); await rm(root, { recursive: true, force: true }); }
});
