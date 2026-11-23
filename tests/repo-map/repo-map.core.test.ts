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
