import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_VIEW_FILES, inScope, listViewFiles, loadViewPath, readViewFile, tablesView } from '../electron/views/view-file';
import type { DiagramNode, ViewResult } from '../src/views';

const valid = 'version: 1\nname: Core\nkind: tables\nuse: [sqlalchemy]\n';
const rule = (id: string) => `  - { id: ${id}, language: python, query: "(call) @c", emit: { node: { id: "@c" } } }\n`;
const sets = { flows: { yaml: `version: 1\nname: flows\nrules:\n${rule('step')}` } };

async function worktree(t: test.TestContext, files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stingray-view-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}
const entryOf = async (t: test.TestContext, text: string, extra: Record<string, string> = {}) =>
  (await readViewFile(await worktree(t, { '.stingray/views/v.yaml': text, ...extra }), 'v', sets))!;

test('readViewFile resolves use: TS extractors, builtin sets, then repo rule files', async t => {
  const e = await entryOf(t, 'version: 1\nname: Mixed\ndescription: d\nkind: flow\nuse: [sqlalchemy, flows, orm]\nrules:\n' + rule('inline') + 'exclude: [Base]\n',
    { '.stingray/rules/orm.yaml': `version: 1\nname: orm\nrules:\n${rule('model')}`, '.stingray/rules/flows.yaml': 'ignored: builtins win' });
  assert.deepEqual(e.summary, { id: 'v', name: 'Mixed', kind: 'flow', description: 'd', builtin: false, file: '.stingray/views/v.yaml', error: null });
  assert.deepEqual(e.errors, []);
  assert.deepEqual(e.ruleFiles, ['.stingray/rules/orm.yaml']);
  const view = e.view!;
  assert.deepEqual([view.id, view.builtins, view.exclude, view.include, view.graph], ['v', ['sqlalchemy'], ['Base'], [], null]);
  assert.deepEqual(view.scope, { include: ['**/*'], exclude: [] });
  assert.deepEqual(view.rules.map(r => [r.source, r.file, r.line, r.rule.id]),
    [['builtin/flows', null, 4, 'step'], ['rules/orm', '.stingray/rules/orm.yaml', 4, 'model'], ['view', '.stingray/views/v.yaml', 7, 'inline']]);
});

test('view and rule file errors carry file and line', async t => {
  const unknown = await entryOf(t, 'version: 1\nname: V\nkind: flow\nuse:\n  - flows\n  - nope\n');
  assert.equal(unknown.view, null);
  assert.deepEqual(unknown.errors, [{ file: '.stingray/views/v.yaml', line: 6, message: 'Unknown set "nope": not a builtin set and no .stingray/rules/nope.yaml' }]);
  assert.equal(unknown.summary.error, 'line 6: Unknown set "nope": not a builtin set and no .stingray/rules/nope.yaml');
  assert.equal(unknown.summary.name, 'V');

  const badRules = await entryOf(t, 'version: 1\nname: V\nkind: flow\nuse: [orm]\n', { '.stingray/rules/orm.yaml': 'version: 1\nname: orm\nrules:\n  - id: Bad\n' });
  assert.deepEqual(badRules.ruleFiles, ['.stingray/rules/orm.yaml']);
  assert.equal(badRules.errors[0].file, '.stingray/rules/orm.yaml');
  assert.match(badRules.summary.error!, /^\.stingray\/rules\/orm\.yaml:4: rules\.0\.id: Rule id must be/);

  const invalid = await entryOf(t, 'version: 1\nname: V\nkind: flow\nuse: [orm]\nbogus: 1\n');
  assert.equal(invalid.summary.error, 'line 5: Unrecognized key: "bogus"');
  assert.match((await entryOf(t, '{'))!.summary.error!, /^line \d+: Invalid YAML/);
});

