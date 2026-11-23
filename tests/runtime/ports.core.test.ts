import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortService } from '../../electron/core/runtime';

test('port discovery runs only on macOS (injected platform) and asks the scanner, never the OS', async () => {
  const root = { id: 't1', workspaceId: 'w1', pid: 100, title: 'Terminal 1' };
  await assert.rejects(new PortService(() => [root], async () => '', 'linux').list(), /macOS/);
  const calls: string[] = [];
  const service = new PortService(() => [root], async file => { calls.push(file); return file.endsWith('ps') ? '  100     1\n' : ''; }, 'darwin');
  assert.deepEqual(await service.list(), []);
  assert.ok(calls.length >= 1);
});
