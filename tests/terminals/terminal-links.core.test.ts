import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTerminalLink, resolveTerminalLink } from '../../electron/core/terminals';
import { fakeLinkTargets } from '../fakes/terminals';

const targets = fakeLinkTargets({
  '/ws/notes.md': { isFile: true, isDirectory: false, mode: 0o644 },
  '/ws/run.sh': { isFile: true, isDirectory: false, mode: 0o755 },
  '/ws/src': { isFile: false, isDirectory: true, mode: 0o755 },
  '/outside.md': { isFile: true, isDirectory: false, mode: 0o644 },
});

test('web, readable file, executable and folder targets; outside and credential links are refused', async () => {
  assert.deepEqual(await resolveTerminalLink('https://example.com/a', '/ws', targets), { kind: 'web', target: 'https://example.com/a' });
  assert.deepEqual(await resolveTerminalLink('notes.md', '/ws', targets), { kind: 'file', target: '/ws/notes.md' });
  assert.deepEqual(await resolveTerminalLink('run.sh', '/ws', targets), { kind: 'reveal', target: '/ws/run.sh' });
  assert.deepEqual(await resolveTerminalLink('src', '/ws', targets), { kind: 'reveal', target: '/ws/src' });
  await assert.rejects(resolveTerminalLink('/outside.md', '/ws', targets), /inside this terminal’s workspace/);
  await assert.rejects(resolveTerminalLink('https://u:p@example.com', '/ws', targets), /without credentials/);
  await assert.rejects(resolveTerminalLink('missing.md', '/ws', targets), /unavailable/);
});

test('a declined confirmation opens nothing', async () => {
  const opened: string[] = [];
  await openTerminalLink('notes.md', '/ws', { confirm: async () => false, openExternal: async u => { opened.push(u); }, openPath: async p => { opened.push(p); return ''; }, showItemInFolder: p => { opened.push(p); } }, targets);
  assert.deepEqual(opened, []);
});
