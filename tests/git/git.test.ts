import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitService, Store, git, parseStatus } from '../../electron/app/wiring/git';
import { stateSchema, type RemovalResult } from '../../shared/contracts/git';
import { urlSchema } from '../../shared/contracts/common';

const consent = async (service: GitService, id: string, choice: { discard: boolean; deleteBranch: boolean }) =>
  ({ ...choice, fingerprint: (await service.reviewRemoval(id)).fingerprint });
/** The removal happened (not refused as stale). */
const notStale = (result: RemovalResult) => { assert.ok('state' in result, 'removal refused as stale'); return result; };

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
    await assert.rejects(f.service.removeWorkspace(state.workspaces[0].id, { discard: true, deleteBranch: false, fingerprint: '0'.repeat(64) }), /Only worktrees/);
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
    await assert.rejects(f.service.removeWorkspace(w.id), /Confirm the removal/);
    const { state: removed } = notStale(await f.service.removeWorkspace(w.id, await consent(f.service, w.id, { discard: false, deleteBranch: false })));
    assert.equal(removed.workspaces.length, 1);
    await assert.rejects(access(w.path));
    assert.ok(await git(f.repo, ['rev-parse', '--verify', 'refs/heads/feature/example']));
    assert.equal(await readFile(path.join(f.repo, 'README.md'), 'utf8'), '# Test fixture\n');
  } finally { await f.cleanup(); }
});
test('untracked files need discard consent; ignored files do not block removal', async () => {
  const f = await fixture();
  try {
    const first = await f.service.openRepository(f.repo);
    const state = await f.service.createWorkspace(first.repos[0].id, 'test-safety');
    const w = state.workspaces[1];
    await writeFile(path.join(w.path, 'untracked.txt'), 'keep me');
    await assert.rejects(f.service.removeWorkspace(w.id, await consent(f.service, w.id, { discard: false, deleteBranch: false })), /uncommitted changes/);
    assert.equal(await readFile(path.join(w.path, 'untracked.txt'), 'utf8'), 'keep me');
    await rm(path.join(w.path, 'untracked.txt'));
    await mkdir(path.join(w.path, 'ignored')); await writeFile(path.join(w.path, 'ignored', 'build'), 'regenerable');
    await f.service.removeWorkspace(w.id, await consent(f.service, w.id, { discard: false, deleteBranch: false }));
    await assert.rejects(access(w.path));
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
test('a removal consent without the review fingerprint is refused and removes nothing', async () => {
  const f = await fixture();
  try {
    const first = await f.service.openRepository(f.repo);
    const w = (await f.service.createWorkspace(first.repos[0].id, 'no-fingerprint')).workspaces[1];
    await assert.rejects(f.service.removeWorkspace(w.id, { discard: true, deleteBranch: false } as never), /Confirm the removal first/);
    await access(w.path);
  } finally { await f.cleanup(); }
});
test('stale consent: a file created after the review keeps the worktree; a fresh review removes it', async () => {
  const f = await fixture();
  try {
    const first = await f.service.openRepository(f.repo);
    const w = (await f.service.createWorkspace(first.repos[0].id, 'stale-consent')).workspaces[1];
    const { fingerprint } = await f.service.reviewRemoval(w.id);
    await writeFile(path.join(w.path, 'late.txt'), 'new work');
    const stale = await f.service.removeWorkspace(w.id, { discard: true, deleteBranch: false, fingerprint });
    assert.ok('stale' in stale && stale.stale.changes.paths.includes('late.txt'));
    assert.equal(await readFile(path.join(w.path, 'late.txt'), 'utf8'), 'new work');
    await f.service.removeWorkspace(w.id, await consent(f.service, w.id, { discard: true, deleteBranch: false }));
    await assert.rejects(access(w.path));
  } finally { await f.cleanup(); }
});
test('an existing branch is refused before worktree add', async () => {
  const f = await fixture();
  try {
    const state = await f.service.openRepository(f.repo);
    await git(f.repo, ['branch', 'taken']);
    await assert.rejects(f.service.createWorkspace(state.repos[0].id, 'taken'), /Branch taken already exists\. Choose another name\./);
    assert.equal((await f.store.load()).workspaces.length, 1);
  } finally { await f.cleanup(); }
});
test('a failing worktree add reports git’s reason', async () => {
  const f = await fixture();
  try {
    const state = await f.service.openRepository(f.repo);
    const parent = path.join(f.store.directory, 'worktrees', state.repos[0].id);
    await mkdir(parent, { recursive: true }); await chmod(parent, 0o500);
    try {
      await assert.rejects(f.service.createWorkspace(state.repos[0].id, 'blocked'),
        (e: Error) => /^Git operation failed: .*(denied|could not|cannot).*\. Check the repository, branch, and worktree on disk\./i.test(e.message));
    } finally { await chmod(parent, 0o700); }
  } finally { await f.cleanup(); }
});
test('status succeeds with more than 4 MiB of output', async () => {
  const f = await fixture();
  try {
    const state = await f.service.openRepository(f.repo);
    const dir = path.join(f.repo, 'many'); await mkdir(dir);
    for (let i = 0; i < 22000; i++) await writeFile(path.join(dir, `${'x'.repeat(200)}-${i}.txt`), '');
    const status = await f.service.status(state.workspaces[0].id);
    assert.ok(status.changes.length >= 22000);
  } finally { await f.cleanup(); }
});
