import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, rename, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitService, git } from '../electron/git';
import { Store } from '../electron/store';
import { aggregate, buildRepoTree, clusterNodes, fileKind, findFolder, inRange, reconcileSnapshot } from '../src/repo-map-model';
import { parseNumstat, repoSnapshot, readWorkingFile } from '../electron/repo-map';
import { squarify, treemap } from '../src/repo-map-layout';
import type { RepoFile, RepoSnapshot } from '../shared/contracts/repo-map';

async function fixture(unborn = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-map-'));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  await writeFile(path.join(repo, '.gitignore'), 'ignored/\n');
  await writeFile(path.join(repo, 'existing.txt'), 'original\n');
  if (!unborn) {
    await git(repo, ['add', '.']);
    await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  }
  const service = new GitService(new Store(path.join(root, 'data')));
  const state = await service.openRepository(repo);
  const id = state.workspaces[0].id;
  return { root, repo, service, id, state, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('map includes tracked, untracked and staged deletion ghosts, but excludes ignored files', async () => {
  const f = await fixture();
  try {
    await git(f.repo, ['rm', 'existing.txt']);
    await mkdir(path.join(f.repo, 'ignored')); await writeFile(path.join(f.repo, 'ignored', 'secret'), 'private');
    await writeFile(path.join(f.repo, 'new file\nwith spaces.ts'), 'new\n');
    const map = await f.service.repoSnapshot(f.id);
    assert.ok(map.files.some(file => file.path === '.gitignore' && !file.status));
    assert.ok(map.files.some(file => file.path === 'existing.txt' && file.status === 'D '));
    assert.ok(map.files.some(file => file.path === 'new file\nwith spaces.ts' && file.status === '??'));
    assert.ok(!map.files.some(file => file.path.startsWith('ignored/')));
    const deleted = await f.service.inspectFile(f.id, 'existing.txt');
    assert.equal(deleted.content, 'original\n'); assert.equal(deleted.source, 'HEAD');
    assert.match(deleted.staged, /-original/);
  } finally { await f.cleanup(); }
});

test('inspection separates staged and unstaged changes without modifying index or working file', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, 'existing.txt'), 'staged\n'); await git(f.repo, ['add', 'existing.txt']);
    await writeFile(path.join(f.repo, 'existing.txt'), 'working\n');
    const before = await readFile(path.join(f.repo, '.git/index'));
    const file = await f.service.inspectFile(f.id, 'existing.txt');
    assert.equal(file.content, 'working\n'); assert.match(file.staged, /\+staged/); assert.match(file.unstaged, /\+working/);
    assert.deepEqual(await readFile(path.join(f.repo, '.git/index')), before);
    assert.equal(await readFile(path.join(f.repo, 'existing.txt'), 'utf8'), 'working\n');
    await writeFile(path.join(f.repo, 'existing.txt'), 'changed again\n');
    assert.notEqual((await f.service.inspectFile(f.id, 'existing.txt')).revision, file.revision);
  } finally { await f.cleanup(); }
});

test('untracked and staged additions work before the first commit', async () => {
  const f = await fixture(true);
  try {
    assert.match((await f.service.inspectFile(f.id, 'existing.txt')).unstaged, /\+original/);
    await git(f.repo, ['add', 'existing.txt']);
    const file = await f.service.inspectFile(f.id, 'existing.txt');
    assert.match(file.staged, /\+original/); assert.equal(file.unstaged, '');
    await rm(path.join(f.repo, 'existing.txt'));
    const deleted = await f.service.inspectFile(f.id, 'existing.txt');
    assert.equal(deleted.source, 'index'); assert.equal(deleted.content, 'original\n');
  } finally { await f.cleanup(); }
});

