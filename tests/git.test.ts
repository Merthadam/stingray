import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { GitService, git, parseStatus } from '../electron/git';
import { stateSchema, urlSchema } from '../src/shared';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-test-'));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  await writeFile(path.join(repo, 'README.md'), '# Test fixture\n');
  await writeFile(path.join(repo, '.gitignore'), 'ignored/\n');
  await git(repo, ['add', '.']);
  // Fixture-only commit; never commits the app or a user's repository.
  await git(repo, ['-c', 'user.name=Stingray Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  const store = new Store(path.join(root, 'data'));
  const service = new GitService(store);
  return { root, repo, store, service, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('repository registration is canonical, persisted and idempotent', async () => {
  const f = await fixture();
  try {
    const state = await f.service.openRepository(f.repo);
    assert.equal(state.repos.length, 1); assert.equal(state.workspaces[0].managed, false);
    assert.deepEqual(await f.service.openRepository(f.repo), state);
    assert.deepEqual(await new Store(f.store.directory).load(), state);
    assert.equal((await f.service.status(state.workspaces[0].id)).changes.length, 0);
    await assert.rejects(f.service.removeWorkspace(state.workspaces[0].id, 'main'), /Only worktrees/);
  } finally { await f.cleanup(); }
});
test('worktree creation and safe deletion preserve the branch and main repository', async () => {
  const f = await fixture();
  try {
    const state = await f.service.openRepository(f.repo);
    const next = await f.service.createWorkspace(state.repos[0].id, 'feature/example');
    const w = next.workspaces[1];
    assert.equal((await f.service.status(w.id)).branch, 'feature/example');
    assert.equal(await readFile(path.join(w.path, 'README.md'), 'utf8'), '# Test fixture\n');
    await assert.rejects(f.service.removeWorkspace(w.id, 'wrong'), /exact branch/);
    const removed = await f.service.removeWorkspace(w.id, w.branch);
    assert.equal(removed.workspaces.length, 1);
    await assert.rejects(access(w.path));
    assert.ok(await git(f.repo, ['rev-parse', '--verify', 'refs/heads/feature/example']));
    assert.equal(await readFile(path.join(f.repo, 'README.md'), 'utf8'), '# Test fixture\n');
  } finally { await f.cleanup(); }
});
test('dirty, ignored files and open terminals block removal without deleting anything', async () => {
  const f = await fixture();
  try {
    const first = await f.service.openRepository(f.repo);
    const state = await f.service.createWorkspace(first.repos[0].id, 'test-safety');
    const w = state.workspaces[1];
    const busy = new GitService(f.store, () => true);
    await assert.rejects(busy.removeWorkspace(w.id, w.branch), /Close every terminal/);
    await writeFile(path.join(w.path, 'untracked.txt'), 'keep me');
    await assert.rejects(f.service.removeWorkspace(w.id, w.branch), /modified, untracked, or ignored/);
    await rm(path.join(w.path, 'untracked.txt'));
    await mkdir(path.join(w.path, 'ignored')); await writeFile(path.join(w.path, 'ignored', 'keep'), 'keep me too');
    await assert.rejects(f.service.removeWorkspace(w.id, w.branch), /modified, untracked, or ignored/);
    assert.equal(await readFile(path.join(w.path, 'ignored', 'keep'), 'utf8'), 'keep me too');
  } finally { await f.cleanup(); }
});
test('invalid and existing branch names fail without adding a workspace', async () => {
  const f = await fixture();
  try {
    const state = await f.service.openRepository(f.repo); const id = state.repos[0].id;
    for (const branch of ['--force', '../escape', 'main', 'name; touch injected', 'foo..bar']) await assert.rejects(f.service.createWorkspace(id, branch));
    assert.equal((await f.store.load()).workspaces.length, 1);
  } finally { await f.cleanup(); }
});
test('Git failures are not presented as a clean working tree', async () => {
  const f = await fixture();
  try {
    const state = await f.service.openRepository(f.repo);
    await rm(path.join(f.repo, '.git'), { recursive: true });
    await assert.rejects(f.service.status(state.workspaces[0].id), /Git operation failed/);
  } finally { await f.cleanup(); }
});
test('preview addresses persist and unsafe protocols or credential URLs are rejected', async () => {
  const f = await fixture();
  try {
    const state = await f.service.openRepository(f.repo); const id = state.workspaces[0].id;
    await f.service.preview(id, 'http://localhost:3000');
    assert.equal((await new Store(f.store.directory).load()).workspaces[0].previewUrl, 'http://localhost:3000');
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com', 'data:text/html,hi']) {
      assert.equal(urlSchema.safeParse(url).success, false); await assert.rejects(f.service.preview(id, url));
    }
  } finally { await f.cleanup(); }
});
test('corrupt saved state fails closed and is not overwritten', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-store-'));
  try {
    const target = path.join(root, 'workspaces.json'); await writeFile(target, '{broken');
    await assert.rejects(new Store(root).load(), /not overwritten/);
    assert.equal(await readFile(target, 'utf8'), '{broken');
  } finally { await rm(root, { recursive: true }); }
});
test('porcelain parser preserves spaces, newlines, and rename records', () => {
  assert.deepEqual(parseStatus(' M file with spaces\0R  new\0old\0?? line\nbreak\0'), [
    { status: ' M', path: 'file with spaces' }, { status: 'R ', path: 'new', originalPath: 'old' }, { status: '??', path: 'line\nbreak' },
  ]);
});
test('linked worktrees and their subfolders resolve to one repository project', async () => {
  const f = await fixture();
  try {
    const linked = path.join(f.root, 'external-worktree');
    await git(f.repo, ['worktree', 'add', '-b', 'external', linked]);
    await mkdir(path.join(linked, 'nested'));
    const first = await f.service.openRepository(path.join(linked, 'nested'));
    assert.equal(first.repos.length, 1);
    assert.equal(first.repos[0].path, first.workspaces[0].path);
    assert.ok(first.repos[0].path.endsWith('/repo'));
    const next = await f.service.createWorkspace(first.repos[0].id, 'feature/owned');
    assert.deepEqual(await f.service.openRepository(next.workspaces[1].path), next);
    assert.deepEqual(await f.service.openRepository(f.repo), next);
    assert.equal((await f.store.load()).repos.length, 1);
  } finally { await f.cleanup(); }
});
test('worktree creation stays in the chosen repository with multiple projects', async () => {
  const a = await fixture(); const b = await fixture();
  try {
    await a.service.openRepository(a.repo);
    const state = await a.service.openRepository(b.repo);
    const next = await a.service.createWorkspace(state.repos[1].id, 'feature/only-b');
    const created = next.workspaces.at(-1)!;
    assert.equal(created.repoId, state.repos[1].id);
    assert.ok((await git(b.repo, ['worktree', 'list', '--porcelain'])).includes('feature/only-b'));
    assert.equal((await git(a.repo, ['branch', '--list', 'feature/only-b'])).trim(), '');
    assert.deepEqual(await new Store(a.store.directory).load(), next);
  } finally { await a.cleanup(); await b.cleanup(); }
});
test('state schema bounds saved collections', () => {
  assert.equal(stateSchema.safeParse({ version: 1, repos: Array(101).fill({}), workspaces: [] }).success, false);
});
