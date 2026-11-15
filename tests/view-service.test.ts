import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ViewService } from '../electron/views/service';
import type { GraphChange, GraphHost, SymbolQuery, WorktreeGraph } from '../electron/views/graph';
import type { EvaluateOutput, ResolvedView } from '../electron/views/rules/types';
import type { DiagramNode, GraphStatus, SymbolRef, ViewsChangedEvent } from '../src/views';

const grammar = path.join(import.meta.dirname, '../electron/tree-sitter-python.wasm');
const model = (name: string, table: string, fk?: string) => [
  'from sqlalchemy import ForeignKey',
  'from sqlalchemy.orm import Mapped, mapped_column',
  'from app.base import Base',
  '',
  `class ${name}(Base):`,
  `    __tablename__ = "${table}"`,
  '    id: Mapped[int] = mapped_column(primary_key=True)',
  ...(fk ? [`    ref_id: Mapped[int] = mapped_column(ForeignKey("${fk}.id"))`] : []),
].join('\n');
const files: Record<string, string> = {
  'app/base.py': 'from sqlalchemy.orm import DeclarativeBase\n\nclass Base(DeclarativeBase):\n    pass\n',
  'app/models/user.py': model('User', 'users'),
  'app/models/post.py': model('Post', 'posts', 'users'),
  'app/audit.py': model('Audit', 'audit', 'users'),
  '.stingray/views/core.yaml': 'version: 1\nname: Core\nkind: tables\nuse: [sqlalchemy]\nscope: { include: ["app/models/**"] }\nexclude: [Post]\nlayout: { positions: { users: { x: 4, y: 2 } } }\n',
  '.stingray/views/audit.yaml': 'version: 1\nname: Audit\nkind: tables\nuse: [sqlalchemy]\nscope: { include: [app/audit.py] }\n',
  '.stingray/views/flow.yaml': 'version: 1\nname: Flow\nkind: flow\nuse: [orm]\nscope: { include: ["app/**"] }\n',
  '.stingray/views/broken.yaml': 'version: 1\nname: Broken\nkind: flow\nuse: [nope]\n',
  '.stingray/rules/orm.yaml': 'version: 1\nname: orm\nrules:\n  - { id: r, language: python, query: "(call) @c", emit: { node: { id: "@c" } } }\n',
};

class FakeGraph implements WorktreeGraph {
  state: GraphStatus = { state: 'indexing', message: null };
  changeListeners = new Set<(c: GraphChange) => void>();
  statusListeners = new Set<(s: GraphStatus) => void>();
  constructor(readonly workspaceId: string, readonly root: string) {}
  status() { return this.state; }
  onChange(l: (c: GraphChange) => void) { this.changeListeners.add(l); return () => { this.changeListeners.delete(l); }; }
  onStatus(l: (s: GraphStatus) => void) { this.statusListeners.add(l); return () => { this.statusListeners.delete(l); }; }
  batches: SymbolQuery[][] = [];
  async findSymbols(queries: SymbolQuery[]): Promise<(SymbolRef | null)[]> {
    this.batches.push(queries);
    return queries.map(({ file, name, kinds }) => this.state.state === 'ready' ? { id: `${file}:${name}`, name, kind: kinds?.[0] ?? 'class', file, line: 5 } : null);
  }
  evaluated: ResolvedView[] = [];
  evaluate: (view: ResolvedView) => Promise<EvaluateOutput> = async () => { throw new Error('not scripted'); };
  async evaluateView(view: ResolvedView) { this.evaluated.push(view); return this.evaluate(view); }
  change(...files: string[]) { this.changeListeners.forEach(l => l({ files })); }
  setStatus(state: GraphStatus['state']) { this.state = { state, message: null }; this.statusListeners.forEach(l => l(this.state)); }
}
class FakeHost implements GraphHost {
  graphs = new Map<string, FakeGraph>();
  opened = 0; closed: string[] = []; closedAll = 0;
  open(id: string, root: string) { let g = this.graphs.get(id); if (!g) { this.opened++; g = new FakeGraph(id, root); this.graphs.set(id, g); } return g; }
  async close(id: string) { this.closed.push(id); this.graphs.delete(id); }
  async closeAll() { this.closedAll++; }
}