test('listViewFiles reads files safely and lists invalid ones with errors', async t => {
  const root = await worktree(t, {});
  assert.deepEqual(await listViewFiles(root), []);
  const dir = path.join(root, '.stingray/views');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'core.yaml'), valid);
  await writeFile(path.join(dir, 'big.yaml'), valid + `layout: "${'x'.repeat(64 * 1024)}"\n`);
  await writeFile(path.join(dir, 'database.yaml'), valid);
  await writeFile(path.join(dir, 'Bad Name.yaml'), valid);
  await writeFile(path.join(dir, 'old.json'), '{}');
  await writeFile(path.join(root, 'outside.yaml'), valid);
  await symlink(path.join(root, 'outside.yaml'), path.join(dir, 'link.yaml'));
  const list = await listViewFiles(root);
  assert.deepEqual(list.map(v => [v.summary.id, v.summary.error]), [
    ['Bad Name.yaml', 'File name must be <slug>.yaml with a slug of 1-64 characters a-z, 0-9 or "-"'],
    ['big', 'View file is larger than 64 KiB'],
    ['core', null],
    ['database.yaml', '"database" is reserved for the builtin view; rename the file'],
    ['link', 'View file must be a regular file (symlinks are not followed)'],
  ]);
  assert.equal((await readViewFile(root, 'core'))?.summary.name, 'Core');
  assert.equal(await readViewFile(root, 'missing'), null);
  assert.equal(await readViewFile(root, 'database'), null);
  assert.equal(await readViewFile(root, 'layers'), null); // reserved for the builtin Services view
  assert.match((await readViewFile(root, 'link'))!.summary.error!, /symlinks/);

  // Symlinked rule files and rule directories are not followed.
  await writeFile(path.join(dir, 'uses.yaml'), 'version: 1\nname: U\nkind: flow\nuse: [orm]\n');
  await mkdir(path.join(root, 'elsewhere'));
  await writeFile(path.join(root, 'elsewhere/orm.yaml'), `version: 1\nname: orm\nrules:\n${rule('model')}`);
  await symlink(path.join(root, 'elsewhere'), path.join(root, '.stingray/rules'));
  assert.match((await readViewFile(root, 'uses'))!.summary.error!, /Unknown set "orm"/);
  await rm(path.join(root, '.stingray/rules'));
  await mkdir(path.join(root, '.stingray/rules'));
  await symlink(path.join(root, 'elsewhere/orm.yaml'), path.join(root, '.stingray/rules/orm.yaml'));
  assert.equal((await readViewFile(root, 'uses'))!.summary.error, '.stingray/rules/orm.yaml: Rule file must be a regular file (symlinks are not followed)');
});

test('listViewFiles ignores a symlinked views directory and caps the number of files', async t => {
  const root = await worktree(t, {});
  const other = await worktree(t, {});
  await mkdir(path.join(other, 'views'));
  await writeFile(path.join(other, 'views/core.yaml'), valid);
  await symlink(other, path.join(root, '.stingray'));
  assert.deepEqual(await listViewFiles(root), []);
  assert.equal(await readViewFile(root, 'core'), null);
  for (let i = 0; i < MAX_VIEW_FILES + 5; i++) await writeFile(path.join(other, `views/v${String(i).padStart(2, '0')}.yaml`), valid);
  await rm(path.join(root, '.stingray'));
  await mkdir(path.join(root, '.stingray'));
  await symlink(path.join(other, 'views'), path.join(root, '.stingray/views'));
  assert.deepEqual(await listViewFiles(root), []);
  await rm(path.join(root, '.stingray'), { recursive: true });
  await mkdir(path.join(root, '.stingray'));
  await rm(path.join(other, 'views/core.yaml'));
  await rename(path.join(other, 'views'), path.join(root, '.stingray/views'));
  const list = await listViewFiles(root);
  assert.equal(list.length, MAX_VIEW_FILES);
  assert.equal(list.at(-1)!.summary.id, 'v49');
});

test('loadViewPath loads any yaml view inside the worktree, defensively', async t => {
  const root = await worktree(t, { 'drafts/flow-a.yaml': 'version: 1\nname: Draft\nkind: flow\nuse: [flows]\n', 'outside/x.yaml': valid });
  const entry = await loadViewPath(root, 'drafts/flow-a.yaml', sets);
  assert.deepEqual([entry.summary.id, entry.summary.file, entry.summary.error, entry.view?.rules.length], ['flow-a', 'drafts/flow-a.yaml', null, 1]);
  assert.equal((await loadViewPath(root, path.join(root, 'drafts/flow-a.yaml'), sets)).summary.id, 'flow-a');
  assert.match((await loadViewPath(root, '../x.yaml')).summary.error!, /inside the worktree/);
  await symlink(path.join(root, 'outside'), path.join(root, 'linked'));
  assert.match((await loadViewPath(root, 'linked/x.yaml')).summary.error!, /real directory/);
  assert.match((await loadViewPath(root, 'drafts/missing.yaml')).summary.error!, /Could not read view file: ENOENT/);
  assert.match((await loadViewPath(root, 'drafts/Flow.yaml')).summary.error!, /File name must be/);
});

