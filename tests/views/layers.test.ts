import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLayers } from '../../electron/app/wiring/views';
import type { GraphApi, GraphLayers, GraphRelation, GraphRollupEdge, GraphSymbol } from '../../electron/core/views/rules/types';

// Service a (CRUD backend): modules m1 (a/x.py), m2 (a/y.py); service b: a/../b/z.py; tests/t.py unassigned.
const layers: GraphLayers = {
  config: '.stinggraph/layers.yaml',
  services: [
    { id: 'a', label: 'CRUD backend', aliases: ['backend'], origin: 'declared', modules: [{ id: 'm1', label: 'Plans' }, { id: 'm2', label: 'm2' }] },
    { id: 'b', label: 'b', aliases: [], origin: 'inferred', modules: [{ id: '(root)', label: '(root)' }] },
    { id: '(unassigned)', label: '(unassigned)', aliases: [], origin: 'unassigned', modules: [] },
  ],
  assignments: { 'a/x.py': { service: 'a', module: 'm1' }, 'a/y.py': { service: 'a', module: 'm2' }, 'b/z.py': { service: 'b', module: '(root)' },
    'tests/t.py': { service: '(unassigned)', module: '(unassigned)' } },
  errors: [{ source: '.stinggraph/layers.yaml', message: 'a/x.py matches two modules' }],
};
const fileEdges = [
  { source: 'a/x.py', target: 'b/z.py', kind: 'calls', count: 3, synthesized: 0 },
  { source: 'a/y.py', target: 'b/z.py', kind: 'imports', count: 1, synthesized: 0 },
  { source: 'a/x.py', target: 'a/y.py', kind: 'calls', count: 2, synthesized: 0 },
  { source: 'tests/t.py', target: 'a/x.py', kind: 'calls', count: 5, synthesized: 0 },
  { source: 'b/z.py', target: 'a/y.py', kind: 'calls', count: 4, synthesized: 4 },
];
const sym = (id: string, name: string, kind: string, file: string, line = 1): GraphSymbol => ({ id, name, kind, file, line });
const symbols = [sym('fx', 'x.py', 'file', 'a/x.py'), { ...sym('f1', 'Plan', 'class', 'a/x.py', 3), docstring: 'A trip plan.\n\nMore detail.' }, sym('m', 'save', 'method', 'a/x.py', 4),
  sym('imp', 'os', 'import', 'a/x.py'), sym('fy', 'y.py', 'file', 'a/y.py'), sym('fz', 'z.py', 'file', 'b/z.py'), sym('g', 'store', 'function', 'b/z.py', 2)];
const relations: GraphRelation[] = [
  { from: 'fx', to: 'f1', kind: 'contains', line: 3, certain: true }, { from: 'f1', to: 'm', kind: 'contains', line: 4, certain: true },
  { from: 'fx', to: 'imp', kind: 'contains', line: 1, certain: true }, { from: 'fz', to: 'g', kind: 'contains', line: 2, certain: true },
  { from: 'm', to: 'g', kind: 'calls', line: 5, certain: true }, { from: 'f1', to: 'g', kind: 'references', line: 3, certain: false },
  { from: 'fx', to: 'g', kind: 'imports', line: 1, certain: true }, // module level: no symbol, left out
  { from: 'g', to: 'm', kind: 'calls', line: 2, certain: false },
];

function fakeGraph(withLayers: GraphLayers | null = layers): GraphApi & { units: Record<string, string>[] } {
  const units: Record<string, string>[] = [];
  const byId = new Map(symbols.map(s => [s.id, s]));
  return {
    units,
    findSymbols: () => [],
    symbols: ids => new Map(ids.flatMap(id => byId.has(id) ? [[id, byId.get(id)!] as const] : [])),
    outgoing: (ids, kinds) => relations.filter(r => ids.includes(r.from) && kinds.includes(r.kind)),
    incoming: (ids, kinds) => relations.filter(r => ids.includes(r.to) && kinds.includes(r.kind)),
    fileSymbols: file => symbols.filter(s => s.file === file),
    layers: () => withLayers,
    rollup: map => {
      units.push(map);
      const out = new Map<string, GraphRollupEdge>();
      for (const e of fileEdges) {
        const from = map[e.source], to = map[e.target];
        if (!from || !to || from === to) continue;
        const pair = out.get(from + to) ?? { from, to, total: 0, synthesized: 0, byKind: {} };
        pair.total += e.count; pair.synthesized += e.synthesized; pair.byKind[e.kind] = (pair.byKind[e.kind] ?? 0) + e.count;
        out.set(from + to, pair);
      }
      return [...out.values()];
    },
  };
}
const all = () => true;
const edges = (out: ReturnType<typeof runLayers>) => out.edges.map(e => `${e.from} -> ${e.to} [${e.label}]${e.certain ? '' : ' dashed'}`);

test('runLayers depth 1: one node per service with file counts, cross-service edges counted per kind, config errors as warnings', () => {
  const out = runLayers({ depth: 1 }, fakeGraph(), all);
  assert.deepEqual(out.nodes.map(n => [n.id, n.label, n.kind, n.subtitle, n.detail, n.group]), [
    ['service:a', 'CRUD backend', 'service', '2 files', 'backend', null], ['service:b', 'b', 'service', '1 file', null, null],
    ['service:(unassigned)', '(unassigned)', 'service', '1 file', null, null]]);
  assert.deepEqual(out.groups, []);
  assert.deepEqual(edges(out), ['service:(unassigned) -> service:a [5 · calls 5]', 'service:a -> service:b [4 · calls 3, imports 1]',
    'service:b -> service:a [4 · calls 4] dashed']);
  assert.deepEqual(out.warnings, [{ file: '.stinggraph/layers.yaml', line: null, message: 'layers: a/x.py matches two modules' }]);
  assert.deepEqual(out.diagnostic, { config: '.stinggraph/layers.yaml', depth: 1, services: 3, files: 4, nodes: 3, error: null });
});