test('literal pathspecs and rename origin are preserved', async () => {
  const f = await fixture();
  try {
    await git(f.repo, ['mv', 'existing.txt', '[new].txt']);
    const map = await f.service.repoSnapshot(f.id);
    assert.equal(map.changes.find(file => file.path === '[new].txt')?.originalPath, 'existing.txt');
    const renamed = await f.service.inspectFile(f.id, '[new].txt');
    assert.equal(renamed.content, 'original\n'); assert.match(renamed.staged, /existing\.txt/); assert.match(renamed.staged, /\[new\]\.txt/);
    await writeFile(path.join(f.repo, 'new.txt'), 'not this file'); await git(f.repo, ['add', 'new.txt']);
    await writeFile(path.join(f.repo, '[new].txt'), 'literal\n');
    const updated = await f.service.inspectFile(f.id, '[new].txt');
    assert.match(updated.unstaged, /\+literal/); assert.doesNotMatch(updated.staged, /not this file/);
  } finally { await f.cleanup(); }
});

test('inspector rejects traversal, ignored paths, symlinks and cross-workspace file access', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'outside'), 'DO NOT READ');
    await symlink(path.join(f.root, 'outside'), path.join(f.repo, 'link'));
    for (const value of ['../outside', '/etc/passwd', '.git/config', './existing.txt', 'a/../existing.txt', 'a\0b']) {
      await assert.rejects(f.service.inspectFile(f.id, value));
    }
    assert.match((await f.service.inspectFile(f.id, 'link')).notice, /Symlink/);
    assert.equal((await f.service.inspectFile(f.id, 'link')).content, null);
    await mkdir(path.join(f.repo, 'ignored')); await writeFile(path.join(f.repo, 'ignored/secret'), 'secret');
    await assert.rejects(f.service.inspectFile(f.id, 'ignored/secret'), /inventory/);
    await mkdir(path.join(f.repo, 'parent')); await writeFile(path.join(f.repo, 'parent/child'), 'child');
    await git(f.repo, ['add', 'parent/child']); await rm(path.join(f.repo, 'parent'), { recursive: true });
    await symlink(f.root, path.join(f.repo, 'parent'));
    assert.match((await f.service.inspectFile(f.id, 'parent/child')).notice, /Symlink/);
    const state = await f.service.createWorkspace(f.state.repos[0].id, 'separate');
    const worktree = state.workspaces[1];
    await writeFile(path.join(worktree.path, 'only-here.txt'), 'worktree-specific');
    await assert.rejects(f.service.inspectFile(f.id, 'only-here.txt'), /inventory/);
    assert.equal((await f.service.inspectFile(worktree.id, 'only-here.txt')).content, 'worktree-specific');
    await assert.rejects(f.service.repoSnapshot('not-a-workspace'), /not found/);
  } finally { await f.cleanup(); }
});

test('binary, invalid UTF-8 and large files report bounded unsupported states', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, 'binary'), Buffer.from([1, 0, 2]));
    await writeFile(path.join(f.repo, 'invalid'), Buffer.from([0xff, 0xfe]));
    await writeFile(path.join(f.repo, 'large'), 'x'.repeat(512 * 1024 + 1));
    for (const name of ['binary', 'invalid', 'large']) {
      const file = await f.service.inspectFile(f.id, name);
      assert.equal(file.content, null); assert.ok(file.notice); assert.equal(file.unstaged, '');
    }
  } finally { await f.cleanup(); }
});

