import test from 'node:test';
import assert from 'node:assert/strict';
import { PortService, processOwners, parseListeners, type PortRoot } from '../electron/ports';
import { workspacePorts } from '../src/workspace-status';
import type { Workspace } from '../src/shared';

const a: PortRoot = { id: 'a', workspaceId: 'one', pid: 10, title: 'Terminal 1' };
const b: PortRoot = { id: 'b', workspaceId: 'two', pid: 20, title: 'Terminal 2' };
const table = ' 1 0\n 10 1\n 11 10\n 12 11\n 20 1\n 21 20\n 99 1\n';

test('process attribution includes descendants, excludes unrelated processes and absent roots', () => {
  const owners = processOwners(table, [a, b, { ...a, pid: 999 }]);
  assert.deepEqual([...owners.keys()], [10, 11, 12, 20, 21]);
  assert.equal(owners.get(12)?.workspaceId, 'one');
  assert.equal(owners.get(21)?.workspaceId, 'two');
  assert.equal(owners.has(99), false);
});
test('nested terminal roots belong to nearest session, with cycle protection', () => {
  const owners = processOwners('10 12\n11 10\n12 11\n', [a, { ...b, pid: 11 }]);
  assert.equal(owners.get(10)?.id, 'a');
  assert.equal(owners.get(11)?.id, 'b');
  assert.equal(owners.get(12)?.id, 'b');
});
test('machine-readable lsof parser isolates workspaces and handles IPv4/IPv6 safely', () => {
  const ports = parseListeners('p12\nf20\nn*:3000\nf21\nn[::1]:3000\nn[::]:4000\nn10.0.0.4:8000\nn127.0.0.2:9000\nn*:0\nn*:65536\np99\nn*:1234\np21\nn127.0.0.1:5000\n', processOwners(table, [a, b]));
  assert.deepEqual(ports.map(p => [p.workspaceId, p.port, p.url]), [
    ['one', 3000, 'http://127.0.0.1:3000'], ['one', 4000, 'http://[::1]:4000'],
    ['two', 5000, 'http://127.0.0.1:5000'], ['one', 9000, 'http://127.0.0.2:9000'],
  ]);
});
test('empty roots never invoke process discovery; unsupported platform is explicit', async () => {
  let calls = 0;
  assert.deepEqual(await new PortService(() => [], async () => { calls++; return ''; }).list(), []);
  assert.equal(calls, 0);
  await assert.rejects(new PortService(() => [a], async () => '', 'win32').list(), /macOS/);
});
test('scans are bounded, cached/coalesced, and lsof uses AND selectors', async () => {
  const calls: { file: string; args: string[] }[] = [];
  const service = new PortService(() => [a], async (file, args) => {
    calls.push({ file, args }); await new Promise(r => setTimeout(r, 5));
    return file === '/bin/ps' ? table : 'p12\nn*:3000\n';
  }, 'darwin');
  const results = await Promise.all([service.list(), service.list(), service.list()]);
  assert.equal(calls.length, 2);
  assert.equal(results[0][0].port, 3000);
  assert.deepEqual(calls[0].args, ['-axo', 'pid=,ppid=']);
  assert.deepEqual(calls[1].args, ['-a', '-p', '10,11,12', '-iTCP', '-sTCP:LISTEN', '-n', '-P', '-Fpn']);
});
test('closing a session during a scan discards its results and new roots invalidate cache', async () => {
  let roots = [a];
  const service = new PortService(() => roots, async file => {
    if (file === '/bin/ps') return table;
    roots = [];
    return 'p12\nn*:3000\n';
  }, 'darwin');
  assert.deepEqual(await service.list(), []);
  assert.deepEqual(await service.list(), []);
  roots = [b];
  assert.deepEqual(await service.list(), []);
});
test('scanner errors are not converted into healthy empty results and retries recover', async () => {
  let failed = true;
  const service = new PortService(() => [a], async file => {
    if (failed) throw new Error('fixture scan failure');
    return file === '/bin/ps' ? table : '';
  }, 'darwin');
  await assert.rejects(service.list(), /fixture scan failure/);
  failed = false;
  assert.deepEqual(await service.list(), []);
  assert.throws(() => processOwners('unparseable', [a]), /Could not scan/);
  assert.throws(() => processOwners('10 1\n' + Array.from({length: 513}, (_,i) => `${100+i} 10`).join('\n'), [a]), /limit 512/);
});
test('workspace badges merge only associated Docker ports and deduplicate terminal listeners', () => {
  const w = { id: 'one', path: '/workspace' } as Workspace;
  const terminal = { workspaceId: 'one', port: 3000, url: 'http://127.0.0.1:3000', label: 'Terminal', source: 'terminal' as const };
  const container = { id: 'c', name: 'web', image: 'node', state: 'running', health: '', paths: ['/workspace'], ports: [{ port: 3000, target: '3000/tcp', url: terminal.url }] };
  assert.deepEqual(workspacePorts(w, [terminal, {...terminal, workspaceId: 'two', port: 4000}], [container, {...container, paths: ['/workspace-other'], ports: [{port: 9000, target:'9000/tcp',url:'http://127.0.0.1:9000'}]}]), [terminal]);
});
