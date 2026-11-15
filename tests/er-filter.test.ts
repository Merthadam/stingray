import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiagramEdge, DiagramNode, ViewResult } from '../src/views';
import { hideIsolated, neighbours, onlyNeighbours } from '../src/views-ui/er-filter';

const node = (id: string): DiagramNode => ({ id, label: id, kind: 'table', subtitle: null, group: null, fields: [], source: null, symbol: null, role: null, order: null, detail: null });
const edge = (from: string, to: string): DiagramEdge => ({ id: `${from}-${to}`, from, to, fromField: null, toField: null, kind: 'relationship', style: 'dashed', certain: true, label: null, source: null });
// a - b - c - d, e alone, f only self-referencing
const result = { nodes: ['a', 'b', 'c', 'd', 'e', 'f'].map(node), edges: [edge('a', 'b'), edge('c', 'b'), edge('c', 'd'), edge('f', 'f')] } as ViewResult;

test('neighbours follow edges in both directions by hops', () => {
  assert.deepEqual([...neighbours(result, 'b', 1)].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...neighbours(result, 'a', 2)].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...neighbours(result, 'e', 2)], ['e']);
  assert.deepEqual(onlyNeighbours(result, 'd', 1), ['a', 'b', 'e', 'f']);
});

test('hideIsolated adds visible nodes without relations to visible nodes, keeping existing hidden ids', () => {
  assert.deepEqual(hideIsolated(result, []), ['e', 'f']);
  // hiding b isolates a; c still links to d
  assert.deepEqual(hideIsolated(result, ['b']), ['b', 'a', 'e', 'f']);
  assert.deepEqual(hideIsolated(result, ['gone']), ['gone', 'e', 'f']);
});
