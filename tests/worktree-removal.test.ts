import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitService, git } from '../electron/git';
import { Store } from '../electron/store';
import { reviewPushStatus } from '../electron/worktree-removal';

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
  const store = new Store(path.join(root, 'data')); let terminals = false;
  const service = new GitService(store, () => terminals);
  const state = await service.openRepository(repo);
  const w = (await service.createWorkspace(state.repos[0].id, 'feature/remove')).workspaces[1];
  const track = async () => {
    await git(repo, ['remote', 'add', 'origin', path.join(root, 'unused-local-remote')]);
    await git(repo, ['update-ref', 'refs/remotes/origin/feature/remove', base]);
    await git(w.path, ['branch', '--set-upstream-to=origin/feature/remove']);
  };
  return { root, repo, service, w, base, commit, track, terminal: (value: boolean) => { terminals = value; },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('missing upstream needs acknowledgement and removal keeps branch and commits', async () => {
  const f = await fixture();
  try {
    const review = await f.service.reviewRemoval(f.w.id);
    assert.equal(review.push.kind, 'unknown'); assert.deepEqual(review.blockers, []);
    await assert.rejects(f.service.removeWorkspace(f.w.id, f.w.branch), /review changed or is missing/);
    await assert.rejects(f.service.removeWorkspace(f.w.id, f.w.branch, { token: review.token, acknowledge: false }), /Acknowledge/);
    await f.service.removeWorkspace(f.w.id, f.w.branch, { token: review.token, acknowledge: true });
    await assert.rejects(access(f.w.path));
    assert.equal((await git(f.repo, ['rev-parse', 'refs/heads/feature/remove'])).trim(), f.base);
    await access(path.join(f.repo, 'file.txt'));
  } finally { await f.cleanup(); }
});

test('upstream counts are real Git history; new commits invalidate old consent', async () => {
  const f = await fixture();
  try {
    await f.track();
    const clean = await f.service.reviewRemoval(f.w.id);
    assert.deepEqual(clean.push, { kind: 'known', upstream: 'origin/feature/remove', ahead: 0, behind: 0 });
    await writeFile(path.join(f.w.path, 'file.txt'), 'local commit\n');
    const tip = await f.commit(f.w.path);
    await assert.rejects(f.service.removeWorkspace(f.w.id, f.w.branch, { token: clean.token, acknowledge: true }), /review changed/);
    const ahead = await f.service.reviewRemoval(f.w.id);
    assert.deepEqual(ahead.push, { kind: 'known', upstream: 'origin/feature/remove', ahead: 1, behind: 0 });
    await assert.rejects(f.service.removeWorkspace(f.w.id, f.w.branch, { token: ahead.token, acknowledge: false }), /Acknowledge/);
    await f.service.removeWorkspace(f.w.id, f.w.branch, { token: ahead.token, acknowledge: true });
    assert.equal((await git(f.repo, ['rev-parse', 'refs/heads/feature/remove'])).trim(), tip);
    assert.equal((await git(f.repo, ['show', `${tip}:file.txt`])).trim(), 'local commit');
  } finally { await f.cleanup(); }
});

test('behind and diverged upstream are distinguished; remote-ref changes invalidate consent', async () => {
  const f = await fixture();
  try {
    await f.track(); const before = await f.service.reviewRemoval(f.w.id);
    await writeFile(path.join(f.repo, 'file.txt'), 'remote commit\n');
    const remoteTip = await f.commit(f.repo);
    await git(f.repo, ['update-ref', 'refs/remotes/origin/feature/remove', remoteTip]);
    await assert.rejects(f.service.removeWorkspace(f.w.id, f.w.branch, { token: before.token, acknowledge: true }), /review changed/);
    assert.deepEqual((await f.service.reviewRemoval(f.w.id)).push, { kind: 'known', upstream: 'origin/feature/remove', ahead: 0, behind: 1 });
    await writeFile(path.join(f.w.path, 'file.txt'), 'diverged\n'); await f.commit(f.w.path);
    assert.deepEqual((await f.service.reviewRemoval(f.w.id)).push, { kind: 'known', upstream: 'origin/feature/remove', ahead: 1, behind: 1 });
    await git(f.repo, ['update-ref', '-d', 'refs/remotes/origin/feature/remove']);
    assert.equal((await f.service.reviewRemoval(f.w.id)).push.kind, 'unknown');
  } finally { await f.cleanup(); }
});

test('zero-ahead review permits clean removal without risk acknowledgement', async () => {
  const f = await fixture();
  try {
    await f.track(); const review = await f.service.reviewRemoval(f.w.id);
    await f.service.removeWorkspace(f.w.id, f.w.branch, { token: review.token, acknowledge: false });
    await assert.rejects(access(f.w.path));
    assert.equal((await git(f.repo, ['rev-parse', 'refs/heads/feature/remove'])).trim(), f.base);
  } finally { await f.cleanup(); }
});

test('preflight reports tracked, untracked, ignored and terminal blockers; final check refuses late changes', async () => {
  const f = await fixture();
  try {
    const before = await f.service.reviewRemoval(f.w.id);
    await writeFile(path.join(f.w.path, 'file.txt'), 'dirty\n');
    await writeFile(path.join(f.w.path, 'new.txt'), 'untracked\n');
    await mkdir(path.join(f.w.path, 'ignored')); await writeFile(path.join(f.w.path, 'ignored', 'keep'), 'secret fixture');
    f.terminal(true);
    const review = await f.service.reviewRemoval(f.w.id);
    assert.match(review.blockers.join(' '), /Close every terminal/);
    assert.match(review.blockers.join(' '), /1 tracked changes, 1 untracked entries, 1 ignored entries/);
    await assert.rejects(f.service.removeWorkspace(f.w.id, f.w.branch, { token: before.token, acknowledge: true }), /Close every terminal/);
    f.terminal(false);
    await assert.rejects(f.service.removeWorkspace(f.w.id, f.w.branch, { token: before.token, acknowledge: true }), /modified, untracked, or ignored/);
    assert.equal(await readFile(path.join(f.w.path, 'ignored', 'keep'), 'utf8'), 'secret fixture');
  } finally { await f.cleanup(); }
});

test('detached, switched and locked worktrees cannot be removed even with acknowledgement', async () => {
  const f = await fixture();
  try {
    const before = await f.service.reviewRemoval(f.w.id);
    await git(f.w.path, ['checkout', '--detach']);
    assert.match((await f.service.reviewRemoval(f.w.id)).blockers.join(' '), /Detached HEAD/);
    await assert.rejects(f.service.removeWorkspace(f.w.id, f.w.branch, { token: before.token, acknowledge: true }), /Detached HEAD/);
    await git(f.w.path, ['checkout', '-b', 'different']);
    assert.match((await f.service.reviewRemoval(f.w.id)).blockers.join(' '), /checked-out branch changed/);
    await assert.rejects(f.service.removeWorkspace(f.w.id, f.w.branch, { token: before.token, acknowledge: true }), /checked-out branch changed/);
    await git(f.w.path, ['checkout', f.w.branch]);
    await git(f.repo, ['worktree', 'lock', f.w.path]);
    assert.match((await f.service.reviewRemoval(f.w.id)).blockers.join(' '), /locked/);
    await assert.rejects(f.service.removeWorkspace(f.w.id, f.w.branch, { token: before.token, acknowledge: true }), /locked/);
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