test('repository external diff and textconv commands are never executed by inspection', async () => {
  const f = await fixture();
  try {
    const marker = path.join(f.root, 'executed');
    const script = path.join(f.root, 'unsafe.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    await git(f.repo, ['config', 'diff.external', script]);
    await git(f.repo, ['config', 'diff.unsafe.textconv', script]);
    await writeFile(path.join(f.repo, '.gitattributes'), '*.txt diff=unsafe\n');
    await writeFile(path.join(f.repo, 'existing.txt'), 'updated\n');
    assert.match((await f.service.inspectFile(f.id, 'existing.txt')).unstaged, /\+updated/);
    assert.deepEqual((await f.service.repoSnapshot(f.id)).files.find(file => file.path === 'existing.txt')?.lines, { added: 1, removed: 1 });
    await assert.rejects(access(marker));
  } finally { await f.cleanup(); }
});

test('Git status colors distinguish adds, edits, deletions, renames and conflicts', () => {
  for (const status of ['??', 'A ', 'AM']) assert.equal(fileKind(status), 'added');
  for (const status of [' M', 'MM', 'R ', ' T']) assert.equal(fileKind(status), 'modified');
  for (const status of [' D', 'D ', 'AD']) assert.equal(fileKind(status), 'deleted');
  for (const status of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) assert.equal(fileKind(status), 'conflict');
  assert.equal(fileKind(''), 'clean');
});

test('folder counts aggregate known lines and flag unknowns, with stable sorted grouping', () => {
  const files = [
    { path: 'src/a.ts', status: '', lines: { added: 0, removed: 0 } },
    { path: 'src/nested/b.ts', status: ' M', lines: { added: 12, removed: 3 } },
    { path: 'README.md', status: '??', lines: null },
  ];
  const tree = buildRepoTree(files);
  assert.deepEqual(aggregate(tree.children), { total: 3, changed: 2, added: 12, removed: 3, unknown: 1, weight: 3, textLines: 0, unknownSizes: 3 });
  assert.equal(findFolder(tree, 'src')!.changed, 1); assert.equal(findFolder(tree, 'missing'), undefined);
  const ids = (input: typeof files) => clusterNodes(buildRepoTree(input).children, 2).map(tile => tile.id);
  assert.deepEqual(ids(files), ids([...files].reverse().map(file => ({ ...file, status: ' D' }))));
});

test('100,000 files are all reachable through bounded groups with exact aggregate counts', () => {
  const root = buildRepoTree(Array.from({ length: 100000 }, (_, i) => ({ path: `file-${i.toString().padStart(6, '0')}.ts`, status: ' M', lines: { added: 2, removed: 1 } })));
  const seen = new Set<string>();
  let depth = 0;
  function walk(nodes: typeof root.children, level: number) {
    depth = Math.max(depth, level);
    const tiles = clusterNodes(nodes, 12);
    assert.ok(tiles.length <= 12);
    assert.deepEqual(aggregate(tiles.map(tile => tile.totals)), aggregate(nodes));
    for (const tile of tiles) {
      if (tile.node) { assert.ok(!seen.has(tile.node.path)); seen.add(tile.node.path); }
      else {
        const members = nodes.filter(node => inRange(node, tile.range!));
        assert.ok(members.length < nodes.length);
        walk(members, level + 1);
      }
    }
  }
  walk(root.children, 0);
  assert.equal(seen.size, 100000); assert.ok(depth <= 5);
  assert.equal(root.added, 200000); assert.equal(root.removed, 100000);
});

test('two-tile grouping still terminates; nested folders and unusual names are not lost', () => {
  const files = Array.from({ length: 257 }, (_, i) => ({ path: `src/nested/item ${i}\t\n.ts`, status: i % 2 ? '' : '??' }));
  const folder = findFolder(buildRepoTree(files), 'src/nested')!;
  let members = folder.children;
  const target = members.at(-1)!;
  let clicks = 0;
  while (members.length > 2) {
    const tile = clusterNodes(members, 2).find(tile => tile.node === target || tile.range && inRange(target, tile.range))!;
    assert.ok(tile);
    if (tile.node) break;
    members = members.filter(node => inRange(node, tile.range!)); clicks++;
  }
  assert.ok(members.includes(target)); assert.ok(clicks <= 8);
});

test('numstat parser preserves NUL-delimited rename paths, tabs, newlines and binary states', () => {
  const stats = parseNumstat(['12\t3\tplain.ts', '-\t-\timage.bin', '4\t5\t', 'old name\tfile', 'new\nname.ts', '0\t0\tzero', ''].join('\0'));
  assert.deepEqual(stats.get('plain.ts'), { added: 12, removed: 3 });
  assert.equal(stats.get('image.bin'), null);
  assert.deepEqual(stats.get('new\nname.ts'), { added: 4, removed: 5 });
  assert.ok(!stats.has('old name\tfile'));
  assert.deepEqual(stats.get('zero'), { added: 0, removed: 0 });
  assert.equal(parseNumstat('oops\t2\tinvalid\0').get('invalid'), null);
});

test('line counts are net HEAD to working tree, not staged plus unstaged double counting', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, 'existing.txt'), 'staged\nextra\n'); await git(f.repo, ['add', 'existing.txt']);
    await writeFile(path.join(f.repo, 'existing.txt'), 'working\n');
    const index = await readFile(path.join(f.repo, '.git/index'));
    assert.deepEqual((await f.service.repoSnapshot(f.id)).files.find(file => file.path === 'existing.txt')?.lines, { added: 1, removed: 1 });
    await writeFile(path.join(f.repo, 'existing.txt'), 'original\n');
    assert.deepEqual((await f.service.repoSnapshot(f.id)).files.find(file => file.path === 'existing.txt')?.lines, { added: 0, removed: 0 });
    assert.deepEqual(await readFile(path.join(f.repo, '.git/index')), index);
  } finally { await f.cleanup(); }
});

