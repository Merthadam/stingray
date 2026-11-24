import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorService } from '../../electron/core/app';

test('openSource launches the selected editor CLI at the line; falls back to `open -t`', async () => {
  const settings = new Map<string, string>([['editor', 'vscode']]);
  const launched: [string, string[]][] = [];
  const service = new EditorService({ get: k => settings.get(k), set: (k, v) => { settings.set(k, v); } }, {
    env: { PATH: '/bin', HOME: '/home/u' }, isExecutable: async f => f === '/bin/code', showItemInFolder: () => {},
    launch: async (file, args) => { launched.push([file, args]); }, resolveSource: async (root, file) => `${root}/${file}` });
  await service.openSource('/ws', 'a.ts', 7);
  assert.deepEqual(launched, [['/bin/code', ['-g', '/ws/a.ts:7']]]);
  await service.select('system');
  await service.openSource('/ws', 'a.ts', null);
  assert.deepEqual(launched.at(-1), ['/usr/bin/open', ['-t', '/ws/a.ts']]);
});
