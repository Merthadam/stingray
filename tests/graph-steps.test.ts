import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_GRAPH_NODES, runGraphStep } from '../electron/views/rules/graph-steps';
import type { GraphApi, GraphRelation, GraphStep, GraphSymbol } from '../electron/views/rules/types';

// Symbols are "name@file:line"; relations "from>to:kind" (kind defaults to calls, a trailing ? marks heuristic).
function fakeGraph(symbols: string[], relations: string[]): GraphApi & { calls: string[] } {
  const all = symbols.map((s, i): GraphSymbol => {
    const [, name, file, line, kind = 'function'] = /^(\w+)@([^:]+):(\d+)(?:\/(\w+))?$/.exec(s)!;
    return { id: `id${i}-${name}`, name, kind, file, line: Number(line) };
  });
  const byName = (name: string) => all.filter(s => s.name === name);
  const rels = relations.map((r, i): GraphRelation => {
    const [, from, to, kind = 'calls', heuristic] = /^(\w+)>(\w+)(?::(\w+))?(\?)?$/.exec(r)!;
    return { from: byName(from)[0].id, to: byName(to)[0].id, kind, line: i + 1, certain: !heuristic };
  });
  const calls: string[] = [];
  return {
    calls,
    findSymbols: (name, file) => all.filter(s => s.name === name && (!file || s.file === file)),
    symbols: ids => { calls.push('symbols'); return new Map(all.filter(s => ids.includes(s.id)).map(s => [s.id, s])); },
    outgoing: (ids, kinds) => rels.filter(r => ids.includes(r.from) && kinds.includes(r.kind)),
    incoming: (ids, kinds) => rels.filter(r => ids.includes(r.to) && kinds.includes(r.kind)),
  };
}
const step = (over: Partial<GraphStep>): GraphStep => ({ start: [{ symbol: 'main' }], follow: ['calls'], direction: 'out', depth: 3, helpers: 'show', ...over });
const all = () => true;
const labels = (out: ReturnType<typeof runGraphStep>) => out.nodes.map(n => n.label);
const links = (out: ReturnType<typeof runGraphStep>) => {
  const label = new Map(out.nodes.map(n => [n.id, n.label]));
  return out.edges.map(e => `${label.get(e.from)}>${label.get(e.to)}:${e.kind}${e.certain ? '' : '?'}`);
};

const chain = fakeGraph(['main@app/main.py:1', 'a@app/a.py:2', 'c@app/c.py:3', 'd@app/d.py:4', 'x@app/x.py:5'],
  ['main>a', 'a>c', 'c>d', 'x>c']);

test('resolves start symbols: not found, ambiguous without file, disambiguated by file', () => {
  const g = fakeGraph(['run@a.py:1', 'run@b.py:7', 'main@app/main.py:1'], []);
  assert.equal(runGraphStep(step({ start: [{ symbol: 'nope' }] }), g, all).diagnostic.error, 'start symbol not found: nope');
  assert.equal(runGraphStep(step({ start: [{ symbol: 'run', file: 'c.py' }] }), g, all).diagnostic.error, 'start symbol not found: run in c.py');
  const ambiguous = runGraphStep(step({ start: [{ symbol: 'run' }, { symbol: 'main' }] }), g, all);
  assert.equal(ambiguous.diagnostic.error, 'ambiguous start symbol run: add a file (a.py:1, b.py:7)');
  assert.deepEqual(labels(ambiguous), ['main']); // the resolvable starts still run
  const picked = runGraphStep(step({ start: [{ symbol: 'run', file: 'b.py' }] }), g, all);
  assert.equal(picked.diagnostic.error, null);
  assert.deepEqual(picked.nodes, [{ id: 'sym:id1-run', label: 'run', kind: 'function', subtitle: null, group: null, fields: [],
    source: { file: 'b.py', line: 7 }, symbol: { id: 'id1-run', name: 'run', kind: 'function', file: 'b.py', line: 7 }, role: null, order: null, detail: null }]);
  assert.equal(picked.diagnostic.started, 1);
});

test('follows directions up to depth with deterministic ids', () => {
  const out = runGraphStep(step({ depth: 2 }), chain, all);
  assert.deepEqual(labels(out), ['main', 'a', 'c']);
  assert.deepEqual(out.edges.map(e => e.id), ['calls:sym:id0-main->sym:id1-a', 'calls:sym:id1-a->sym:id2-c']);
  assert.deepEqual(out.edges[0].source, { file: 'app/main.py', line: 1 });
  assert.deepEqual(labels(runGraphStep(step({ depth: 1 }), chain, all)), ['main', 'a']);
  // Incoming edges keep their real direction (caller -> callee).
  const callers = runGraphStep(step({ start: [{ symbol: 'c' }], direction: 'in', depth: 2 }), chain, all);
  assert.deepEqual(labels(callers), ['c', 'a', 'x', 'main']);
  assert.deepEqual(links(callers), ['a>c:calls', 'x>c:calls', 'main>a:calls']); // ordered by the BFS rank of from, then to
  assert.deepEqual(labels(runGraphStep(step({ start: [{ symbol: 'c' }], direction: 'both', depth: 1 }), chain, all)), ['c', 'd', 'a', 'x']);
});