test('map snapshots preserve tracked-only sidebar totals separately from untracked map counts', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, 'existing.txt'), 'changed\n');
    await writeFile(path.join(f.repo, 'new.txt'), 'one\ntwo\n');
    const map = await f.service.repoSnapshot(f.id);
    assert.deepEqual(map.lines, { kind: 'available', added: 1, deleted: 1, binaryFiles: 0 });
    assert.deepEqual(map.files.find(file => file.path === 'new.txt')?.lines, { added: 2, removed: 0 });
    assert.equal(buildRepoTree(map.files).added, 3);
    assert.deepEqual((await f.service.status(f.id)).lines, map.lines);
  } finally { await f.cleanup(); }
});

test('deleted, empty and untracked files have real counts including missing final newline', async () => {
  const f = await fixture();
  try {
    await git(f.repo, ['rm', 'existing.txt']);
    await writeFile(path.join(f.repo, 'new\tname\n.txt'), 'one\ntwo');
    await writeFile(path.join(f.repo, 'empty'), '');
    const map = await f.service.repoSnapshot(f.id);
    assert.deepEqual(map.files.find(file => file.path === 'existing.txt')?.lines, { added: 0, removed: 1 });
    assert.deepEqual(map.files.find(file => file.path === 'new\tname\n.txt')?.lines, { added: 2, removed: 0 });
    assert.deepEqual(map.files.find(file => file.path === 'empty')?.lines, { added: 0, removed: 0 });
  } finally { await f.cleanup(); }
});

test('pure renames count zero; heavily edited staged renames retain old-path removals', async () => {
  const f = await fixture();
  try {
    await git(f.repo, ['mv', 'existing.txt', 'renamed.txt']);
    assert.deepEqual((await f.service.repoSnapshot(f.id)).files.find(file => file.path === 'renamed.txt')?.lines, { added: 0, removed: 0 });
    await writeFile(path.join(f.repo, 'renamed.txt'), 'entirely different\nsecond\n');
    assert.deepEqual((await f.service.repoSnapshot(f.id)).files.find(file => file.path === 'renamed.txt')?.lines, { added: 2, removed: 1 });
  } finally { await f.cleanup(); }
});

test('unborn and orphan branches count working files, including staged files', async () => {
  for (const orphan of [false, true]) {
    const f = await fixture(!orphan);
    try {
      if (orphan) await git(f.repo, ['checkout', '--orphan', 'fresh']);
      await git(f.repo, ['add', 'existing.txt']);
      await writeFile(path.join(f.repo, 'existing.txt'), 'one\ntwo\n');
      const map = await f.service.repoSnapshot(f.id);
      assert.deepEqual(map.files.find(file => file.path === 'existing.txt')?.lines, { added: 2, removed: 0 });
      await rm(path.join(f.repo, 'existing.txt'));
      assert.deepEqual((await f.service.repoSnapshot(f.id)).files.find(file => file.path === 'existing.txt')?.lines, { added: 0, removed: 0 });
    } finally { await f.cleanup(); }
  }
});

