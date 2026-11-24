import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RepoMapService, repoSnapshot } from '../../electron/core/repo-map';
import { provideHasher, resetCorePorts } from '../../electron/core/shared/ports';
import type { GitStatus } from '../../shared/contracts/git';
import { fakeHasher } from '../fakes/git';
import { memoryFiles, scriptedInventory } from '../fakes/repo-map';

const status = (changes: GitStatus['changes']): GitStatus => ({ branch: 'main', changes, lines: { kind: 'available', added: 0, deleted: 0, binaryFiles: 0 }, uncommitted: { kind: 'available', added: 0, deleted: 0, binaryFiles: 0 }, base: 'HEAD' });
beforeEach(() => provideHasher(fakeHasher));
afterEach(() => resetCorePorts());

test('snapshot assembly: inventory + staged-deletion ghosts, net counts, sizes from grep', async () => {
  const { inventory } = scriptedInventory({ lsFiles: 'a.ts\0b.ts\0', numstat: '3\t1\ta.ts\0-\t-\tgone.ts\0', grep: 'a.ts\x0010\nb.ts\x005\n' });
  const map = await repoSnapshot('/repo', status([{ path: 'a.ts', status: ' M' }, { path: 'gone.ts', status: 'D ' }]), true, { inventory, files: memoryFiles({ 'a.ts': 'x', 'b.ts': 'y' }) });
  assert.deepEqual(map.files.map(f => f.path), ['a.ts', 'b.ts', 'gone.ts']);
  assert.deepEqual(map.files[0].lines, { added: 3, removed: 1 });
  assert.deepEqual(map.files[1].lines, { added: 0, removed: 0 });
  assert.deepEqual(map.files[0].size, { state: 'known', source: 'working tree', textLines: 10 });
  assert.equal(map.statsNotice, '1 changed file(s) have unavailable line counts; totals include known counts only.');
});

test('unborn HEAD: untracked lines come from sizes', async () => {
  const { inventory } = scriptedInventory({ lsFiles: 'new.ts\0', grep: 'new.ts\x007\n', head: 'unborn' });
  const map = await repoSnapshot('/repo', status([{ path: 'new.ts', status: '??' }]), true, { inventory, files: memoryFiles({ 'new.ts': 'z' }) });
  assert.deepEqual(map.files[0].lines, { added: 7, removed: 0 });
});

test('RepoMapService shares one in-flight snapshot per worktree and inspects through the ports', async () => {
  const { inventory, calls } = scriptedInventory({ lsFiles: 'a.ts\0', grep: 'a.ts\x001\n' });
  let statusCalls = 0;
  const service = new RepoMapService({
    git: { workspace: async id => ({ id, repoId: id, name: 'w', branch: 'main', path: '/repo', managed: false, previewUrl: '' }), status: async () => { statusCalls++; return status([]); } },
    inventory, files: memoryFiles({ 'a.ts': 'hello\n' }),
  });
  const [one, two] = await Promise.all([service.repoSnapshot('w'), service.repoSnapshot('w')]);
  assert.equal(one, two);
  assert.equal(statusCalls, 1);
  const inspection = await service.inspectFile('w', 'a.ts');
  assert.equal(inspection.content, 'hello\n');
  assert.match(inspection.revision, /^[0-9a-f]{64}$/);
  assert.ok(calls.every(c => c[0] !== 'status'), 'status comes from the git port, not the inventory');
});

test('rule 2: a failing size measurement marks sizes unavailable and still returns the snapshot', async () => {
  const { inventory } = scriptedInventory({ lsFiles: 'a.ts\0new.ts\0', numstat: '1\t0\ta.ts\0', grep: new Error('Repository inventory exceeds the 16 MiB / 15 second limit, or Git is unavailable.') });
  const map = await repoSnapshot('/repo', status([{ path: 'a.ts', status: ' M' }, { path: 'new.ts', status: '??' }]), true, { inventory, files: memoryFiles({ 'a.ts': 'x', 'new.ts': 'y' }) });
  assert.ok(map.files.every(f => f.size?.state === 'unavailable' && f.size.reason === 'Size measurement failed or exceeded limits'));
  assert.equal(map.files.find(f => f.path === 'new.ts')!.lines, null);
  assert.match(map.statsNotice!, /size measurement failed/i);
});