test('maps follow kinds to CodeGraph edge kinds', () => {
  const g = fakeGraph(['Base@m.py:1/class', 'Iface@m.py:2/interface', 'Child@m.py:3/class', 'make@m.py:4', 'helper@m.py:5', 'mod@m.py:6/module'],
    ['Child>Base:extends', 'Child>Iface:implements', 'make>Child:instantiates', 'make>Base:references', 'make>helper:calls', 'make>mod:imports']);
  assert.deepEqual(links(runGraphStep(step({ start: [{ symbol: 'Child' }], follow: ['inherits'] }), g, all)), ['Child>Base:inherits', 'Child>Iface:inherits']);
  assert.deepEqual(labels(runGraphStep(step({ start: [{ symbol: 'make' }], follow: ['references'] }), g, all)), ['make', 'Child', 'Base']);
  assert.deepEqual(links(runGraphStep(step({ start: [{ symbol: 'make' }], follow: ['imports'] }), g, all)), ['make>mod:imports']);
  assert.deepEqual(labels(runGraphStep(step({ start: [{ symbol: 'make' }], follow: ['calls', 'imports'] }), g, all)), ['make', 'helper', 'mod']);
});

// main calls a and b; both call util (fan-in 2, a leaf); a calls vendored lib (outside include), which calls deep.
const helpers = fakeGraph(['main@app/main.py:1', 'a@app/a.py:2', 'b@app/b.py:3', 'util@app/util.py:4', 'lib@vendor/lib.py:5', 'deep@vendor/deep.py:6'],
  ['main>a', 'main>b', 'a>util', 'b>util', 'a>lib', 'lib>deep']);
const inApp = (file: string) => file.startsWith('app/');

test('include/exclude filter reached nodes; nodes outside include are not expanded', () => {
  const shown = runGraphStep(step({}), helpers, inApp);
  assert.deepEqual(labels(shown), ['main', 'a', 'b', 'util', 'lib']); // deep is behind lib, which lies outside the scope
  assert.deepEqual(labels(runGraphStep(step({ include: ['**'] }), helpers, inApp)), ['main', 'a', 'b', 'util', 'lib', 'deep']);
  const excluded = runGraphStep(step({ include: ['**'], exclude: ['vendor/**', 'app/b.py'] }), helpers, inApp);
  assert.deepEqual(labels(excluded), ['main', 'a', 'util']);
  assert.equal(excluded.diagnostic.helpers, 0); // util has fan-in 1 once b is excluded
});

test('helpers: show keeps, hide drops, collapse folds them into their callers', () => {
  const shown = runGraphStep(step({}), helpers, inApp);
  assert.equal(shown.diagnostic.helpers, 2);
  assert.deepEqual(links(shown), ['main>a:calls', 'main>b:calls', 'a>util:calls', 'a>lib:calls', 'b>util:calls']);
  const hidden = runGraphStep(step({ helpers: 'hide' }), helpers, inApp);
  assert.deepEqual(labels(hidden), ['main', 'a', 'b']);
  assert.deepEqual(links(hidden), ['main>a:calls', 'main>b:calls']);
  assert.ok(hidden.nodes.every(n => !n.fields.length));
  const collapsed = runGraphStep(step({ helpers: 'collapse' }), helpers, inApp);
  assert.deepEqual(labels(collapsed), ['main', 'a', 'b']);
  assert.deepEqual(collapsed.nodes.map(n => n.fields.map(f => f.id)), [[], ['helper:util', 'helper:lib'], ['helper:util']]);
  assert.deepEqual(collapsed.nodes[1].fields[0], { id: 'helper:util', label: 'util', type: null, badges: [], detail: 'helper', source: { file: 'app/util.py', line: 4 } });
  assert.equal(collapsed.diagnostic.reached, 5);
});

test('caps nodes in BFS order and marks the result truncated', () => {
  const names = Array.from({ length: 200 }, (_, i) => `f${i}`);
  const g = fakeGraph(['main@m.py:1', ...names.map((n, i) => `${n}@m.py:${i + 2}`)], names.map(n => `main>${n}`));
  const out = runGraphStep(step({}), g, all);
  assert.equal(out.nodes.length, MAX_GRAPH_NODES);
  assert.equal(out.nodes.at(-1)!.label, 'f148');
  assert.equal(out.truncated, true);
  assert.deepEqual(out.diagnostic, { started: 1, reached: 201, helpers: 0, truncated: true, error: null });
  assert.equal(runGraphStep(step({}), chain, all).truncated, false);
});

test('heuristic relations are uncertain and dashed unless another call site is certain', () => {
  const g = fakeGraph(['main@m.py:1', 'a@m.py:2', 'b@m.py:3'], ['main>a?', 'main>b?', 'main>b']);
  const out = runGraphStep(step({}), g, all);
  assert.deepEqual(out.edges.map(e => [e.to, e.certain, e.style]), [['sym:id1-a', false, 'dashed'], ['sym:id2-b', true, 'solid']]);
});
