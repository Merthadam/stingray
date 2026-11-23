import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EditorService, resolveSource, type EditorDeps } from '../../electron/app/wiring/app';

async function fixture(t: test.TestContext) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'stingray-editors-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'worktree');
  await mkdir(path.join(root, 'app'), { recursive: true });
  await writeFile(path.join(root, 'app/models.py'), 'x = 1\n');
  await writeFile(path.join(dir, 'secret.txt'), 'outside');
  return { dir, root, data: path.join(dir, 'data') };
}

function service(data: string, executables: string[], overrides: Partial<EditorDeps> = {}) {
  const calls: string[][] = [];
  const deps: EditorDeps = {
    env: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
    isExecutable: async file => executables.includes(file),
    launch: async (file, args) => { calls.push([file, ...args]); },
    showItemInFolder: file => { calls.push(['reveal', file]); },
    ...overrides,
  };
  return { calls, editors: new EditorService(data, deps) };
}

test('EditorService detects CLIs on PATH, standard folders and app bundles', async t => {
  const { data } = await fixture(t);
  assert.deepEqual(await service(data, []).editors.settings(), { selected: 'system', available: ['repo-map', 'system'] });
  const { editors } = service(data, ['/opt/homebrew/bin/cursor', '/Applications/Zed.app/Contents/MacOS/cli', '/Users/me/.local/bin/code']);
  assert.deepEqual([...(await editors.detect())], [
    ['vscode', '/Users/me/.local/bin/code'], ['cursor', '/opt/homebrew/bin/cursor'], ['zed', '/Applications/Zed.app/Contents/MacOS/cli']]);
  assert.deepEqual(await editors.settings(), { selected: 'vscode', available: ['repo-map', 'vscode', 'cursor', 'zed', 'system'] });
  // PATH wins over the bundle.
  const onPath = service(data, ['/bin/zed', '/Applications/Zed.app/Contents/MacOS/cli']).editors;
  assert.equal((await onPath.detect()).get('zed'), '/bin/zed');
});

test('EditorService persists the selected editor and ignores an unavailable choice', async t => {
  const { data } = await fixture(t);
  const { editors } = service(data, ['/usr/local/bin/code', '/usr/local/bin/zed']);
  assert.deepEqual(await editors.select('zed'), { selected: 'zed', available: ['repo-map', 'vscode', 'zed', 'system'] });
  assert.equal((await service(data, ['/usr/local/bin/code', '/usr/local/bin/zed']).editors.settings()).selected, 'zed');
  assert.equal((await service(data, ['/usr/local/bin/code']).editors.settings()).selected, 'vscode');
  await assert.rejects(editors.select('vim' as never));
});

test('EditorService opens files with each editor\'s CLI arguments', async t => {
  const { root, data } = await fixture(t);
  const file = path.join(root, 'app/models.py');
  const clis = ['/usr/local/bin/code', '/usr/local/bin/cursor', '/usr/local/bin/zed'];
  const { editors, calls } = service(data, clis);
  await editors.openSource(root, 'app/models.py', 12);
  await editors.select('cursor'); await editors.openSource(root, 'app/models.py', 3);
  await editors.select('zed'); await editors.openSource(root, 'app/models.py', 7);
  await editors.openSource(root, 'app/models.py', null);
  await editors.select('system'); await editors.openSource(root, 'app/models.py', 7);
  assert.deepEqual(calls, [
    ['/usr/local/bin/code', '-g', `${file}:12`], ['/usr/local/bin/cursor', '-g', `${file}:3`],
    ['/usr/local/bin/zed', `${file}:7`], ['/usr/local/bin/zed', file], ['/usr/bin/open', '-t', file]]);
});

test('EditorService falls back to the default text editor, then Finder, never the file\'s default app', async t => {
  const { root, data } = await fixture(t);
  const file = path.join(root, 'app/models.py');
  const tried: string[][] = [];
  const { editors, calls } = service(data, ['/usr/local/bin/code'], { launch: async (cli, args) => { tried.push([cli, ...args]); throw new Error('ENOENT'); } });
  await editors.openSource(root, 'app/models.py', 1);
  assert.deepEqual(tried, [['/usr/local/bin/code', '-g', `${file}:1`], ['/usr/bin/open', '-t', file]]);
  assert.deepEqual(calls, [['reveal', file]]);
  await writeFile(path.join(root, 'run.sh'), '#!/bin/sh\n'); await chmod(path.join(root, 'run.sh'), 0o755);
  const system = service(data, []);
  await system.editors.openSource(root, 'run.sh', 1);
  assert.deepEqual(system.calls, [['/usr/bin/open', '-t', path.join(root, 'run.sh')]]);
});

test('resolveSource rejects paths outside the worktree, symlink escapes and non-files', async t => {
  const { dir, root } = await fixture(t);
  await symlink(path.join(dir, 'secret.txt'), path.join(root, 'link.txt'));
  await symlink(dir, path.join(root, 'up'));
  await symlink('app/models.py', path.join(root, 'inside.py'));
  assert.equal(await resolveSource(root, 'inside.py'), path.join(root, 'app/models.py'));
  for (const bad of ['../secret.txt', '/etc/passwd', 'app/../../secret.txt', 'link.txt', 'up/secret.txt', 'app', '', 'missing.py', 'a\0b', 'app\\models.py']) {
    await assert.rejects(resolveSource(root, bad), Error, bad);
  }
  const { editors, calls } = service(path.join(dir, 'data'), ['/usr/local/bin/code']);
  await assert.rejects(editors.openSource(root, 'link.txt', 1));
  assert.deepEqual(calls, []);
});

test('EditorService launches real CLIs without a shell and falls back on a non-zero exit', async t => {
  const { dir, root, data } = await fixture(t);
  const bin = path.join(dir, 'bin'); await mkdir(bin);
  const out = path.join(dir, 'args.txt');
  await writeFile(path.join(bin, 'code'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\n`, { mode: 0o755 });
  await writeFile(path.join(bin, 'zed'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const opened: string[][] = [];
  const realLaunch = new EditorService(data, { showItemInFolder: () => {} });
  const editors = new EditorService(data, { env: { PATH: bin, HOME: dir }, showItemInFolder: () => {},
    launch: (cli, args) => cli === '/usr/bin/open' ? (opened.push(args), Promise.resolve()) : (realLaunch as unknown as { deps: EditorDeps }).deps.launch(cli, args) });
  await editors.openSource(root, 'app/models.py', 4);
  assert.equal(await readFile(out, 'utf8'), `-g\n${path.join(root, 'app/models.py')}:4\n`);
  await editors.select('zed');
  await editors.openSource(root, 'app/models.py', 4);
  assert.deepEqual(opened, [['-t', path.join(root, 'app/models.py')]]);
});


test('EditorService persists Repo Map without launching an external editor', async t => {
  const { root, data } = await fixture(t);
  const { editors, calls } = service(data, []);
  assert.deepEqual(await editors.select('repo-map'), { selected: 'repo-map', available: ['repo-map', 'system'] });
  assert.equal((await service(data, []).editors.settings()).selected, 'repo-map');
  await assert.rejects(editors.openSource(root, 'app/models.py', 1), /Repo Map.*renderer/);
  assert.deepEqual(calls, []);
});