async function setup(t: test.TestContext, debounceMs = 20) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stingray-view-service-'));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const host = new FakeHost(), events: ViewsChangedEvent[] = [];
  const service = new ViewService({ host, grammarPath: grammar, emit: e => events.push(e), debounceMs });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, host, events, service };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Wait `ms`; with `events`, first wait (up to 10 s, for loaded machines) until one arrived, then `ms` for stragglers. */
async function settle(ms = 150, events?: unknown[]) {
  for (const end = Date.now() + 10_000; events && !events.length && Date.now() < end;) await sleep(20);
  await sleep(ms);
}

test('listViews returns the builtin view and view files, invalid ones with errors', async t => {
  const { root, host, service } = await setup(t);
  const list = await service.listViews('ws', root);
  assert.deepEqual(list.map(v => [v.id, v.builtin, v.error !== null]), [['database', true, false], ['audit', false, false], ['broken', false, true], ['core', false, false], ['flow', false, false]]);
  assert.equal(host.opened, 1);
  await assert.rejects(service.computeView('ws', root, 'broken'), /\.stingray\/views\/broken\.yaml is invalid: line 4: Unknown set "nope"/);
  await assert.rejects(service.computeView('ws', root, 'flow'), /^Error: View flow could not be computed: not scripted$/);
});

test('computeView filters membership and links symbols only when the graph is ready', async t => {
  const { root, host, service } = await setup(t);
  const database = await service.computeView('ws', root, 'database');
  assert.deepEqual(database.nodes.map(n => n.label).sort(), ['audit', 'posts', 'users']);
  assert.ok(database.nodes.every(n => n.symbol === null));
  assert.equal(database.graph.state, 'indexing');

  host.graphs.get('ws')!.setStatus('ready');
  const core = await service.computeView('ws', root, 'core');
  assert.equal(core.name, 'Core');
  assert.deepEqual(core.nodes.map(n => n.label), ['users']);
  assert.deepEqual(core.nodes[0].symbol, { id: 'app/models/user.py:User', name: 'User', kind: 'class', file: 'app/models/user.py', line: 5 });
  const batches = host.graphs.get('ws')!.batches;
  assert.deepEqual(batches.at(-1), [{ file: 'app/models/user.py', name: 'User', kinds: ['class'] }]); // one batch per computation
  assert.deepEqual(core.edges, []);
  assert.equal(core.graph.state, 'ready');
  assert.deepEqual(core.layout, { positions: { users: { x: 4, y: 2 } } });
  assert.equal(database.layout, null);
  const audit = await service.computeView('ws', root, 'audit');
  assert.deepEqual(audit.nodes.map(n => n.label), ['audit']);
  assert.equal(audit.layout, null);
});

test('extraction is cached across views until a python file changes', async t => {
  const { root, host, service } = await setup(t);
  const first = await service.computeView('ws', root, 'database');
  assert.equal((await service.computeView('ws', root, 'core')).computedAt, first.computedAt);
  await writeFile(path.join(root, 'app/models/tag.py'), model('Tag', 'tags'));
  host.graphs.get('ws')!.change('app/models/tag.py');
  const again = await service.computeView('ws', root, 'core');
  assert.deepEqual(again.nodes.map(n => n.label).sort(), ['tags', 'users']);
});

test('without a usable graph only in-flight extractions are shared', async t => {
  const { root, host, service } = await setup(t);
  host.open('ws', root);
  host.graphs.get('ws')!.state = { state: 'unavailable', message: null };
  await service.computeView('ws', root, 'database');
  await writeFile(path.join(root, 'app/models/tag.py'), model('Tag', 'tags'));
  assert.ok((await service.computeView('ws', root, 'database')).nodes.some(n => n.label === 'tags'));
});

test('concurrent computations of one view are shared', async t => {
  const { root, service } = await setup(t);
  const a = service.computeView('ws', root, 'core'), b = service.computeView('ws', root, 'core');
  assert.equal(a, b);
  await a;
  assert.notEqual(service.computeView('ws', root, 'core'), a);
});

