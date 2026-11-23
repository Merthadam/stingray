import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerService } from '../../electron/core/runtime';

test('Colima sockets come from the socket-files port and are deduplicated by real path', async () => {
  const calls: string[][] = [];
  const service = new ContainerService(async args => { calls.push(args); return args[0] === 'context' ? 'unix:///home/u/.colima/default/docker.sock' : ''; },
    { HOME: '/home/u' }, { colimaSockets: async () => ['/home/u/.colima/docker.sock', '/home/u/.colima/default/docker.sock'], realpath: async p => p.replace('/.colima/docker.sock', '/.colima/default/docker.sock') });
  assert.deepEqual(await service.list(), []);
  assert.equal(calls.filter(a => a[0] === '--host').length, 1, 'one endpoint after dedupe');
});
