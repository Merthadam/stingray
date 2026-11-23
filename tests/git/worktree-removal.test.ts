import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitService, Store, git } from '../../electron/app/wiring/git';
import { reviewPushStatus } from '../../electron/core/git/worktree-removal';
import type { RemovalResult } from '../../shared/contracts/git';

const consent = async (service: GitService, id: string, choice: { discard: boolean; deleteBranch: boolean }) =>
  ({ ...choice, fingerprint: (await service.reviewRemoval(id)).fingerprint });
/** The removal happened (not refused as stale). */
const notStale = (result: RemovalResult) => { assert.ok('state' in result, 'removal refused as stale'); return result; };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-removal-'));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  await writeFile(path.join(repo, 'file.txt'), 'base\n');
  await writeFile(path.join(repo, '.gitignore'), 'ignored/\n');
  const commit = async (cwd: string) => {
    await git(cwd, ['add', '.']);
    await git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
    return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  };
  const base = await commit(repo);
  const store = new Store(path.join(root, 'data')); let terminals = 0;
  const service = new GitService(store, () => terminals);
  const state = await service.openRepository(repo);
  const w = (await service.createWorkspace(state.repos[0].id, 'feature/remove')).workspaces[1];
  const track = async () => {
    await git(repo, ['remote', 'add', 'origin', path.join(root, 'unused-local-remote')]);
    await git(repo, ['update-ref', 'refs/remotes/origin/feature/remove', base]);
    await git(w.path, ['branch', '--set-upstream-to=origin/feature/remove']);
  };
  return { root, repo, service, w, base, commit, track, terminal: (value: number) => { terminals = value; },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

const keep = { discard: false, deleteBranch: false };

test('clean removal needs one confirmation, keeps branch and commits, and ignores push status', async () => {
  const f = await fixture();
  try {
    const review = await f.service.reviewRemoval(f.w.id);
    assert.equal(review.push.kind, 'unknown'); assert.deepEqual(review.blockers, []);
    assert.deepEqual(review.changes, { tracked: 0, untracked: 0, paths: [] });
    await assert.rejects(f.service.removeWorkspace(f.w.id), /Confirm the removal/);
    const { state } = notStale(await f.service.removeWorkspace(f.w.id, await consent(f.service, f.w.id, keep)));
    assert.equal(state.workspaces.length, 1);
    await assert.rejects(access(f.w.path));
    assert.equal((await git(f.repo, ['rev-parse', 'refs/heads/feature/remove'])).trim(), f.base);
    await access(path.join(f.repo, 'file.txt'));
  } finally { await f.cleanup(); }
});

test('ignored files (dependencies, build output) never block and are deleted with the worktree', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.w.path, 'ignored', 'deep'), { recursive: true });
    await writeFile(path.join(f.w.path, 'ignored', 'deep', 'module.js'), 'regenerable');
    const review = await f.service.reviewRemoval(f.w.id);
    assert.deepEqual(review.blockers, []); assert.deepEqual(review.changes, { tracked: 0, untracked: 0, paths: [] });
    await f.service.removeWorkspace(f.w.id, await consent(f.service, f.w.id, keep));
    await assert.rejects(access(f.w.path));
  } finally { await f.cleanup(); }
});

test('uncommitted changes are listed and removed only with explicit discard consent', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.w.path, 'file.txt'), 'dirty\n');
    await writeFile(path.join(f.w.path, 'new.txt'), 'untracked\n');
    const review = await f.service.reviewRemoval(f.w.id);
    assert.deepEqual(review.blockers, []);
    assert.deepEqual(review.changes, { tracked: 1, untracked: 1, paths: ['file.txt', 'new.txt'] });
    await assert.rejects(f.service.removeWorkspace(f.w.id, await consent(f.service, f.w.id, keep)), /uncommitted changes/);
    assert.equal(await readFile(path.join(f.w.path, 'new.txt'), 'utf8'), 'untracked\n');
    await f.service.removeWorkspace(f.w.id, await consent(f.service, f.w.id, { discard: true, deleteBranch: false }));
    await assert.rejects(access(f.w.path));
    assert.equal((await git(f.repo, ['rev-parse', 'refs/heads/feature/remove'])).trim(), f.base);
  } finally { await f.cleanup(); }
});

test('open terminals are reported and closed by the removal hook instead of blocking', async () => {
  const f = await fixture(); const calls: string[] = [];
  try {
    const service = new GitService(f.service.store, () => 2, {
      beforeRemove: async id => { calls.push('close ' + id); }, removeFailed: id => { calls.push('failed ' + id); } });
    const review = await service.reviewRemoval(f.w.id);
    assert.equal(review.terminals, 2); assert.deepEqual(review.blockers, []);
    await service.removeWorkspace(f.w.id, await consent(service, f.w.id, keep));
    assert.deepEqual(calls, ['close ' + f.w.id]);
    await assert.rejects(access(f.w.path));
  } finally { await f.cleanup(); }
});

test('the code-graph cache does not count as changes; it is cleaned after the graph is released', async () => {
  const f = await fixture(); const calls: string[] = [];
  try {
    const service = new GitService(f.service.store, () => 0, {
      beforeRemove: async id => { calls.push('release ' + id); }, removeFailed: id => { calls.push('failed ' + id); } });
    await mkdir(path.join(f.w.path, '.codegraph'));
    await writeFile(path.join(f.w.path, '.codegraph', '.gitignore'), '*\n!.gitignore\n');
    await writeFile(path.join(f.w.path, '.codegraph', 'codegraph.db'), 'index');
    const review = await service.reviewRemoval(f.w.id);
    assert.deepEqual(review.blockers, []); assert.equal(review.changes.untracked, 0);
    await writeFile(path.join(f.w.path, '.codegraph', 'codegraph.db-wal'), 'wal');
    await service.removeWorkspace(f.w.id, await consent(service, f.w.id, keep));
    assert.deepEqual(calls, ['release ' + f.w.id]);
    await assert.rejects(access(f.w.path));
  } finally { await f.cleanup(); }
});

