import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GitService, Store, WorkspaceLifecycle, removalFingerprint } from '../../electron/core/git';
import { provideHasher, resetCorePorts } from '../../electron/core/shared/ports';
import type { State } from '../../shared/contracts/git';
import { fakeHasher, memoryState, pathOnlyFiles, scriptedGit } from '../fakes/git';

const repoId = '00000000-0000-4000-8000-000000000001', id = '00000000-0000-4000-8000-000000000002';
const wpath = `/data/worktrees/${repoId}/${id}`;
const initial: State = { version: 1, repos: [{ id: repoId, name: 'repo', path: '/repo' }], workspaces: [
  { id: repoId.replace(/1$/, '3'), repoId, name: 'main', branch: 'main', path: '/repo', managed: false, previewUrl: '' },
  { id, repoId, name: 'feature', branch: 'feature', path: wpath, managed: true, previewUrl: '' }] };
beforeEach(() => provideHasher(fakeHasher));
afterEach(() => resetCorePorts());

function service(dirty: { value: string }) {
  const runner = scriptedGit((cwd, args) => {
    const a = args.join(' ');
    if (a === 'worktree list --porcelain -z') return `worktree /repo\0branch refs/heads/main\0\0worktree ${wpath}\0branch refs/heads/feature\0\0`;
    if (a === 'branch --show-current') return cwd === wpath ? 'feature\n' : 'main\n';
    if (a.startsWith('status --porcelain=v1 -z --untracked-files=normal')) return dirty.value;
    if (a.startsWith('for-each-ref --format=%(upstream)')) return '\n';
    if (a.startsWith('worktree remove') || a.startsWith('clean')) return '';
    return undefined;
  });
  const repository = memoryState(initial);
  const lifecycle = new WorkspaceLifecycle(() => {});
  const git = new GitService({ store: new Store('/data', repository), runner, files: pathOnlyFiles, cloner: async () => {}, lifecycle });
  return { git, runner, repository, lifecycle };
}

test('the removal fingerprint changes with any change, the push status or the upstream tip', () => {
  const base = { branch: 'feature', changes: [{ status: '??', path: 'a.txt' }], blockers: [], push: { kind: 'known' as const, upstream: 'origin/feature', ahead: 0, behind: 0 }, merged: null, identity: 'refs/remotes/origin/feature:aaa' };
  provideHasher(fakeHasher);
  const f = removalFingerprint(base);
  assert.match(f, /^[0-9a-f]{64}$/);
  assert.equal(removalFingerprint({ ...base, changes: [...base.changes] }), f);
  assert.notEqual(removalFingerprint({ ...base, changes: [...base.changes, { status: ' M', path: 'b.txt' }] }), f);
  assert.notEqual(removalFingerprint({ ...base, push: { ...base.push, ahead: 1 } }), f);
  assert.notEqual(removalFingerprint({ ...base, identity: 'refs/remotes/origin/feature:bbb' }), f);
});

test('stale consent removes nothing and returns the fresh review', async () => {
  const dirty = { value: '' };
  const { git, runner, repository } = service(dirty);
  const review = await git.reviewRemoval(id);
  dirty.value = '?? appeared.txt\0';
  let before = 0;
  const result = await git.removeWorkspace(id, { discard: true, deleteBranch: false, fingerprint: review.fingerprint });
  assert.ok('stale' in result && result.stale.changes.untracked === 1 && result.stale.changes.paths.includes('appeared.txt'));
  assert.equal(runner.calls.some(c => c.args[0] === 'worktree' && c.args[1] === 'remove'), false);
  assert.equal(repository.saved.length, before);
});

test('a consent without fingerprint is refused', async () => {
  const { git } = service({ value: '' });
  await assert.rejects(git.removeWorkspace(id, { discard: false, deleteBranch: false } as never), /Confirm the removal first/);
});

test('blocking beforeRemove failure aborts the removal and runs removeFailed; afterRemove failures never fail it', async () => {
  const { git, runner, lifecycle } = service({ value: '' });
  const ran: string[] = [];
  lifecycle.onBeforeRemove('terminals', () => { throw new Error('Terminals could not be closed.'); }, { blocking: true });
  lifecycle.onRemoveFailed('views', () => { ran.push('removeFailed'); });
  const review = await git.reviewRemoval(id);
  await assert.rejects(git.removeWorkspace(id, { discard: false, deleteBranch: false, fingerprint: review.fingerprint }), /Terminals could not be closed/);
  assert.deepEqual(ran, ['removeFailed']);
  assert.equal(runner.calls.some(c => c.args[1] === 'remove'), false);

  const ok = service({ value: '' });
  ok.lifecycle.onAfterRemove('view state', async () => { throw new Error('db locked'); });
  ok.lifecycle.onAfterRemove('activity', () => { ran.push('activity'); });
  const fresh = await ok.git.reviewRemoval(id);
  const result = await ok.git.removeWorkspace(id, { discard: false, deleteBranch: false, fingerprint: fresh.fingerprint });
  assert.ok('state' in result && result.state.workspaces.length === 1);
  assert.ok(ran.includes('activity'));
});

test('createWorkspace refuses an existing branch with a clear message', async () => {
  const runner = scriptedGit((_cwd, args) => (args[0] === 'check-ref-format' || args[0] === 'rev-parse' ? 'ok\n' : undefined));
  const git = new GitService({ store: new Store('/data', memoryState(initial)), runner, files: pathOnlyFiles, cloner: async () => {}, lifecycle: new WorkspaceLifecycle(() => {}) });
  await assert.rejects(git.createWorkspace(repoId, 'feature'), /^Error: Branch feature already exists\. Choose another name\.$/);
  assert.equal(runner.calls.some(c => c.args[0] === 'worktree'), false);
});

test('status reads with a 16 MiB buffer', async () => {
  const runner = scriptedGit((_cwd, args) => (args[0] === 'branch' ? 'feature\n' : args[0] === 'status' ? '' : args[0] === 'diff' ? '' : undefined));
  const git = new GitService({ store: new Store('/data', memoryState(initial)), runner, files: pathOnlyFiles, cloner: async () => {}, lifecycle: new WorkspaceLifecycle(() => {}) });
  await git.status(id);
  assert.equal(runner.calls.find(c => c.args[0] === 'status')!.options?.maxBuffer, 16 * 1024 * 1024);
});