test('changes emit the affected views, coalesced', async t => {
  const { root, host, events, service } = await setup(t);
  await service.listViews('ws', root);
  const graph = host.graphs.get('ws')!;

  // Any python file can change any view (e.g. a base class outside the view's scope); invalid views are skipped.
  graph.change('app/base.py');
  graph.change('README.md');
  await settle(150, events);
  assert.deepEqual(events, [{ workspaceId: 'ws', viewIds: ['audit', 'core', 'database', 'flow'], listChanged: false }]);

  events.length = 0;
  graph.change('.stingray/rules/orm.yaml');
  await settle(150, events);
  assert.deepEqual(events, [{ workspaceId: 'ws', viewIds: ['flow'], listChanged: true }]);

  // Creating a missing rule file refreshes the view that names it.
  events.length = 0;
  graph.change('.stingray/rules/nope.yaml');
  await settle(150, events);
  assert.deepEqual(events, [{ workspaceId: 'ws', viewIds: ['broken'], listChanged: true }]);

  events.length = 0;
  graph.change('.stingray/views/x.yaml');
  await settle(150, events);
  assert.deepEqual(events, [{ workspaceId: 'ws', viewIds: ['x'], listChanged: true }]);

  events.length = 0;
  graph.change('docs/readme.md');
  await settle();
  assert.deepEqual(events, []);

  graph.setStatus('ready');
  await settle(150, events);
  assert.deepEqual(events, [{ workspaceId: 'ws', viewIds: ['audit', 'broken', 'core', 'database', 'flow'], listChanged: false }]);
});

test('release unsubscribes and closes the graph; dispose closes all', async t => {
  const { root, host, events, service } = await setup(t);
  await service.listViews('ws', root);
  const graph = host.graphs.get('ws')!;
  graph.change('app/models/user.py');
  await service.release('ws');
  assert.deepEqual(host.closed, ['ws']);
  assert.equal(graph.changeListeners.size + graph.statusListeners.size, 0);
  await settle();
  assert.deepEqual(events, []);
  await service.listViews('ws2', root);
  const graph2 = host.graphs.get('ws2')!;
  await service.dispose();
  assert.deepEqual(host.closed, ['ws']); // dispose relies on the host's single bounded closeAll
  assert.equal(host.closedAll, 1);
  assert.equal(graph2.changeListeners.size + graph2.statusListeners.size, 0);
});

test('a released workspace is not reopened until reopen()', async t => {
  const { root, host, service } = await setup(t);
  await service.listViews('ws', root);
  await service.release('ws');
  await assert.rejects(service.computeView('ws', root, 'database'), /being removed/);
  await assert.rejects(service.listViews('ws', root), /being removed/);
  assert.equal(host.graphs.has('ws'), false);
  service.reopen('ws');
  await service.listViews('ws', root);
  assert.equal(host.graphs.has('ws'), true);
});

test('a change during a computation makes the refetch compute again', async t => {
  const { root, host, events, service } = await setup(t);
  const before = service.computeView('ws', root, 'database');
  host.graphs.get('ws')!.change('app/models/user.py');
  await settle(150, events);
  assert.deepEqual(events.map(e => e.viewIds), [['audit', 'core', 'database', 'flow']]);
  const after = service.computeView('ws', root, 'database');
  assert.notEqual(after, before);
  await Promise.all([before, after]);
});

test('a throwing emit does not break listeners', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stingray-view-service-'));
  const host = new FakeHost();
  const service = new ViewService({ host, grammarPath: grammar, emit: () => { throw new Error('boom'); }, debounceMs: 5 });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.listViews('ws', root);
  host.graphs.get('ws')!.change('a.py');
  await settle(30);
});

const node = (id: string, extra: Partial<DiagramNode> = {}): DiagramNode =>
  ({ id, label: id, kind: 'step', subtitle: null, group: null, fields: [], source: null, symbol: null, role: null, order: null, detail: null, ...extra });
