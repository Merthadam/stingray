import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContainerService, inspectFormat, parseContainers } from '../../electron/app/wiring/runtime';
import { belongsToWorkspace, summarizeChanges, workspacePorts } from '../../src/features/runtime/workspace-status';
import type { Workspace } from '../../shared/contracts/git';

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
test('Docker service skips remote contexts but still checks a local DOCKER_HOST', async () => {
  const calls: string[][] = [];
  const service = new ContainerService(async args => { calls.push(args); return args[0] === 'context' ? 'ssh://remote' : ''; }, { DOCKER_CONTEXT: 'remote', DOCKER_HOST: 'unix:///local.sock' });
  assert.deepEqual(await service.list(), []);
  assert.deepEqual(calls[0].slice(0, 3), ['context', 'inspect', 'remote']);
  assert.deepEqual(calls.slice(1).map(c => c.slice(0, 2)), [['--host', 'unix:///local.sock']]);
  await assert.rejects(new ContainerService(async () => 'ssh://remote', { DOCKER_CONTEXT: 'remote' }).list(), /local Docker context/);
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
test('test-env labels map a container to its workspace and mark the DevTools port', () => {
  const [c] = parseContainers(fixture({ name: '/stingray-test-wt-1a07f99-ab12', workingDir: null, mounts: [], workspace: '/projects/app', cdp: '9223', testEnv: '1',
    ports: { '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '9230' }], '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3000' }] } }));
  assert.equal(c.testEnv, true);
  assert.deepEqual(c.paths, ['/projects/app']);
  assert.deepEqual(c.ports.map(p => [p.port, p.cdp]), [[9230, true], [3000, undefined]]);
  assert.deepEqual(workspacePorts({ id: 'w', path: '/projects/app' } as Workspace, [], [c]).map(p => [p.port, p.cdp, p.testEnv, p.containerId]),
    [[3000, undefined, true, id], [9230, true, true, id]]);
  // The labels alone (settable by any image) are not enough: name or image must come from scripts/test-env.sh.
  const labelOnly = { cdp: '9223', testEnv: '1', ports: { '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '9230' }] } };
  const [spoofed] = parseContainers(fixture(labelOnly));
  assert.equal(spoofed.testEnv, false);
  assert.equal(spoofed.ports[0].cdp, undefined);
  assert.equal(parseContainers(fixture({ ...labelOnly, image: 'stingray-test-env:wt-1a07f99' }))[0].testEnv, true);
  const [plain] = parseContainers(fixture({ workspace: 'relative/path', testEnv: '' }));
  assert.equal(plain.testEnv, false);
  assert.ok(!plain.paths.includes('relative/path'));
  assert.ok(inspectFormat.includes('"stingray.workspace"') && inspectFormat.includes('"stingray.cdp"') && inspectFormat.includes('"stingray.test-env"'));
});
test('Docker discovery checks the active context and every Colima socket, deduplicating sockets and containers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'stingray-colima-'));
  for (const profile of ['default', 'work', '_lima']) { await mkdir(path.join(home, '.colima', profile), { recursive: true }); await writeFile(path.join(home, '.colima', profile, 'docker.sock'), ''); }
  await symlink(path.join(home, '.colima', 'default', 'docker.sock'), path.join(home, '.colima', 'docker.sock'));
  await mkdir(path.join(home, '.colima', 'stopped'));
  const work = 'b'.repeat(64), hosts: string[] = [];
  const service = new ContainerService(async args => {
    if (args[0] === 'context') return 'unix:///context.sock\n';
    if (args.includes('ls')) { hosts.push(args[1]); return args[1].endsWith('work/docker.sock') ? `${id}\n${work}\n` : id + '\n'; }
    return args.slice(args.indexOf(inspectFormat) + 1).map(i => fixture({ id: i, name: '/' + i.slice(0, 3) })).join('\n');
  }, { HOME: home });
  const list = await service.list();
  assert.deepEqual(hosts.sort(), ['unix:///context.sock', `unix://${home}/.colima/docker.sock`, `unix://${home}/.colima/work/docker.sock`].sort());
  assert.deepEqual(list.map(c => c.id), [id, work]);
});
test('a failing endpoint does not hide containers from a healthy one; all failing is an error', async () => {
  const run = (healthy: boolean) => async (args: string[]) => {
    if (args[0] === 'context') return 'unix:///broken.sock';
    if (args[1] === 'unix:///broken.sock' || !healthy) throw new Error('Docker is unavailable.');
    return args.includes('ls') ? id + '\n' : fixture();
  };
  assert.equal((await new ContainerService(run(true), { DOCKER_HOST: 'unix:///ok.sock', DOCKER_CONTEXT: 'x' }).list()).length, 1);
  await assert.rejects(new ContainerService(run(false), { DOCKER_HOST: 'unix:///ok.sock', DOCKER_CONTEXT: 'x' }).list(), /unavailable/);
});
test('stop and logs act only on running test-env containers, pinned to their endpoint', async () => {
  const other = 'c'.repeat(64), calls: string[][] = [];
  const service = new ContainerService(async (args, options) => {
    calls.push(args);
    if (args.includes('ls')) return `${id}\n${other}\n`;
    if (args.includes('inspect')) return [fixture({ testEnv: '1', name: '/stingray-test-wt-1-abcd' }), fixture({ id: other, testEnv: '1' })].join('\n');
    if (args.includes('logs')) { assert.equal(options?.stderr, true); return '2026-01-01T00:00:00.5Z out late\n2026-01-01T00:00:00.25Z out early\n2026-01-01T00:00:00.3Z err middle\n'; }
    return '';
  }, { DOCKER_HOST: 'unix:///local.sock' });
  assert.equal(await service.logs(id), '2026-01-01T00:00:00.25Z out early\n2026-01-01T00:00:00.3Z err middle\n2026-01-01T00:00:00.5Z out late');
  await service.stop(id);
  const stop = calls.find(c => c.includes('stop'))!;
  assert.deepEqual(stop, ['--host', 'unix:///local.sock', 'container', 'stop', '--time', '5', id]);
  await assert.rejects(service.stop(other), /test environments/);
  await assert.rejects(service.logs('d'.repeat(64)), /test environments/);
  assert.equal(calls.filter(c => c.includes('stop')).length, 1);
});