function cachedService() {
  const { inventory, calls } = scriptedInventory({ lsFiles: 'a.ts\0', grep: 'a.ts\x001\n' });
  let statusCalls = 0;
  const service = new RepoMapService({
    git: { workspace: async id => ({ id, repoId: id, name: 'w', branch: 'main', path: '/repo', managed: false, previewUrl: '' }), status: async () => { statusCalls++; return status([]); } },
    inventory, files: memoryFiles({ 'a.ts': 'hello\n', 'new.ts': 'n\n' }),
  });
  return { service, calls, statusCalls: () => statusCalls };
}

test('after a snapshot, inspectFile runs no status or ls-files; an uncached path falls back; forget drops the cache', async () => {
  const s = cachedService();
  await s.service.repoSnapshot('w');
  const before = { status: s.statusCalls(), lsFiles: s.calls.filter(c => c[0] === 'ls-files').length };
  await s.service.inspectFile('w', 'a.ts');
  assert.deepEqual({ status: s.statusCalls(), lsFiles: s.calls.filter(c => c[0] === 'ls-files').length }, before);
  await assert.rejects(s.service.inspectFile('w', 'new.ts'), /inventory/); // not in the scripted inventory: today's computation, today's error
  assert.equal(s.statusCalls(), before.status + 1, 'uncached path falls back to status + ls-files');
  s.service.forget('w');
  await s.service.inspectFile('w', 'a.ts');
  assert.equal(s.statusCalls(), before.status + 2);
});

test('statFile makes no git calls and validates the path like inspectFile', async () => {
  const s = cachedService();
  assert.deepEqual(await s.service.statFile('w', 'a.ts'), { exists: true, size: 6, mtimeMs: 1 });
  assert.deepEqual(await s.service.statFile('w', 'gone.ts'), { exists: false, size: 0, mtimeMs: 0 });
  await assert.rejects(s.service.statFile('w', '../x'));
  assert.equal(s.calls.length, 0); assert.equal(s.statusCalls(), 0);
});

test('a snapshot that finishes after forget is not cached for the forgotten workspace', async () => {
  const { inventory } = scriptedInventory({ lsFiles: 'a.ts\0', grep: 'a.ts\x001\n' });
  let statusCalls = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const service = new RepoMapService({
    git: { workspace: async id => ({ id, repoId: id, name: 'w', branch: 'main', path: '/repo', managed: false, previewUrl: '' }), status: async () => { if (++statusCalls === 1) await held; return status([]); } },
    inventory, files: memoryFiles({ 'a.ts': 'hello\n' }),
  });
  const loading = service.repoSnapshot('w');
  await new Promise(resolve => setImmediate(resolve));
  service.forget('w'); release(); await loading;
  await service.inspectFile('w', 'a.ts');
  assert.equal(statusCalls, 2, 'inspectFile falls back to a fresh status read instead of the forgotten snapshot');
});

const branchStatus = (changes: GitStatus['changes']): GitStatus => ({ ...status(changes), base: 'origin/main' });
const sha = 'b'.repeat(40);