test('runLayers leaves (unassigned) out of inferred layers (no layers.yaml), unless nothing else was found', () => {
  const inferred = runLayers({ depth: 1 }, fakeGraph({ ...layers, config: null }), all);
  assert.deepEqual(inferred.nodes.map(n => n.id), ['service:a', 'service:b']);
  assert.deepEqual(edges(inferred), ['service:a -> service:b [4 · calls 3, imports 1]', 'service:b -> service:a [4 · calls 4] dashed']);
  assert.deepEqual([inferred.diagnostic.services, inferred.diagnostic.files], [2, 3]);

  const nothing: GraphLayers = { config: null, services: [layers.services[2]], errors: [],
    assignments: Object.fromEntries(Object.keys(layers.assignments).map(f => [f, { service: '(unassigned)', module: '(unassigned)' }])) };
  assert.deepEqual(runLayers({ depth: 1 }, fakeGraph(nothing), all).nodes.map(n => [n.id, n.subtitle]), [['service:(unassigned)', '4 files']]);
});

test('runLayers depth 2 and 3 nest modules and files in their service (and module) groups; edges re-aggregate per level', () => {
  const two = runLayers({ depth: 2 }, fakeGraph(), all);
  assert.deepEqual(two.nodes.map(n => [n.id, n.label, n.group, n.subtitle]).slice(0, 2), [['module:a/m1', 'Plans', 'service:a', '1 file'], ['module:a/m2', 'm2', 'service:a', '1 file']]);
  assert.deepEqual(two.groups.map(g => [g.id, g.label, g.parent]), [['service:a', 'CRUD backend', null], ['service:b', 'b', null], ['service:(unassigned)', '(unassigned)', null]]);
  assert.ok(edges(two).includes('module:a/m1 -> module:a/m2 [2 · calls 2]'));

  const three = runLayers({ depth: 3 }, fakeGraph(), all);
  const x = three.nodes.find(n => n.id === 'file:a/x.py')!;
  assert.deepEqual([x.label, x.subtitle, x.group, x.source], ['x.py', 'a', 'module:a/m1', { file: 'a/x.py', line: 1 }]);
  assert.deepEqual(three.groups.find(g => g.id === 'module:a/m1'), { id: 'module:a/m1', label: 'Plans', source: null, parent: 'service:a' });
  assert.ok(edges(three).includes('file:a/x.py -> file:b/z.py [3 · calls 3]'));
});

test('runLayers expand drills only named services (by id or label); scope drops files and their edges', () => {
  const graph = fakeGraph();
  const out = runLayers({ depth: 3, expand: ['CRUD backend'] }, graph, f => !f.startsWith('tests/'));
  assert.deepEqual(out.nodes.map(n => n.id), ['file:a/x.py', 'file:a/y.py', 'service:b']);
  assert.deepEqual(graph.units[0], { 'a/x.py': 'file:a/x.py', 'a/y.py': 'file:a/y.py', 'b/z.py': 'service:b' });
  assert.deepEqual(edges(out), ['service:b -> file:a/y.py [4 · calls 4] dashed', 'file:a/x.py -> service:b [3 · calls 3]',
    'file:a/x.py -> file:a/y.py [2 · calls 2]', 'file:a/y.py -> service:b [1 · imports 1]']);
});

test('runLayers depth 4 draws top-level symbols (with their docstring summary) in file groups; members count as their symbol, imports and module-level code drop out', () => {
  const graph = fakeGraph();
  const out = runLayers({ depth: 4, expand: ['a', 'b'] }, graph, f => !f.startsWith('tests/'));
  assert.deepEqual(out.nodes.map(n => [n.id, n.label, n.kind, n.group]), [
    ['file:a/y.py', 'y.py', 'file', 'module:a/m2'], ['sym:f1', 'Plan', 'class', 'file:a/x.py'], ['sym:g', 'store', 'function', 'file:b/z.py']]);
  assert.deepEqual(out.nodes[1].symbol, { id: 'f1', name: 'Plan', kind: 'class', file: 'a/x.py', line: 3 });
  assert.deepEqual(out.nodes.map(n => n.explanation), [undefined, 'A trip plan.', undefined], 'symbols carry their docstring summary');
  assert.deepEqual(out.groups.find(g => g.id === 'file:a/x.py'), { id: 'file:a/x.py', label: 'x.py', source: { file: 'a/x.py', line: 1 }, parent: 'module:a/m1' });
  // y.py has no symbols, so it stays a file node and keeps its file-level edges.
  assert.deepEqual(graph.units[0], { 'a/y.py': 'file:a/y.py' });
  assert.deepEqual(edges(out), ['sym:f1 -> sym:g [2 · calls 1, references 1]', 'sym:g -> sym:f1 [1 · calls 1] dashed']);
});

test('runLayers reports when stinggraph has no layers', () => {
  const out = runLayers({ depth: 2 }, fakeGraph(null), all);
  assert.deepEqual([out.nodes, out.diagnostic.error], [[], 'service layers could not be computed']);
});
