import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli, worktreeRoot, type CliDeps } from '../electron/views-cli';
import type { EvaluateInput, EvaluateOutput, ResolvedView } from '../electron/views/rules/types';
import type { DbSchemaResult } from '../src/db-schema';
import type { DiagramNode, RuleDiagnostic, ViewResult, ViewSummary } from '../src/views';

const summary: ViewSummary = { id: 'flow', name: 'Agent flow', kind: 'flow', description: '', builtin: false, file: '.stingray/views/flow.yaml', error: null };
const view: ResolvedView = { id: 'flow', kind: 'flow', scope: { include: ['**/*'], exclude: [] }, graph: null,
  rules: [{ source: 'view', file: '.stingray/views/flow.yaml', line: 3, queryLine: 4, rule: { id: 'step', language: 'python', query: '(call) @c', emit: { node: { id: '@c' } } } }], builtins: [], include: [], exclude: [] };
const node = (id: string, extra: Partial<DiagramNode> = {}): DiagramNode =>
  ({ id, label: id, kind: 'step', subtitle: null, group: null, fields: [], source: null, symbol: null, role: null, order: null, detail: null, ...extra });
const rule = (extra: Partial<RuleDiagnostic> = {}): RuleDiagnostic =>
  ({ rule: 'view#step', language: 'python', filesScanned: 2, matches: 3, emitted: 3, skipped: 0, errors: [], warnings: [], ms: 1, ...extra });
const output = (extra: Partial<EvaluateOutput> = {}): EvaluateOutput => ({
  groups: [], nodes: [node('START', { role: 'start' }), node('plan')], truncated: false, warnings: [], stats: {},
  edges: [{ id: 'e', from: 'START', to: 'plan', fromField: null, toField: null, kind: 'next', style: 'solid', certain: true, label: null, source: null }],
  diagnostics: { rules: [rule()], graph: null, unresolved: [], limits: { filesScanned: 2, matches: 3, truncated: false }, ms: 1 }, ...extra,
});

async function repo() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stingray views-cli ')));
  execFileSync('git', ['init', '-q'], { cwd: root });
  await mkdir(path.join(root, '.stingray/views'), { recursive: true });
  await writeFile(path.join(root, '.stingray/views/flow.yaml'), 'version: 1\n');
  return root;
}

function harness(root: string, overrides: Partial<CliDeps> = {}) {
  const out: string[] = [], err: string[] = [], calls: { load: string[][]; evaluate: EvaluateInput[]; closed: number } = { load: [], evaluate: [], closed: 0 };
  const deps: CliDeps = {
    cwd: root, out: t => out.push(t), err: t => err.push(t),
    loadViewPath: async (r, rel) => { calls.load.push([r, rel]); return { summary, view, ruleFiles: [], errors: [] }; },
    listViews: async () => [{ summary }, { summary: { ...summary, id: 'bad', file: '.stingray/views/bad.yaml', error: 'kind: invalid' } }],
    evaluate: async input => { calls.evaluate.push(input); return output(); },
    createFileProvider: () => ({ list: async () => ({ files: [], truncated: false }), read: async () => null }),
    openGraph: async () => ({ api: null, status: { state: 'unavailable', message: 'no .codegraph index' }, close: () => { calls.closed++; } }),
    grammarDir: () => '/grammars',
    dbSchema: async () => { throw new Error('not used'); },
    sqlSchema: async () => { throw new Error('not used'); },
    skillFile: path.resolve('agents/skills/stingray-views/SKILL.md'), version: '9.9.9', ...overrides,
  };
  return { deps, out, err, calls, run: (...argv: string[]) => runCli(argv, deps) };
}