test('a .codegraph symlink still counts as an untracked change', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root, 'elsewhere'));
    await symlink(path.join(f.root, 'elsewhere'), path.join(f.w.path, '.codegraph'));
    assert.equal((await f.service.reviewRemoval(f.w.id)).changes.untracked, 1);
  } finally { await f.cleanup(); }
});

test('branch deletion is offered only when merged and is opt-in', async () => {
  const f = await fixture();
  try {
    // A fresh branch is contained in main: deletable, but kept by default.
    assert.equal((await f.service.reviewRemoval(f.w.id)).merged, 'main');
    await writeFile(path.join(f.w.path, 'file.txt'), 'feature work\n');
    const tip = await f.commit(f.w.path);
    const unmerged = await f.service.reviewRemoval(f.w.id);
    assert.equal(unmerged.merged, null);
    await assert.rejects(f.service.removeWorkspace(f.w.id, await consent(f.service, f.w.id, { discard: false, deleteBranch: true })), /not merged/);
    await access(f.w.path);
    await git(f.repo, ['merge', '--ff-only', 'feature/remove']);
    assert.equal((await f.service.reviewRemoval(f.w.id)).merged, 'main');
    await f.service.removeWorkspace(f.w.id, await consent(f.service, f.w.id, { discard: false, deleteBranch: true }));
    await assert.rejects(access(f.w.path));
    await assert.rejects(git(f.repo, ['rev-parse', '--verify', 'refs/heads/feature/remove']));
    assert.equal((await git(f.repo, ['rev-parse', 'main'])).trim(), tip);
  } finally { await f.cleanup(); }
});

test('removal without deleteBranch keeps a merged branch', async () => {
  const f = await fixture();
  try {
    await f.service.removeWorkspace(f.w.id, await consent(f.service, f.w.id, keep));
    assert.equal((await git(f.repo, ['rev-parse', 'refs/heads/feature/remove'])).trim(), f.base);
  } finally { await f.cleanup(); }
});

test('push status is informational: ahead, behind and diverged are reported but never block', async () => {
  const f = await fixture();
  try {
    await f.track();
    assert.deepEqual((await f.service.reviewRemoval(f.w.id)).push, { kind: 'known', upstream: 'origin/feature/remove', ahead: 0, behind: 0 });
    await writeFile(path.join(f.repo, 'file.txt'), 'remote commit\n');
    const remoteTip = await f.commit(f.repo);
    await git(f.repo, ['update-ref', 'refs/remotes/origin/feature/remove', remoteTip]);
    assert.deepEqual((await f.service.reviewRemoval(f.w.id)).push, { kind: 'known', upstream: 'origin/feature/remove', ahead: 0, behind: 1 });
    await writeFile(path.join(f.w.path, 'file.txt'), 'diverged\n'); const tip = await f.commit(f.w.path);
    assert.deepEqual((await f.service.reviewRemoval(f.w.id)).push, { kind: 'known', upstream: 'origin/feature/remove', ahead: 1, behind: 1 });
    await f.service.removeWorkspace(f.w.id, await consent(f.service, f.w.id, keep));
    assert.equal((await git(f.repo, ['rev-parse', 'refs/heads/feature/remove'])).trim(), tip);
  } finally { await f.cleanup(); }
});

test('detached, switched and locked worktrees cannot be removed even with discard consent', async () => {
  const f = await fixture();
  const all = { discard: true, deleteBranch: false };
  try {
    await git(f.w.path, ['checkout', '--detach']);
    assert.match((await f.service.reviewRemoval(f.w.id)).blockers.join(' '), /Detached HEAD/);
    await assert.rejects(f.service.removeWorkspace(f.w.id, await consent(f.service, f.w.id, all)), /Detached HEAD/);
    await git(f.w.path, ['checkout', '-b', 'different']);
    assert.match((await f.service.reviewRemoval(f.w.id)).blockers.join(' '), /checked-out branch changed/);
    await assert.rejects(f.service.removeWorkspace(f.w.id, await consent(f.service, f.w.id, all)), /checked-out branch changed/);
    await git(f.w.path, ['checkout', f.w.branch]);
    await git(f.repo, ['worktree', 'lock', f.w.path]);
    assert.match((await f.service.reviewRemoval(f.w.id)).blockers.join(' '), /locked/);
    await assert.rejects(f.service.removeWorkspace(f.w.id, await consent(f.service, f.w.id, all)), /locked/);
    await git(f.repo, ['worktree', 'unlock', f.w.path]);
    await access(f.w.path);
  } finally { await f.cleanup(); }
});

test('local upstream, command failure and invalid counts never claim pushed', async () => {
  const f = await fixture();
  try {
    await git(f.w.path, ['branch', '--set-upstream-to=main']);
    const local = await f.service.reviewRemoval(f.w.id);
    assert.equal(local.push.kind, 'unknown');
    assert.match(local.push.kind === 'unknown' ? local.push.message : '', /local branch/);
    const failed = await reviewPushStatus(async () => { throw new Error('private stderr'); }, 'feature');
    assert.equal(failed.push.kind, 'unknown'); assert.ok(!JSON.stringify(failed).includes('private stderr'));
    const invalid = await reviewPushStatus(async args => args[0] === 'for-each-ref' ? 'refs/remotes/origin/main' : args[0] === 'rev-parse' ? f.base : 'invalid counts', 'feature');
    assert.equal(invalid.push.kind, 'unknown');
  } finally { await f.cleanup(); }
});