test('corrupt HEAD is unknown rather than misclassified as an unborn branch', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, '.git/refs/heads/main'), 'a'.repeat(40) + '\n');
    const map = await repoSnapshot(f.repo, { branch: 'main', changes: [{ path: 'existing.txt', status: ' M' }], lines: { kind: 'unavailable', message: 'Fixture: corrupt HEAD' }, uncommitted: { kind: 'unavailable', message: 'Fixture: corrupt HEAD' }, base: 'HEAD' });
    assert.equal(map.files.find(file => file.path === 'existing.txt')?.lines, null);
    assert.match(map.statsNotice!, /unavailable/);
  } finally { await f.cleanup(); }
});

test('grep binary and symlink sizes and conflict counts are explicit unknowns', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, 'binary'), Buffer.from([0, 1, 2]));
    await git(f.repo, ['add', 'binary']);
    await writeFile(path.join(f.repo, 'invalid'), Buffer.from([0xff]));
    await writeFile(path.join(f.repo, 'large'), 'x'.repeat(512 * 1024 + 1));
    await symlink(path.join(f.repo, 'existing.txt'), path.join(f.repo, 'link'));
    const map = await f.service.repoSnapshot(f.id);
    for (const name of ['binary', 'link']) {
      const file = map.files.find(file => file.path === name)!;
      assert.equal(file.lines, null); assert.ok(file.lineNotice);
    }
    // grep counts non-NUL text without the inspector's UTF-8 or 512 KiB restrictions.
    for (const name of ['invalid', 'large']) assert.deepEqual(map.files.find(file => file.path === name)?.lines, { added: 1, removed: 0 });
    const conflict = await repoSnapshot(f.repo, { branch: 'main', changes: [{ path: 'existing.txt', status: 'UU' }], lines: { kind: 'unavailable', message: 'Fixture: unresolved conflict' }, uncommitted: { kind: 'unavailable', message: 'Fixture: unresolved conflict' }, base: 'HEAD' });
    assert.equal(conflict.files.find(file => file.path === 'existing.txt')?.lines, null);
    assert.match(conflict.files.find(file => file.path === 'existing.txt')!.lineNotice!, /conflict/);
  } finally { await f.cleanup(); }
});

test('validated descriptor rejects a parent swap before reading outside contents', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.repo, 'parent')); await writeFile(path.join(f.repo, 'parent/file'), 'safe');
    await mkdir(path.join(f.root, 'outside')); await writeFile(path.join(f.root, 'outside/file'), 'PRIVATE');
    let readAttempted = false;
    const swappedOpen: typeof open = async (name, flags, mode) => {
      await rename(path.join(f.repo, 'parent'), path.join(f.repo, 'original-parent'));
      await symlink(path.join(f.root, 'outside'), path.join(f.repo, 'parent'));
      const handle = await open(name, flags, mode);
      const read = handle.read.bind(handle);
      handle.read = ((...args: Parameters<typeof handle.read>) => { readAttempted = true; return read(...args); }) as typeof handle.read;
      return handle;
    };
    await assert.rejects(readWorkingFile(f.repo, 'parent/file', swappedOpen), /changed/);
    assert.equal(readAttempted, false);
  } finally { await f.cleanup(); }
});

test('bounded reads complete short reads and reject growth without exceeding the byte ceiling', async () => {
  const f = await fixture();
  try {
    const content = 'line\n'.repeat(10000);
    await writeFile(path.join(f.repo, 'short'), content);
    let reads = 0;
    const shortOpen: typeof open = async (name, flags, mode) => {
      const handle = await open(name, flags, mode); const read = handle.read.bind(handle);
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        reads++; return read(buffer, offset, Math.min(length, 1024), position);
      }) as typeof handle.read;
      return handle;
    };
    assert.equal((await readWorkingFile(f.repo, 'short', shortOpen))?.toString(), content);
    assert.ok(reads > 40);
    await writeFile(path.join(f.repo, 'growing'), Buffer.alloc(512 * 1024, 65));
    let bytes = 0;
    const growingOpen: typeof open = async (name, flags, mode) => {
      const handle = await open(name, flags, mode); const read = handle.read.bind(handle);
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (!bytes) await writeFile(path.join(f.repo, 'growing'), 'B', { flag: 'a' });
        const result = await read(buffer, offset, length, position); bytes += result.bytesRead; return result;
      }) as typeof handle.read;
      return handle;
    };
    await assert.rejects(readWorkingFile(f.repo, 'growing', growingOpen), /512 KiB/);
    assert.equal(bytes, 512 * 1024 + 1);
  } finally { await f.cleanup(); }
});