test('branch scope: committed-only files from name-status, numstat against the merge-base', async () => {
  const { inventory, calls } = scriptedInventory({ lsFiles: 'a.ts\0new.ts\0c.ts\0', mergeBase: sha + '\n',
    nameStatus: 'M\0a.ts\0D\0gone.ts\0R090\0old.ts\0c.ts\0', numstat: '2\t1\ta.ts\x000\t4\tgone.ts\x001\t1\t\0old.ts\0c.ts\0', grep: 'a.ts\x002\nnew.ts\x003\nc.ts\x001\n' });
  const map = await repoSnapshot('/repo', branchStatus([{ path: 'new.ts', status: '??' }]), true, { inventory, files: memoryFiles({ 'a.ts': 'x', 'new.ts': 'y', 'c.ts': 'z' }) });
  assert.equal(map.baseCommit, sha); assert.equal(map.scope, 'branch');
  const file = (name: string) => map.files.find(f => f.path === name)!;
  assert.deepEqual([file('a.ts').status, file('a.ts').committed, file('a.ts').lines], ['M ', true, { added: 2, removed: 1 }]);
  assert.deepEqual([file('gone.ts').status, file('gone.ts').lines, file('gone.ts').size], ['D ', { added: 0, removed: 4 }, { state: 'known', source: 'origin/main', textLines: 4 }]);
  assert.deepEqual([file('c.ts').status, file('c.ts').originalPath, file('c.ts').lines], ['R ', 'old.ts', { added: 1, removed: 1 }]);
  assert.deepEqual([file('new.ts').committed, file('new.ts').lines], [undefined, { added: 3, removed: 0 }]);
  assert.ok(calls.some(c => c[0] === 'diff' && c[1] === sha), 'numstat compares with the merge-base');
});

test('branch scope falls back to HEAD when the merge-base fails; uncommitted scope never asks for it', async () => {
  for (const [scope, answers] of [['branch', { mergeBase: new Error('unrelated') }], ['branch', { mergeBase: 'not-a-sha' }], ['uncommitted', { mergeBase: sha }]] as const) {
    const { inventory, calls } = scriptedInventory({ lsFiles: 'a.ts\0', numstat: '1\t0\ta.ts\0', grep: 'a.ts\x001\n', ...answers });
    const map = await repoSnapshot('/repo', branchStatus([{ path: 'a.ts', status: ' M' }]), true, { inventory, files: memoryFiles({ 'a.ts': 'x' }) }, scope);
    assert.equal(map.baseCommit, undefined); assert.equal(map.scope, scope);
    assert.ok(!calls.some(c => c[1] === '--name-status'));
    assert.ok(calls.some(c => c[0] === 'diff' && c[1] === 'HEAD'));
    assert.equal(calls.some(c => c[0] === 'merge-base'), scope === 'branch');
  }
});

test('RepoMapService caches and dedupes per scope; inspectFile reads the requested scope snapshot', async () => {
  const { inventory, calls } = scriptedInventory({ lsFiles: 'a.ts\0', grep: 'a.ts\x001\n', mergeBase: sha, nameStatus: 'D\0gone.ts\0' });
  let statusCalls = 0;
  const service = new RepoMapService({
    git: { workspace: async id => ({ id, repoId: id, name: 'w', branch: 'b', path: '/repo', managed: false, previewUrl: '' }), status: async () => { statusCalls++; return branchStatus([]); } },
    inventory, files: memoryFiles({ 'a.ts': 'hello\n' }),
  });
  const [branch, uncommitted] = await Promise.all([service.repoSnapshot('w'), service.repoSnapshot('w', 'uncommitted')]);
  assert.equal(statusCalls, 2); assert.notEqual(branch, uncommitted);
  assert.ok(branch.files.some(f => f.path === 'gone.ts')); assert.ok(!uncommitted.files.some(f => f.path === 'gone.ts'));
  const gone = await service.inspectFile('w', 'gone.ts');
  assert.equal(statusCalls, 2, 'cached branch snapshot');
  assert.deepEqual(calls.filter(c => c[0] === 'show').map(c => c[1]), [`${sha}:gone.ts`]);
  assert.equal(gone.source, 'origin/main');
  await assert.rejects(service.inspectFile('w', 'gone.ts', 'uncommitted'), /inventory/);
});
