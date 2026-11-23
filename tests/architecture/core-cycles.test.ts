import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importsOf, layerOf, sourceFiles } from './import-scan';

/** Reviewed core feature edges (spec 04). A new edge must be added here in a reviewed change and keep the graph acyclic. */
const INTENDED_EDGES = new Set(['repo-map→git', 'terminals→git', 'terminals→activity', 'runtime→git', 'runtime→terminals',
  'views→git', 'views→db-schema', 'views→stinggraph', 'stinggraph→git', 'app→git']);

function findCycle(edges: Set<string>): string[] | null {
  const next = new Map<string, string[]>();
  for (const e of edges) { const [a, b] = e.split('→'); next.set(a, [...(next.get(a) ?? []), b]); }
  const state = new Map<string, 'open' | 'done'>(), stack: string[] = [];
  const visit = (node: string): string[] | null => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'open') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'open'); stack.push(node);
    for (const n of next.get(node) ?? []) { const cycle = visit(n); if (cycle) return cycle; }
    stack.pop(); state.set(node, 'done');
    return null;
  };
  for (const node of next.keys()) { const cycle = visit(node); if (cycle) return cycle; }
  return null;
}

function coreEdges() {
  const edges = new Map<string, string>(); // edge -> first file:line
  for (const file of sourceFiles()) {
    const a = layerOf(file);
    if (a.kind !== 'core' || a.group === 'shared') continue;
    for (const ref of importsOf(file)) {
      if (!ref.target) continue;
      const b = layerOf(ref.target);
      if (b.kind === 'core' && b.group !== 'shared' && b.group !== a.group) {
        const edge = `${a.group}→${b.group}`;
        if (!edges.has(edge)) edges.set(edge, `${ref.file}:${ref.line}`);
      }
    }
  }
  return edges;
}

test('cycle finder self-check', () => {
  assert.equal(findCycle(new Set(['a→b', 'b→c'])), null);
  assert.deepEqual(findCycle(new Set(['a→b', 'b→c', 'c→a'])), ['a', 'b', 'c', 'a']);
});

test('core feature imports form an acyclic graph within the intended edges', () => {
  const edges = coreEdges();
  const unexpected = [...edges].filter(([edge]) => !INTENDED_EDGES.has(edge)).map(([edge, at]) => `${edge} (${at})`);
  assert.deepEqual(unexpected, [], `edges outside INTENDED_EDGES:\n${unexpected.join('\n')}`);
  const cycle = findCycle(new Set(edges.keys()));
  assert.equal(cycle, null, `cycle: ${cycle?.join(' → ')}`);
});