test('concurrent service refreshes coalesce status collection without a queue', async () => {
  const f = await fixture();
  try {
    const status = f.service.status.bind(f.service); let calls = 0;
    f.service.status = async id => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); return status(id); };
    const results = await Promise.all(Array.from({ length: 12 }, () => f.service.repoSnapshot(f.id)));
    assert.equal(calls, 1); assert.ok(results.every(result => result === results[0]));
    await f.service.repoSnapshot(f.id);
    assert.equal(calls, 2);
  } finally { await f.cleanup(); }
});

test('staged deletion plus same-path untracked replacement preserves both diff sections', async () => {
  const f = await fixture();
  try {
    await git(f.repo, ['rm', '--cached', 'existing.txt']);
    await writeFile(path.join(f.repo, 'existing.txt'), 'replacement\nsecond\n');
    const snapshot = await f.service.repoSnapshot(f.id);
    const file = snapshot.files.find(file => file.path === 'existing.txt')!;
    assert.equal(file.untrackedReplacement, true);
    assert.deepEqual(file.lines, { added: 2, removed: 1 });
    assert.equal(file.size?.state, 'known');
    const inspected = await f.service.inspectFile(f.id, 'existing.txt');
    assert.match(inspected.staged, /-original/); assert.match(inspected.unstaged, /\+replacement/);
    assert.equal(inspected.source, 'working tree');
  } finally { await f.cleanup(); }
});

test('snapshot reconciliation preserves file identity but not actual Git/count/error changes', () => {
  const base: RepoSnapshot = { branch: 'main', changes: [], lines: { kind: 'available', added: 0, deleted: 0, binaryFiles: 0 }, uncommitted: { kind: 'available', added: 0, deleted: 0, binaryFiles: 0 }, base: 'HEAD',
    files: [{ path: 'a', status: '', lines: { added: 0, removed: 0 }, size: { state: 'known', source: 'working tree', textLines: 2 } }] };
  const idle = structuredClone(base);
  assert.equal(reconcileSnapshot(base, idle), base);
  for (const change of [{ branch: 'other' }, { statsNotice: 'Git unavailable' },
    { lines: { kind: 'unavailable' as const, message: 'unavailable' } }]) {
    const next = reconcileSnapshot(base, { ...idle, ...change });
    assert.notEqual(next, base); assert.equal(next.files, base.files);
  }
  const counted = structuredClone(base); counted.files[0].lines!.added = 1;
  assert.notEqual(reconcileSnapshot(base, counted).files, base.files);
  const renamed = structuredClone(base); renamed.files[0].originalPath = 'old';
  assert.notEqual(reconcileSnapshot(base, renamed), base);
});

test('sizes are isolated by workspace and does not alter index or source', async () => {
  const a = await fixture(); const b = await fixture();
  try {
    await writeFile(path.join(b.repo, 'existing.txt'), 'different\nsecond\n');
    const before = await readFile(path.join(a.repo, '.git/index'));
    const maps = await Promise.all([a.service.repoSnapshot(a.id), b.service.repoSnapshot(b.id)]);
    assert.equal((maps[0].files.find(f => f.path === 'existing.txt')!.size as { textLines: number }).textLines, 1);
    assert.equal((maps[1].files.find(f => f.path === 'existing.txt')!.size as { textLines: number }).textLines, 2);
    assert.deepEqual(await readFile(path.join(a.repo, '.git/index')), before);
    assert.equal(await readFile(path.join(a.repo, 'existing.txt'), 'utf8'), 'original\n');
  } finally { await a.cleanup(); await b.cleanup(); }
});

