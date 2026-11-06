import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { GitService, git } from '../electron/git';
import { cloneGit, cloneFailure } from '../electron/clone';
import { repositoryUrlSchema, cloneDestinationSchema } from '../src/shared';

// Real Git pack transfer/checkout over pipes; this is NOT live SSH authentication.
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'stingray-clone-')));
  const repo = path.join(root, 'source'); await mkdir(repo);
  const ssh = path.join(root, 'ssh-fixture');
  await writeFile(ssh, '#!/bin/sh\nfor last do :; done\nexec /bin/sh -c "$last"\n', { mode: 0o700 });
  const previous = { ...process.env };
  process.env.GIT_SSH_COMMAND = ssh;
  process.env.GIT_SSH_VARIANT = 'ssh';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  await git(repo, ['init', '-b', 'main']);
  await writeFile(path.join(repo, 'README.md'), '# Clone fixture\n');
  await git(repo, ['add', '.']);
  await git(repo, ['-c', 'user.name=Stingray Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  const store = new Store(path.join(root, 'data'));
  return { root, repo, ssh, store, service: new GitService(store), url: 'ssh://fixture@localhost' + repo,
    cleanup: async () => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); await rm(root, { recursive: true, force: true }); } };
}

test('repository addresses allow HTTPS/SSH and reject secrets, unsafe schemes and option injection', () => {
  for (const url of ['https://github.com/team/repo.git', 'ssh://git@example.com:2222/team/repo.git', 'git@example.com:team/repo.git']) assert.equal(repositoryUrlSchema.safeParse(url).success, true, url);
  for (const url of ['--upload-pack=bad', '/tmp/local', 'file:///tmp/local', 'http://host/repo', 'git://host/repo', 'ext::sh -c bad', 'https://user:secret@host/repo', 'https://token@host/repo', 'ssh://git:secret@host/repo', 'https://host/repo?token=secret', 'https://host/repo#secret', 'https://host/repo%0a', 'ssh://-oProxyCommand=bad/repo', 'git@host:-option', 'git@host:../repo', 'https://host/a/../repo', 'https://host/re po', 'https://host/a\nb', 'https://host/repo\\other', 'ssh://host/$(command)']) assert.equal(repositoryUrlSchema.safeParse(url).success, false, url);
  for (const value of ['', 'relative', '/', '/tmp/', '/tmp/../project', '/tmp/./project', '/tmp/a\n']) assert.equal(cloneDestinationSchema.safeParse(value).success, false);
});

test('clone transfers real Git files, saves once, survives restart and scopes worktrees', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.root, 'cloned');
    const state = await f.service.cloneRepository(f.url, target);
    assert.equal(state.repos.length, 1); assert.equal(state.workspaces.length, 1);
    assert.equal(state.repos[0].path, target);
    assert.equal(state.workspaces[0].managed, false);
    assert.equal(await readFile(path.join(target, 'README.md'), 'utf8'), '# Clone fixture\n');
    assert.equal((await git(target, ['remote', 'get-url', 'origin'])).trim(), f.url);
    assert.deepEqual(await new Store(f.store.directory).load(), state);
    assert.deepEqual(await f.service.openRepository(target), state);
    const next = await f.service.createWorkspace(state.repos[0].id, 'feature/clone');
    assert.equal(next.workspaces[1].repoId, state.repos[0].id);
    assert.equal((await git(f.repo, ['branch', '--list', 'feature/clone'])).trim(), '');
  } finally { await f.cleanup(); }
});

test('existing targets, files, symlinks and invalid destinations are never overwritten', async () => {
  const f = await fixture();
  try {
    const empty = path.join(f.root, 'empty'); await mkdir(empty);
    const file = path.join(f.root, 'keep'); await writeFile(file, 'preserve');
    const link = path.join(f.root, 'link'); await symlink(empty, link);
    for (const target of [empty, file, link, path.join(f.root, 'absent', 'child')]) await assert.rejects(f.service.cloneRepository(f.url, target), /exists|cannot|parent/);
    for (const target of ['relative', f.root + '/', f.root + '/../escape']) await assert.rejects(f.service.cloneRepository(f.url, target), /absolute/);
    await assert.rejects(f.service.cloneRepository('https://secret@host/repo', path.join(f.root, 'invalid')), /without passwords/);
    assert.equal(await readFile(file, 'utf8'), 'preserve');
    await assert.rejects(access(path.join(f.root, 'invalid')));
    assert.equal((await f.store.load()).repos.length, 0);
  } finally { await f.cleanup(); }
});

test('failed clone has a fixed error, no registration and supports retry in a new folder', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.cloneRepository(f.url + '-missing', path.join(f.root, 'failed')), e => (e as Error).message === cloneFailure);
    assert.equal((await f.store.load()).repos.length, 0);
    assert.equal((await f.service.cloneRepository(f.url, path.join(f.root, 'retry'))).repos.length, 1);
  } finally { await f.cleanup(); }
});

test('registration save failure preserves a completed clone for Local folder recovery', async () => {
  const f = await fixture();
  try {
    class FailingStore extends Store { override async save() { throw new Error('fixture save failure'); } }
    const target = path.join(f.root, 'recover');
    await assert.rejects(new GitService(new FailingStore(f.store.directory)).cloneRepository(f.url, target), /Clone completed.*files were preserved/);
    assert.equal((await f.store.load()).repos.length, 0);
    assert.equal(await readFile(path.join(target, 'README.md'), 'utf8'), '# Clone fixture\n');
    assert.equal((await f.service.openRepository(target)).repos.length, 1);
  } finally { await f.cleanup(); }
});

test('concurrent duplicate clone is serialized and adds only one project', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.root, 'once');
    const results = await Promise.allSettled([f.service.cloneRepository(f.url, target), f.service.cloneRepository(f.url, target)]);
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
    assert.equal((await f.store.load()).repos.length, 1);
  } finally { await f.cleanup(); }
});

test('protocol restrictions reject insteadOf rewriting to local file transport', async () => {
  const f = await fixture();
  try {
    const config = path.join(f.root, 'gitconfig');
    await writeFile(config, `[url "file://${f.repo}"]\n  insteadOf = https://fixture.invalid/repo\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
    await assert.rejects(f.service.cloneRepository('https://fixture.invalid/repo', path.join(f.root, 'rewritten')), e => (e as Error).message === cloneFailure);
    assert.equal((await f.store.load()).repos.length, 0);
  } finally { await f.cleanup(); }
});

test('clone timeout terminates its transport process group and does not expose stderr', async () => {
  const f = await fixture();
  try {
    const pidFile = path.join(f.root, 'transport.pid');
    await writeFile(f.ssh, `#!/bin/sh\necho $$ > '${pidFile}'\necho private-provider-detail >&2\nexec sleep 60\n`, { mode: 0o700 });
    const target = path.join(f.root, 'timeout'); await mkdir(target);
    const started = Date.now();
    await assert.rejects(cloneGit(f.url, target, f.root, 500), e => (e as Error).message === cloneFailure);
    assert.ok(Date.now() - started < 3000);
    const pid = Number(await readFile(pidFile, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0));
    assert.equal((await f.store.load()).repos.length, 0);
  } finally { await f.cleanup(); }
});
