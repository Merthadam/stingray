import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveViewAs, viewSlug } from '../../electron/core/views/save-view';
import { readViewFile } from '../../electron/core/views/view-file';
import { parseViewYaml } from '../../electron/core/views/rules/schema';

async function worktree(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-save-view-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const read = (root: string, file: string) => readFile(path.join(root, file), 'utf8');

test('viewSlug derives file slugs from names', () => {
  assert.equal(viewSlug('Core tables'), 'core-tables');
  assert.equal(viewSlug('  Café / Orders!! '), 'cafe-orders');
  assert.equal(viewSlug('x'.repeat(70)), 'x'.repeat(64));
  assert.equal(viewSlug('日本'), '');
  assert.equal(viewSlug('Résumé items'), 'resume-items');
});

test('saveViewAs writes a tables view from the builtin database view', async t => {
  const root = await worktree(t);
  const result = await saveViewAs(root, { name: 'Core tables', basedOn: 'database', exclude: ['audit', 'audit'], layout: { positions: { users: { x: 10, y: -20.5 } } } });
  assert.deepEqual(result, { id: 'core-tables', file: '.stingray/views/core-tables.yaml' });
  const text = await read(root, result.file);
  assert.match(text, /users: \{ x: 10, y: -20.5 \}/);
  const def = parseViewYaml(text, result.file);
  assert.equal(def.name, 'Core tables'); assert.equal(def.kind, 'tables');
  assert.deepEqual(def.use.map(u => u.name), ['sqlalchemy', 'sql']);
  assert.deepEqual(def.exclude, ['audit']);
  assert.deepEqual(def.layout, { positions: { users: { x: 10, y: -20.5 } } });
  // Readable as a view and carrying its layout.
  assert.deepEqual((await readViewFile(root, 'core-tables'))?.layout, { positions: { users: { x: 10, y: -20.5 } } });

  const plain = await saveViewAs(root, { name: 'Plain', basedOn: 'database', exclude: [], layout: null });
  assert.equal(await read(root, plain.file), 'version: 1\nname: Plain\nkind: tables\nuse:\n  - sqlalchemy\n  - sql\n');
});

test('saveViewAs writes a layers view from the builtin Services view; "layers" is reserved', async t => {
  const root = await worktree(t);
  const saved = await saveViewAs(root, { name: 'My services', basedOn: 'layers', exclude: ['(unassigned)'], layout: null });
  assert.equal(await read(root, saved.file), 'version: 1\nname: My services\nkind: graph\nlayers:\n  depth: 1\nexclude:\n  - (unassigned)\n');
  assert.deepEqual((await readViewFile(root, 'my-services'))?.view?.layers, { depth: 1 });
  await assert.rejects(saveViewAs(root, { name: 'Layers', basedOn: 'layers', exclude: [], layout: null }), /reserved/);
});

test('saveViewAs copies a repo view keeping comments, merging exclude and replacing layout', async t => {
  const root = await worktree(t);
  await mkdir(path.join(root, '.stingray/views'), { recursive: true });
  await writeFile(path.join(root, '.stingray/views/core.yaml'), [
    '# Core tables of the app',
    'version: 1',
    'name: Core',
    'kind: tables',
    'use: [sqlalchemy] # ORM models',
    'scope: { include: ["app/models/**"] }',
    'exclude: [Post]',
    'layout:',
    '  positions:',
    '    old: { x: 1, y: 1 }',
    '',
  ].join('\n'));
  const result = await saveViewAs(root, { name: 'Core slim', basedOn: 'core', exclude: ['Post', 'tags'], layout: { positions: { users: { x: 0, y: 5 } } } });
  const text = await read(root, result.file);
  assert.equal(text, [
    '# Core tables of the app',
    'version: 1',
    'name: Core slim',
    'kind: tables',
    'use: [ sqlalchemy ] # ORM models',
    'scope: { include: [ "app/models/**" ] }',
    'exclude: [ Post, tags ]',
    'layout:',
    '  positions:',
    '    users: { x: 0, y: 5 }',
    '',
  ].join('\n'));

  const kept = await saveViewAs(root, { name: 'Core copy', basedOn: 'core', exclude: [], layout: null });
  const copy = parseViewYaml(await read(root, kept.file), kept.file);
  assert.deepEqual(copy.layout, { positions: { old: { x: 1, y: 1 } } });
  assert.deepEqual(copy.exclude, ['Post']);
});

test('saveViewAs adds exclude to a repo view without one', async t => {
  const root = await worktree(t);
  await mkdir(path.join(root, '.stingray/views'), { recursive: true });
  await writeFile(path.join(root, '.stingray/views/flow.yaml'), 'version: 1\nname: Flow\nkind: tables\nuse: [sqlalchemy]\n');
  const result = await saveViewAs(root, { name: 'Flow 2', basedOn: 'flow', exclude: ['a'], layout: null });
  assert.deepEqual(parseViewYaml(await read(root, result.file), result.file).exclude, ['a']);
});

test('saveViewAs refuses existing files, bad names, unknown or invalid bases and symlinked folders', async t => {
  const root = await worktree(t);
  const input = { name: 'Core', basedOn: 'database', exclude: [], layout: null };
  await saveViewAs(root, input);
  const before = await read(root, '.stingray/views/core.yaml');
  await assert.rejects(saveViewAs(root, { ...input, exclude: ['x'] }), /core\.yaml already exists/);
  assert.equal(await read(root, '.stingray/views/core.yaml'), before);
  for (const name of ['', '   ', 'x'.repeat(81), '日本', 'Database', 'a\nb']) await assert.rejects(saveViewAs(root, { ...input, name }), Error, name);
  await assert.rejects(saveViewAs(root, { ...input, name: 'N1', basedOn: 'missing' }), /Could not read/);
  await assert.rejects(saveViewAs(root, { ...input, name: 'N2', basedOn: '../x' }), /Unknown view/);
  await writeFile(path.join(root, '.stingray/views/bad.yaml'), 'version: 1\nname: Bad\nkind: nope\nuse: [x]\n');
  await assert.rejects(saveViewAs(root, { ...input, name: 'N3', basedOn: 'bad' }), /kind/);
  await assert.rejects(saveViewAs(root, { ...input, name: 'N4', exclude: Array.from({ length: 501 }, (_, i) => `t${i}`) }), /exclude/);

  const other = await worktree(t), outside = await worktree(t);
  await mkdir(path.join(other, '.stingray'));
  await symlink(outside, path.join(other, '.stingray/views'));
  await assert.rejects(saveViewAs(other, input), /must be a real directory/);

  const full = await worktree(t);
  await mkdir(path.join(full, '.stingray/views'), { recursive: true });
  for (let i = 0; i < 50; i++) await writeFile(path.join(full, `.stingray/views/v${i}.yaml`), '');
  await assert.rejects(saveViewAs(full, input), /limit is 50/);
});