function validateGeometry(tiles: ReturnType<typeof treemap>, width: number, height: number) {
  const parents = new Map(tiles.map(tile => [tile.id, tile]));
  const groups = new Map<string, typeof tiles>();
  for (const tile of tiles) {
    for (const value of [tile.x, tile.y, tile.width, tile.height]) assert.ok(Number.isFinite(value) && value >= 0);
    assert.ok(tile.x + tile.width <= width + .001 && tile.y + tile.height <= height + .001);
    const parent = parents.get(tile.parent);
    if (parent) assert.ok(tile.x >= parent.x && tile.y >= parent.y + 20 && tile.x + tile.width <= parent.x + parent.width + .001 && tile.y + tile.height <= parent.y + parent.height + .001);
    const siblings = groups.get(tile.parent) || []; siblings.push(tile); groups.set(tile.parent, siblings);
  }
  for (const siblings of groups.values()) for (let i = 0; i < siblings.length; i++) for (let j = i + 1; j < siblings.length; j++) {
    const a = siblings[i], b = siblings[j];
    assert.ok(a.x + a.width <= b.x + .001 || b.x + b.width <= a.x + .001 || a.y + a.height <= b.y + .001 || b.y + b.height <= a.y + .001);
  }
}

test('ordered weighted layout is proportional before gutters, deterministic and Git-independent', () => {
  const rects = squarify([1, 4, 9, 16], { x: 0, y: 0, width: 700, height: 400 });
  rects.forEach((rect, i) => assert.ok(Math.abs(rect.width * rect.height / (700 * 400) - [1, 4, 9, 16][i] / 30) < .000001));
  const files: RepoFile[] = Array.from({ length: 180 }, (_, i) => ({ path: `src/feature-${i % 9}/file-${i}.ts`, status: i % 2 ? '' : ' M', size: { state: 'known', source: 'working tree', textLines: i % 17 } }));
  const tree = buildRepoTree(files);
  for (const [width, height] of [[210, 120], [460, 400], [1200, 700]]) {
    const a = treemap(tree.children, width, height);
    assert.deepEqual(a, treemap(tree.children, width, height)); validateGeometry(a, width, height);
    assert.deepEqual(a.map(({ x, y, width, height }) => [x, y, width, height]), treemap(buildRepoTree(files.map(f => ({ ...f, status: ' D' }))).children, width, height).map(({ x, y, width, height }) => [x, y, width, height]));
    assert.deepEqual(aggregate(a.filter(t => t.terminal).map(t => t.totals)), aggregate(tree.children));
  }
});

test('100k treemap stays within DOM budget, preserves exact coverage and terminates group drilldown', () => {
  const start = performance.now();
  const root = buildRepoTree(Array.from({ length: 100000 }, (_, i) => ({ path: `file-${String(i).padStart(6, '0')}`, status: '' })));
  const tiles = treemap(root.children, 1200, 700);
  assert.ok(tiles.length <= 2000); validateGeometry(tiles, 1200, 700);
  assert.equal(aggregate(tiles.filter(t => t.terminal).map(t => t.totals)).total, 100000);
  let nodes = root.children; const target = nodes.at(-1)!; let steps = 0;
  while (true) {
    const view = treemap(nodes, 210, 120);
    const tile = view.find(t => t.node === target || t.range && inRange(target, t.range)); assert.ok(tile);
    if (tile.node) break;
    const next = nodes.filter(n => inRange(n, tile.range!)); assert.ok(next.length < nodes.length); nodes = next;
    assert.ok(++steps < 20);
  }
  console.log(`100k treemap model + validation: ${(performance.now() - start).toFixed(1)}ms; ${tiles.length} nodes; ${steps} drill steps`);
});

test('deep trees and empty/unknown weights stay finite without recursive stack growth', () => {
  const path = 'x/'.repeat(1500) + 'file';
  const root = buildRepoTree([{ path, status: '' }, { path: 'empty', status: '', size: { state: 'known', textLines: 0, source: 'working tree' } }]);
  const tiles = treemap(root.children, 900, 500);
  validateGeometry(tiles, 900, 500); assert.ok(tiles.length <= 2000);
  assert.equal(aggregate(tiles.filter(t => t.terminal).map(t => t.totals)).total, 2);
  assert.equal(root.weight, 2); assert.equal(root.textLines, 0); assert.equal(root.unknownSizes, 1);
});