const output = (extra: Partial<EvaluateOutput> = {}): EvaluateOutput => ({
  groups: [], nodes: [], edges: [], warnings: [], truncated: false, stats: { filesScanned: 1 },
  diagnostics: { rules: [], graph: null, unresolved: [], limits: { filesScanned: 1, matches: 0, truncated: false }, ms: 1 }, ...extra,
});

test('rule views evaluate through the graph, merge sqlalchemy tables by table keys and link symbols', async t => {
  const { root, host, service } = await setup(t);
  await writeFile(path.join(root, '.stingray/views/mixed.yaml'), [
    'version: 1', 'name: Mixed', 'kind: tables', 'scope: { include: ["app/models/**"] }', 'use: [sqlalchemy]', 'rules:',
    '  - { id: model, language: python, query: "(class_definition name: (identifier) @name)", emit: { node: { id: "@name", detail: "model @name" } } }', ''].join('\n'));
  const graph = host.open('ws', root) as FakeGraph;
  graph.setStatus('ready');
  const linked: SymbolRef = { id: 'x', name: 'Helper', kind: 'class', file: 'app/models/helper.py', line: 1 };
  graph.evaluate = async view => output({
    nodes: [node('User', { detail: `model User (${view.rules.length} rule)` }), node('Helper', { subtitle: 'Helper', source: { file: 'app/models/helper.py', line: 1 }, symbol: linked }), node('Post')],
    edges: [{ id: 'uses:Helper->User', from: 'Helper', to: 'User', fromField: null, toField: null, kind: 'uses', style: 'solid', certain: true, label: null, source: null }],
  });
  const mixed = await service.computeView('ws', root, 'mixed');
  assert.equal(graph.evaluated.length, 1);
  assert.deepEqual(mixed.nodes.map(n => [n.id, n.detail]), [['app/base.py:Base#posts', null], ['app/base.py:Base#users', 'model User (1 rule)'], ['Helper', null]]);
  assert.deepEqual(mixed.edges.map(e => [e.kind, e.from, e.to]), [['foreign-key', 'app/base.py:Base#posts', 'app/base.py:Base#users'], ['uses', 'Helper', 'app/base.py:Base#users']]);
  assert.equal(mixed.nodes[2].symbol, linked); // engine-linked symbols are kept
  assert.deepEqual(graph.batches.at(-1)!.map(q => q.name), ['Post', 'User']);
  assert.equal(mixed.diagnostics!.limits.filesScanned, 1);
  assert.equal(mixed.stats.tables, 2);

  // Plain sqlalchemy tables views never reach the graph process.
  await service.computeView('ws', root, 'core');
  assert.equal(graph.evaluated.length, 1);

  graph.evaluate = async () => { throw new Error('Code graph process unavailable'); };
  await assert.rejects(service.computeView('ws', root, 'mixed'), /^Error: View mixed could not be computed: Code graph process unavailable$/);
});

test('changes re-queue rule views by scope and rule files, graph views on any code change', async t => {
  const { root, host, events, service } = await setup(t);
  await writeFile(path.join(root, '.stingray/views/steps.yaml'), [
    'version: 1', 'name: Steps', 'kind: flow', 'scope: { include: ["app/**"] }', 'rules:',
    '  - { id: step, language: python, files: ["app/flows/**"], query: "(call) @c", emit: { node: { id: "@c" } } }', ''].join('\n'));
  await writeFile(path.join(root, '.stingray/views/calls.yaml'), 'version: 1\nname: Calls\nkind: graph\ngraph: { start: [{ symbol: main }], follow: [calls] }\n');
  await service.listViews('ws', root);
  const graph = host.graphs.get('ws')!;
  const after = async (...files: string[]) => { events.length = 0; graph.change(...files); await settle(150, events); return events.map(e => e.viewIds); };
  assert.deepEqual(await after('app/flows/a.ts'), [['calls', 'flow', 'steps']]);
  assert.deepEqual(await after('app/other.ts'), [['calls', 'flow']]);
  assert.deepEqual(await after('lib/x.ts'), [['calls']]);
  assert.deepEqual(await after('app/flows/b.py'), [['audit', 'calls', 'core', 'database', 'flow', 'steps']]);
});
