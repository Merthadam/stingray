import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiagramNode, ViewResult } from '../../shared/contracts/views';
import { describeDiff, diffResults } from '../../src/features/views/views-ui/er-diff';

const node = (id: string, type = 'Integer'): DiagramNode => ({ id, label: id, kind: 'table', subtitle: 'M', group: null, source: null, symbol: null, role: null, order: null, detail: null,
  fields: [{ id: 'id', label: 'id', type, badges: ['PK'], detail: null, source: null }] });
const result = (nodes: DiagramNode[]) => ({ nodes, edges: [] }) as unknown as ViewResult;

test('diffResults reports added, removed and changed nodes', () => {
  const prev = result([node('a'), node('b'), node('c')]);
  const next = result([node('a'), node('b', 'BigInteger'), node('d'), node('e')]);
  const d = diffResults(prev, next);
  assert.deepEqual(d.added, ['d', 'e']);
  assert.deepEqual(d.removed.map(n => n.id), ['c']);
  assert.deepEqual(d.changed, ['b']);
  assert.equal(describeDiff(d), '2 tables added · 1 table removed · 1 table changed');
});

test('diffResults ignores source-only changes', () => {
  const moved = { ...node('a'), source: { file: 'x.py', line: 9 } };
  const d = diffResults(result([node('a')]), result([moved]));
  assert.deepEqual(d, { added: [], removed: [], changed: [] });
  assert.equal(describeDiff(d), '');
});