test('fresh snapshots follow commits: clean status and zero deltas retain new text sizes', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, 'existing.txt'), 'new\nsecond\nlast');
    const before = await f.service.repoSnapshot(f.id);
    assert.ok(before.files.find(file => file.path === 'existing.txt')?.status);
    await git(f.repo, ['add', 'existing.txt']);
    await git(f.repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'updated']);
    const after = await f.service.repoSnapshot(f.id);
    const file = after.files.find(file => file.path === 'existing.txt')!;
    assert.equal(file.status, '');
    assert.deepEqual(file.lines, { added: 0, removed: 0 });
    assert.deepEqual(file.size, { state: 'known', source: 'working tree', textLines: 3 });
    assert.notEqual(reconcileSnapshot(before, after), before);
    assert.equal(reconcileSnapshot(after, await f.service.repoSnapshot(f.id)), after);
  } finally { await f.cleanup(); }
});

test('git grep sizes count all text files in one snapshot and use removed counts for deletions', async () => {
  const f = await fixture();
  try {
    await git(f.repo, ['rm', 'existing.txt']);
    await writeFile(path.join(f.repo, 'untracked\nwith\ttabs.ts'), '// comment\n\nλ');
    await writeFile(path.join(f.repo, 'empty'), '');
    await writeFile(path.join(f.repo, 'binary'), Buffer.from([1, 0, 2]));
    await mkdir(path.join(f.repo, 'ignored')); await writeFile(path.join(f.repo, 'ignored/secret'), 'private\n');
    await Promise.all(Array.from({ length: 70 }, (_, i) => writeFile(path.join(f.repo, `new-${i}`), 'line\n')));
    const snapshot = await f.service.repoSnapshot(f.id);
    const file = (name: string) => snapshot.files.find(file => file.path === name)!;
    assert.deepEqual(file('existing.txt').size, { state: 'known', source: 'HEAD', textLines: 1 });
    assert.deepEqual(file('untracked\nwith\ttabs.ts').size, { state: 'known', source: 'working tree', textLines: 3 });
    assert.deepEqual(file('untracked\nwith\ttabs.ts').lines, { added: 3, removed: 0 });
    assert.deepEqual(file('empty').size, { state: 'known', source: 'working tree', textLines: 0 });
    assert.equal(file('binary').size?.state, 'unavailable');
    assert.equal(file('binary').lines, null);
    assert.equal(file('ignored/secret'), undefined);
    assert.equal(snapshot.files.filter(file => file.path.startsWith('new-') && file.size?.state === 'known').length, 70);
    const noStats = await repoSnapshot(f.repo, snapshot, false);
    assert.ok(noStats.files.every(file => file.lines === undefined && file.size === undefined));
  } finally { await f.cleanup(); }
});

test('git grep exit one with no matches yields empty and unavailable sizes, not a snapshot error', async () => {
  const f = await fixture(true);
  try {
    await rm(path.join(f.repo, '.gitignore')); await rm(path.join(f.repo, 'existing.txt'));
    await writeFile(path.join(f.repo, 'empty'), '');
    await writeFile(path.join(f.repo, 'binary'), Buffer.from([0]));
    const snapshot = await f.service.repoSnapshot(f.id);
    assert.equal(snapshot.files.find(file => file.path === 'empty')?.size?.state, 'known');
    assert.equal(snapshot.files.find(file => file.path === 'binary')?.size?.state, 'unavailable');
  } finally { await f.cleanup(); }
});

test('quantized layout weights stay stable for small line edits while totals stay exact', () => {
  const tree = (textLines: number) => buildRepoTree([{ path: 'file.ts', status: '', size: { state: 'known', source: 'working tree', textLines } }]);
  assert.equal(tree(100).weight, 128); assert.equal(tree(101).weight, 128);
  assert.equal(tree(100).textLines, 100); assert.equal(tree(101).textLines, 101);
  assert.equal(tree(0).weight, 1);
  assert.deepEqual(treemap(tree(100).children, 600, 400).map(t => [t.x, t.y, t.width, t.height]), treemap(tree(101).children, 600, 400).map(t => [t.x, t.y, t.width, t.height]));
});
