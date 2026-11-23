import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, GitService, Store, parseNumstat, readGitLines } from '../../electron/app/wiring/git';

const available = (added = 0, deleted = 0, binaryFiles = 0) => ({ kind: 'available', added, deleted, binaryFiles });
const commit = (repo: string) => git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
async function fixture() {
  const repo = await mkdtemp(path.join(tmpdir(), 'stingray-lines-'));
  await git(repo, ['init', '-b', 'main']);
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

test('numstat parser handles NUL names, renames and binary files without counting filenames', () => {
  assert.deepEqual(parseNumstat(''), available());
  assert.deepEqual(parseNumstat('2\t3\twith\ttab\nand newline\0' + '1\t0\t\0old\0new\0-\t-\timage\0'), available(3, 3, 1));
  for (const text of ['1\t2\tfile', 'bad\0', '-\t1\tfile\0', '1\t2\t\0old\0', '9007199254740992\t0\tfile\0']) {
    assert.throws(() => parseNumstat(text));
  }
});
test('line reads disable external diff/textconv and sanitize failed reads', async () => {
  const result = await readGitLines('/fixture', [], async (cwd, args) => {
    assert.equal(cwd, '/fixture');
    assert.deepEqual(args, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--find-renames', '--ignore-submodules=all', 'HEAD', '--']);
    return '2\t1\tfile\0';
  });
  assert.deepEqual(result, available(2, 1));
  for (const run of [async () => { throw Error('PRIVATE'); }, async () => 'truncated']) {
    const failed = await readGitLines('/fixture', [], run);
    assert.equal(failed.kind, 'unavailable'); assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
  }
  const conflict = await readGitLines('/fixture', [{ path: 'f', status: 'UU' }], async () => { throw Error('must not execute'); });
  assert.equal(conflict.kind, 'unavailable');
});
test('real Git counts net tracked edits once, excludes untracked, and handles rename, binary and detached HEAD', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, 'text'), 'original\nkeep\n');
    await writeFile(path.join(f.repo, 'rename'), 'rename me\n');
    await writeFile(path.join(f.repo, 'binary'), Buffer.from([0, 1, 2]));
    await git(f.repo, ['add', '.']); await commit(f.repo);
    // Read-only status via the real service, with metadata stored outside the checkout.
    const storeRoot = await mkdtemp(path.join(tmpdir(), 'stingray-lines-store-'));
    try {
      const service = new GitService(new Store(storeRoot));
      const state = await service.openRepository(f.repo); const id = state.workspaces[0].id;
      assert.deepEqual((await service.status(id)).lines, available());
      await writeFile(path.join(f.repo, 'text'), 'staged\nkeep\n'); await git(f.repo, ['add', 'text']);
      await writeFile(path.join(f.repo, 'text'), 'final\nkeep\nextra\n');
      await git(f.repo, ['mv', 'rename', 'name\twith\nnewline']);
      await writeFile(path.join(f.repo, 'binary'), Buffer.from([0, 3, 4]));
      await writeFile(path.join(f.repo, 'untracked'), 'excluded\n'.repeat(50));
      assert.deepEqual((await service.status(id)).lines, available(2, 1, 1));
      // Staged changes cancelled in the working tree are a zero net text diff.
      await writeFile(path.join(f.repo, 'text'), 'original\nkeep\n');
      assert.deepEqual((await service.status(id)).lines, available(0, 0, 1));
      await rm(path.join(f.repo, 'text'));
      assert.deepEqual((await service.status(id)).lines, available(0, 2, 1));
      await git(f.repo, ['checkout', '--detach']);
      assert.deepEqual((await service.status(id)).lines, available(0, 2, 1));
      assert.equal(await readFile(path.join(f.repo, 'untracked'), 'utf8'), 'excluded\n'.repeat(50));
    } finally { await rm(storeRoot, { recursive: true, force: true }); }
  } finally { await f.cleanup(); }
});
test('unborn repository and real merge conflict report unavailable instead of fabricated zero counts', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, 'text'), 'base\n'); await git(f.repo, ['add', '.']);
    assert.equal((await readGitLines(f.repo, [])).kind, 'unavailable');
    await commit(f.repo);
    await git(f.repo, ['checkout', '-b', 'other']); await writeFile(path.join(f.repo, 'text'), 'other\n');
    await git(f.repo, ['add', '.']); await commit(f.repo);
    await git(f.repo, ['checkout', 'main']); await writeFile(path.join(f.repo, 'text'), 'main\n');
    await git(f.repo, ['add', '.']); await commit(f.repo);
    await assert.rejects(git(f.repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'merge', 'other']));
    const storeRoot = await mkdtemp(path.join(tmpdir(), 'stingray-conflict-store-'));
    try {
      const service = new GitService(new Store(storeRoot));
      const state = await service.openRepository(f.repo);
      const status = await service.status(state.workspaces[0].id);
      assert.ok(status.changes.some(change => change.status === 'UU'));
      assert.equal(status.lines.kind, 'unavailable');
    } finally { await rm(storeRoot, { recursive: true, force: true }); }
  } finally { await f.cleanup(); }
});
test('line counts compare against the merge base with local origin/main, with uncommitted counts and a HEAD fallback', async () => {
  const f = await fixture();
  const storeRoot = await mkdtemp(path.join(tmpdir(), 'stingray-base-store-'));
  try {
    await writeFile(path.join(f.repo, 'text'), 'one\n'); await git(f.repo, ['add', '.']); await commit(f.repo);
    await git(f.repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await git(f.repo, ['checkout', '-b', 'feature']);
    await writeFile(path.join(f.repo, 'text'), 'one\ntwo\nthree\n'); await git(f.repo, ['add', '.']); await commit(f.repo);
    await writeFile(path.join(f.repo, 'text'), 'one\ntwo\nthree\nfour\n');
    await writeFile(path.join(f.repo, 'untracked'), 'never counted\n');
    const service = new GitService(new Store(storeRoot));
    const id = (await service.openRepository(f.repo)).workspaces[0].id;
    const seen: string[] = []; service.onStatus = observed => { seen.push(observed); };
    let status = await service.status(id);
    assert.deepEqual([status.base, status.lines, status.uncommitted], ['origin/main', available(3, 0), available(1, 0)]);
    assert.deepEqual(seen, [id]);
    // origin/main moving on with unrelated work does not change the PR-style diff (merge base, not two-dot).
    const upstream = path.join(storeRoot, 'upstream');
    await git(f.repo, ['worktree', 'add', '--detach', upstream, 'origin/main']);
    await writeFile(path.join(upstream, 'text'), 'upstream rewrite\n'); await git(upstream, ['add', '.']); await commit(upstream);
    await git(f.repo, ['update-ref', 'refs/remotes/origin/main', (await git(upstream, ['rev-parse', 'HEAD'])).trim()]);
    status = await service.status(id);
    assert.deepEqual([status.base, status.lines, status.uncommitted], ['origin/main', available(3, 0), available(1, 0)]);
    await git(f.repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
    status = await service.status(id);
    assert.deepEqual([status.base, status.lines, status.uncommitted], ['HEAD', available(1, 0), available(1, 0)]);
  } finally { await rm(storeRoot, { recursive: true, force: true }); await f.cleanup(); }
});