const node = (id: string, file: string | null, model: string, group = 'g1'): DiagramNode =>
  ({ id, label: id, kind: 'table', subtitle: model, group, fields: [], source: file === null ? null : { file, line: 1 }, symbol: null, role: null, order: null, detail: null });
const database: ViewResult = {
  id: 'database', name: 'Database', kind: 'tables', description: '', builtin: true, file: null, error: null,
  workspaceId: 'ws', computedAt: 1, truncated: false, layout: null,
  groups: [{ id: 'g1', label: 'Base', source: null }, { id: 'g2', label: 'Other', source: null }],
  nodes: [node('users', 'app/models/user.py', 'User'), node('posts', 'app/models/post.py', 'Post'),
    node('audit', 'app/audit.py', 'Audit', 'g2'), node('tests', 'tests/models.py', 'TestModel'), node('orphan', null, 'Orphan')],
  edges: [
    { id: 'fk', from: 'posts', to: 'users', fromField: null, toField: null, kind: 'foreign-key', style: 'solid', certain: true, label: null, source: null },
    { id: 'rel', from: 'posts', to: 'audit', fromField: null, toField: null, kind: 'relationship', style: 'dashed', certain: true, label: null, source: null },
    { id: 'rel2', from: 'tests', to: 'users', fromField: null, toField: null, kind: 'relationship', style: 'dashed', certain: true, label: null, source: null },
  ],
  warnings: [{ file: 'app/x.py', line: 1, message: 'a' }, { file: 'tests/x.py', line: 1, message: 'b' }, { file: null, line: null, message: 'c' }],
  stats: { filesScanned: 3, tables: 5, foreignKeys: 1, relationships: 2 },
  graph: { state: 'unavailable', message: null }, diagnostics: null,
};

test('tablesView keeps scoped, included and not excluded tables with edges and groups between them', async t => {
  const { summary, view: core } = await entryOf(t, valid + 'scope: { include: ["app/models/**"] }\ninclude: [Audit, nope]\nexclude: [posts]\n');
  const view = tablesView(database, summary, core!);
  assert.equal(view.id, 'v');
  assert.equal(view.builtin, false);
  assert.deepEqual(view.nodes.map(n => n.id), ['users', 'audit']);
  assert.deepEqual(view.edges, []);
  assert.deepEqual(view.groups.map(g => g.id), ['g1', 'g2']);
  assert.deepEqual(view.warnings.map(w => w.message), ['c']);
  assert.deepEqual(view.stats, { filesScanned: 3, tables: 2, foreignKeys: 0, relationships: 0 });

  const all = tablesView(database, summary, (await entryOf(t, valid + 'scope: { exclude: ["tests/**"] }\n')).view!);
  assert.deepEqual(all.nodes.map(n => n.id), ['users', 'posts', 'audit']);
  assert.deepEqual(all.edges.map(e => e.id), ['fk', 'rel']);
  assert.deepEqual(all.stats, { filesScanned: 3, tables: 3, foreignKeys: 1, relationships: 1 });

  assert.equal(inScope('x.py', undefined), true);
  assert.equal(inScope('a/b/x.py', { include: ['**/*.py'] }), true);
  assert.equal(inScope('a/b/x.py', { include: ['a/*.py'] }), false);
});

test('globs that could backtrack for long on the main thread are rejected', async t => {
  const errorOf = async (include: string[], exclude = include) =>
    (await entryOf(t, valid + `scope:\n  include: ${JSON.stringify(include)}\n  exclude: ${JSON.stringify(exclude)}\n`)).summary.error;
  for (const glob of ['*a*a*b', '{a,b}/**', 'a/!(x)', '+(a)', '@(a)', '**/**/**/**/x', 'a\\*']) {
    assert.match((await errorOf([glob]))!, /Unsupported glob/, glob);
  }
  for (const glob of ['**/*', 'app/models/**', '**/*_model*.py', 'a/**/b/**/c/**/*.py', 'svc/[ab]?/*.py']) {
    assert.equal(await errorOf([glob]), null, glob);
  }
  assert.match((await errorOf(Array(21).fill('**'), []))!, /scope\.include/);
});
