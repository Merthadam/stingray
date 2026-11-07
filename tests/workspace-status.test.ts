import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerService, inspectFormat, parseContainers } from '../electron/containers';
import { belongsToWorkspace, summarizeChanges } from '../src/workspace-status';

const id = 'a'.repeat(64);
const fixture = (overrides = {}) => JSON.stringify({ id, name: '/web', image: 'node:24', state: 'running', health: 'healthy', workingDir: '/projects/app', mounts: [{ Type: 'bind', Source: '/projects/app/src' }], ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }, { HostIp: '::', HostPort: '8080' }] }, ...overrides });

test('Git summary distinguishes staged, unstaged, untracked and all conflict codes', () => {
  const status = { branch: 'main', changes: ['M ', ' M', 'MM', '??', 'R ', ' D', 'DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].map(status => ({ path: 'file', status })) };
  assert.deepEqual(summarizeChanges(status), { staged: 3, unstaged: 3, untracked: 1, conflicts: 7 });
  assert.deepEqual(summarizeChanges({ branch: 'main', changes: [] }), { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
});
test('container discovery maps host ports, not internal ports, and supports IPv6', () => {
  const [c] = parseContainers(fixture());
  assert.equal(c.name, 'web');
  assert.deepEqual(c.ports, [{ port: 8080, target: '3000/tcp', url: 'http://127.0.0.1:8080' }, { port: 8080, target: '3000/tcp', url: 'http://[::1]:8080' }]);
  assert.equal(belongsToWorkspace(c, '/projects/app'), true);
  assert.equal(belongsToWorkspace(c, '/projects/another'), false);
  assert.equal(belongsToWorkspace({ ...c, paths: ['/projects/application'] }, '/projects/app'), false);
  assert.equal(belongsToWorkspace({ ...c, paths: ['/projects/app/src'] }, '/projects/app/'), true);
  assert.equal(belongsToWorkspace({ ...c, paths: ['/projects/app'] }, '/projects/app/worktree'), false);
});
test('stopped containers, UDP, unpublished ports, LAN bindings and invalid ports have no quick links', () => {
  assert.deepEqual(parseContainers(fixture({ state: 'exited' })), []);
  const [c] = parseContainers(fixture({ ports: { '80/tcp': null, '53/udp': [{ HostIp: '0.0.0.0', HostPort: '5353' }], '90/tcp': [{ HostIp: '192.168.1.5', HostPort: '9000' }, { HostIp: '0.0.0.0', HostPort: '0' }, { HostIp: '0.0.0.0', HostPort: '65536' }, { HostIp: '0.0.0.0', HostPort: '80/path' }] } }));
  assert.deepEqual(c.ports, []);
  assert.deepEqual(parseContainers(fixture({ ports: null, mounts: null, workingDir: null }))[0].paths, []);
  assert.throws(() => parseContainers('not json'));
});
test('Docker service pins local endpoint, requests only safe fields, deduplicates and caches reads', async () => {
  const calls: string[][] = [];
  const service = new ContainerService(async args => {
    calls.push(args);
    if (args[0] === 'context') return 'unix:///test/docker.sock\n';
    if (args.includes('ls')) return id + '\n';
    return fixture();
  }, {});
  const [a, b] = await Promise.all([service.list(), service.list()]);
  assert.deepEqual(a, b); await service.list();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].slice(0, 2), ['--host', 'unix:///test/docker.sock']);
  assert.ok(calls[2].includes(inspectFormat));
  assert.ok(!inspectFormat.includes('.Config.Env'));
  assert.ok(!inspectFormat.includes('{{json .}}'));
});
test('Docker service refuses remote contexts and honors context precedence over DOCKER_HOST', async () => {
  const calls: string[][] = [];
  const service = new ContainerService(async args => { calls.push(args); return 'ssh://remote'; }, { DOCKER_CONTEXT: 'remote', DOCKER_HOST: 'unix:///local.sock' });
  await assert.rejects(service.list(), /local Docker context/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['context', 'inspect', 'remote']);
  await assert.rejects(new ContainerService(async () => { throw Error('must not execute'); }, { DOCKER_HOST: 'tcp://remote:2375' }).list(), /local Docker context/);
});
test('empty Docker list succeeds without inspect; failed reads recover and invalid IDs are refused', async () => {
  let fail = true;
  const service = new ContainerService(async args => {
    if (fail) throw Error('Docker unavailable');
    assert.ok(args.includes('ls')); return '';
  }, { DOCKER_HOST: 'unix:///local.sock' });
  await assert.rejects(service.list(), /unavailable/); fail = false;
  assert.deepEqual(await service.list(), []);
  const invalid = new ContainerService(async () => '--unsafe', { DOCKER_HOST: 'unix:///local.sock' });
  await assert.rejects(invalid.list(), /unsupported container list/);
});