test('views-cli: unknown commands and bad arguments print usage and exit 2', async () => {
  const root = await repo();
  try {
    for (const argv of [[], ['nope'], ['check'], ['check', 'a', 'b'], ['check', '--strict'], ['list', 'x'], ['sets', 'x'], ['help', 'x']]) {
      const h = harness(root);
      assert.equal(await h.run(...argv), 2, argv.join(' '));
      assert.match(h.err.join('\n'), /^Usage:\n {2}stingray-views check <file.yaml> \[--json\]/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli: --version, help prints SKILL.md, sets lists the TypeScript extractors', async () => {
  const h = harness(process.cwd());
  assert.equal(await h.run('--version'), 0);
  assert.equal(await h.run('help'), 0);
  assert.equal(await h.run('sets'), 0);
  assert.equal(h.out[0], 'stingray-views 9.9.9');
  assert.equal(h.out[1], await readFile('agents/skills/stingray-views/SKILL.md', 'utf8'));
  assert.match(h.out[1], /^---\nname: stingray-views\ndescription: /);
  assert.match(h.out[2], /^sqlalchemy {2}/);
  assert.match(h.out[3], /^sql {2}SQL DDL/);
});

test('views-cli check: evaluates with the worktree root, prints diagnostics and the diagram, exits 0', async () => {
  const root = await repo();
  try {
    await mkdir(path.join(root, 'sub'));
    const h = harness(path.join(root, 'sub'));
    assert.equal(await h.run('check', '../.stingray/views/flow.yaml'), 0);
    assert.deepEqual(h.calls.load, [[root, '.stingray/views/flow.yaml']]);
    assert.equal(h.calls.evaluate[0].grammarDir, '/grammars');
    assert.equal(h.calls.evaluate[0].graph, null);
    assert.deepEqual(h.calls.evaluate[0].graphStatus, { state: 'unavailable', message: 'no .codegraph index' });
    assert.equal(h.calls.closed, 1);
    const text = h.out.join('\n');
    assert.match(text, /^Agent flow \(flow\) — \.stingray\/views\/flow\.yaml\ncode graph: unavailable — no \.codegraph index\nrules:\n {2}view#step \[python\] {2}files 2 {2}matches 3 {2}emitted 3 {2}skipped 0/);
    assert.match(text, /flow: 2 nodes, 1 edges\n {2}\[start\] START \(step\)\n {2}plan \(step\)\nedges:\n {2}START -> plan/);
    assert.match(text, /OK: no errors/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check: view errors print file:line and exit 1 without evaluating', async () => {
  const root = await repo();
  try {
    const h = harness(root, { loadViewPath: async () => ({ summary: { ...summary, error: 'bad' }, view: null, ruleFiles: [],
      errors: [{ file: '.stingray/views/flow.yaml', line: 3, message: 'kind: Invalid option' }, { file: null, line: null, message: 'use: unknown set x' }] }) });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml'), 1);
    assert.deepEqual(h.out, ['.stingray/views/flow.yaml:3: kind: Invalid option', 'use: unknown set x']);
    assert.equal(h.calls.evaluate.length, 0);
    const j = harness(root, { loadViewPath: async () => ({ summary: { ...summary, error: 'kind: Invalid option' }, view: null, ruleFiles: [], errors: [] }) });
    assert.equal(await j.run('check', '.stingray/views/flow.yaml', '--json'), 1);
    assert.deepEqual(JSON.parse(j.out[0]).errors, [{ file: '.stingray/views/flow.yaml', line: null, message: 'kind: Invalid option' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check: rule errors and graph-step errors with a graph fail, unresolved links are listed; --json prints {summary, result}', async () => {
  const root = await repo();
  try {
    const failing = output({ diagnostics: { rules: [rule({ errors: [{ file: '.stingray/views/flow.yaml', line: 7, message: 'Invalid node type foo' }],
      warnings: [{ file: null, line: null, message: '0 matches' }] })], graph: null,
      unresolved: [{ rule: 'view#edge', value: 'missing', file: 'a.py', line: 4 }], limits: { filesScanned: 2, matches: 3, truncated: false }, ms: 1 } });
    const h = harness(root, { evaluate: async () => failing });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml'), 1);
    const text = h.out.join('\n');
    assert.match(text, /\n {4}error: \.stingray\/views\/flow\.yaml:7: Invalid node type foo\n {4}warning: 0 matches\n/);
    assert.match(text, /unresolved links.*\n {2}view#edge: "missing" at a\.py:4/);
    assert.match(text, /FAILED/);

    const graphError = output({ diagnostics: { ...output().diagnostics, graph: { started: 0, reached: 0, helpers: 0, truncated: false, error: 'start symbol not found: x' } } });
    const fakeGraph = { findSymbols: () => [], symbols: () => new Map(), outgoing: () => [], incoming: () => [] };
    const g = harness(root, { evaluate: async () => graphError, openGraph: async () => ({ api: fakeGraph, status: { state: 'read-only', message: null } }) });
    assert.equal(await g.run('check', '.stingray/views/flow.yaml'), 1);
    assert.match(g.out.join('\n'), /graph step: started 0 {2}reached 0 {2}helpers 0\n {2}error: start symbol not found: x/);
    // Without a graph the skipped step is the environment, not the view.
    const n = harness(root, { evaluate: async () => graphError });
    assert.equal(await n.run('check', '.stingray/views/flow.yaml'), 0);
    assert.match(n.out.join('\n'), /\n {2}skipped: start symbol not found: x/);

    const j = harness(root, { evaluate: async () => failing });
    assert.equal(await j.run('check', '--json', '.stingray/views/flow.yaml'), 1);
    const parsed = JSON.parse(j.out.join('\n')) as { summary: ViewSummary; result: ViewResult };
    assert.equal(j.out.length, 1);
    assert.deepEqual(parsed.summary, summary);
    assert.equal(parsed.result.nodes.length, 2);
    assert.equal(parsed.result.diagnostics!.rules[0].errors[0].line, 7);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check: the sqlalchemy builtin is merged like ViewService (scope, table keys)', async () => {
  const root = await repo();
  try {
    const table = (name: string, model: string, file: string) => ({ name, schema: null, fullName: name, model, file, line: 1, columns: [], relationships: [] });
    const db: DbSchemaResult = { workspaceId: 'cli', scannedAt: 1, filesScanned: 2, filesParsed: 2, truncated: true, warnings: [],
      groups: [{ id: 'models', name: 'Base', file: null, line: null, tables: [table('users', 'User', 'app/user.py'), table('logs', 'Log', 'other/log.py')] }] };
    const engine = output({ nodes: [node('START', { role: 'start' }), node('User', { detail: 'from a rule' })],
      edges: [{ id: 'e', from: 'START', to: 'User', fromField: null, toField: null, kind: 'next', style: 'solid', certain: true, label: null, source: null }] });
    const h = harness(root, { loadViewPath: async () => ({ summary, view: { ...view, scope: { include: ['app/**'], exclude: [] }, builtins: ['sqlalchemy'] }, ruleFiles: [], errors: [] }),
      evaluate: async () => engine, dbSchema: async () => db });
    assert.equal(await h.run('check', '.stingray/views/flow.yaml', '--json'), 0);
    const { result } = JSON.parse(h.out[0]) as { result: ViewResult };
    assert.deepEqual(result.nodes.map(n => [n.id, n.detail]), [['models#users', 'from a rule'], ['START', null]]);
    assert.deepEqual(result.edges.map(e => [e.from, e.to]), [['START', 'models#users']]);
    assert.deepEqual(result.groups.map(g => g.id), ['models']);
    assert.equal(result.truncated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('views-cli check: missing files and files outside the worktree exit 1', async () => {
  const root = await repo(), outside = await mkdtemp(path.join(os.tmpdir(), 'stingray-outside-'));
  try {
    const h = harness(root);
    assert.equal(await h.run('check', 'nope.yaml'), 1);
    assert.match(h.err[0], /^File not found: /);
    await writeFile(path.join(outside, 'v.yaml'), '');
    assert.equal(await h.run('check', path.join(outside, 'v.yaml')), 1);
    assert.match(h.err[1], /is not inside a git worktree/);
    assert.equal(h.calls.load.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('views-cli list prints views with errors and exits 1 when one is invalid', async () => {
  const root = await repo();
  try {
    const h = harness(root);
    assert.equal(await h.run('list'), 1);
    assert.deepEqual(h.out, ['flow  flow  Agent flow  .stingray/views/flow.yaml', 'bad  flow  Agent flow  .stingray/views/bad.yaml', '  error: kind: invalid']);
    const empty = harness(root, { listViews: async () => [] });
    assert.equal(await empty.run('list'), 0);
    assert.match(empty.out[0], /^No views yet/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worktreeRoot: git toplevel, else the nearest ancestor with .stingray, else null', async () => {
  const root = await repo(), plain = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stingray-plain-')));
  try {
    await mkdir(path.join(root, 'a/b'), { recursive: true });
    assert.equal(await worktreeRoot(path.join(root, 'a/b')), root);
    await mkdir(path.join(plain, '.stingray'));
    await mkdir(path.join(plain, 'x'));
    assert.equal(await worktreeRoot(path.join(plain, 'x')), plain);
    await rm(path.join(plain, '.stingray'), { recursive: true });
    assert.equal(await worktreeRoot(path.join(plain, 'x')), null);
  } finally { await rm(root, { recursive: true, force: true }); await rm(plain, { recursive: true, force: true }); }
});

test('build-electron bundles views-cli.cjs and copies the skills dir; the bundle runs as plain Node', async () => {
  execFileSync('node', ['scripts/build-electron.mjs'], { stdio: 'pipe' });
  assert.ok((await stat('dist-electron/views-cli.cjs')).isFile());
  assert.equal(await readFile('dist-electron/skills/stingray-views/SKILL.md', 'utf8'), await readFile('agents/skills/stingray-views/SKILL.md', 'utf8'));
  const run = (...args: string[]) => execFileSync('node', ['dist-electron/views-cli.cjs', ...args], { encoding: 'utf8' });
  assert.equal(run('--version'), 'stingray-views 0.1.0\n');
  assert.match(run('help'), /^---\nname: stingray-views\n/);
  // The bundle has one web-tree-sitter: the engine and the sqlalchemy extractor must share its init.
  const root = await repo();
  try {
    await writeFile(path.join(root, 'models.py'), 'from sqlalchemy.orm import DeclarativeBase\nclass Base(DeclarativeBase):\n    pass\nclass User(Base):\n    __tablename__ = "users"\n');
    await writeFile(path.join(root, 'schema.sql'), 'CREATE TABLE sql_users (id INT PRIMARY KEY);');
    await writeFile(path.join(root, '.stingray/views/flow.yaml'), 'version: 1\nname: Mixed\nkind: tables\nuse: [sqlalchemy, sql]\nrules:\n' +
      '  - { id: cls, language: python, query: "(class_definition name: (identifier) @n)", emit: { node: { id: "@n", detail: "class @n" } } }\n');
    const text = execFileSync('node', ['dist-electron/views-cli.cjs', 'check', path.join(root, '.stingray/views/flow.yaml')], { encoding: 'utf8' });
    assert.match(text, /^ {2}users — User · class User$/m);
    assert.match(text, /sql_users/);
    assert.match(text, /id: INT \[PK\]/);
    assert.match(text, /^ {2}Base · class Base$/m);
  } finally { await rm(root, { recursive: true, force: true }); }
});
