import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openTerminalLink, resolveTerminalLink, type TerminalLinkActions } from '../electron/terminal-links';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'stingray-links-unit-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const file = path.join(workspace, 'screen shot #1.png'); await writeFile(file, 'fixture', { mode: 0o600 });
  return { root, workspace, file };
}
function recorder(approve = true) {
  const calls: string[] = [];
  const actions: TerminalLinkActions = {
    confirm: async link => { calls.push('confirm:' + link.target); return approve; },
    openExternal: async url => { calls.push('web:' + url); },
    openPath: async file => { calls.push('file:' + file); return ''; },
    showItemInFolder: file => { calls.push('reveal:' + file); },
  };
  return { calls, actions };
}

test('terminal links accept HTTP(S) without invoking a shell', async () => {
  for (const url of ['https://example.com/a?q=one&two=2#part', 'http://127.0.0.1:5178/']) {
    const { calls, actions } = recorder(); await openTerminalLink(url, '/unused', actions);
    assert.deepEqual(calls, ['confirm:' + url, 'web:' + url]);
  }
});
test('terminal links reject unsafe protocols, credentials, controls and malformed URLs', async () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'mailto:test@example.com', 'ssh://example.com',
    'https://user:secret@example.com/', 'https:example.com', '//example.com/a', ' https://example.com',
    'https://example.com/\n', 'https://example.com/%0a', 'https://example.com/%5cfoo', 'https://example.com/%zz',
    'file://remote/path', 'file:///tmp/a?query', 'file:///tmp/a#fragment', '\u202ehttps://example.com', 'x'.repeat(8193)]) {
    const { calls, actions } = recorder(); await assert.rejects(openTerminalLink(value, '/unused', actions));
    assert.deepEqual(calls, [], value);
  }
});
test('absolute and relative encoded workspace document links resolve spaces and hashes', async t => {
  const { workspace, file } = await fixture(t);
  const expected = { kind: 'file', target: file };
  assert.deepEqual(await resolveTerminalLink(pathToFileURL(file).href, workspace), expected);
  assert.deepEqual(await resolveTerminalLink('screen%20shot%20%231.png', workspace), expected);
});
test('local traversal, sibling-prefix paths and symlink escapes are rejected', async t => {
  const { root, workspace } = await fixture(t);
  const outside = path.join(root, 'outside.png'); await writeFile(outside, 'private');
  await mkdir(workspace + '-other'); await writeFile(workspace + '-other/file.png', 'private');
  await symlink(outside, path.join(workspace, 'escape.png'));
  for (const uri of ['../outside.png', '%2e%2e/outside.png', 'escape.png', pathToFileURL(outside).href, pathToFileURL(workspace + '-other/file.png').href]) {
    const { calls, actions } = recorder(); await assert.rejects(openTerminalLink(uri, workspace, actions)); assert.deepEqual(calls, []);
  }
});
test('scripts, executable documents, HTML, SVG, bundles and folders are revealed, never launched', async t => {
  const { workspace, file } = await fixture(t);
  for (const name of ['run.command', 'run.sh', 'page.html', 'image.svg', 'unknown.bin']) {
    await writeFile(path.join(workspace, name), 'fixture');
    assert.equal((await resolveTerminalLink(name, workspace)).kind, 'reveal');
  }
  for (const name of ['folder', 'Example.app']) {
    await mkdir(path.join(workspace, name));
    const { calls, actions } = recorder(); await openTerminalLink(name, workspace, actions);
    assert.ok(calls[1].startsWith('reveal:'));
  }
  await chmod(file, 0o700); assert.equal((await resolveTerminalLink(pathToFileURL(file).href, workspace)).kind, 'reveal');
});
test('confirmation cancellation makes no OS open call', async t => {
  const { workspace, file } = await fixture(t); const { calls, actions } = recorder(false);
  await openTerminalLink(pathToFileURL(file).href, workspace, actions); assert.equal(calls.length, 1);
});
test('changed symlink or executable mode while confirmation is open fails closed', async t => {
  const { workspace, file } = await fixture(t);
  const second = path.join(workspace, 'second.png'); await writeFile(second, 'fixture', { mode: 0o600 });
  const alias = path.join(workspace, 'alias.png'); await symlink(file, alias);
  const { calls, actions } = recorder();
  actions.confirm = async () => { await rm(alias); await symlink(second, alias); return true; };
  await assert.rejects(openTerminalLink('alias.png', workspace, actions), /changed/);
  actions.confirm = async () => { await chmod(file, 0o700); return true; };
  await assert.rejects(openTerminalLink(pathToFileURL(file).href, workspace, actions), /changed/);
  assert.deepEqual(calls, []);
});
test('missing files and OS opener failures surface fixed errors without raw payloads', async t => {
  const { workspace, file } = await fixture(t); const { actions } = recorder();
  await assert.rejects(openTerminalLink('missing.png', workspace, actions), /unavailable/);
  actions.openPath = async () => 'private system detail';
  await assert.rejects(openTerminalLink(pathToFileURL(file).href, workspace, actions), /^Error: The system could not open this link\.$/);
  actions.openExternal = async () => { throw new Error('private browser detail'); };
  await assert.rejects(openTerminalLink('https://example.com/', workspace, actions), /^Error: The system could not open this link\.$/);
});
