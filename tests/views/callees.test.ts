import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calleesOf } from '../../electron/core/views/rules/callees';
import type { GraphApi, GraphRelation, GraphSymbol } from '../../electron/core/views/rules/types';

const sym = (id: string, file: string, line: number): GraphSymbol => ({ id, name: id, kind: 'function', file, line });
const known = new Map([sym('main', 'a.py', 1), sym('b', 'b.py', 5), sym('a2', 'a.py', 9), sym('a1', 'a.py', 3), sym('leaf', 'c.py', 1)].map(s => [s.id, s]));
const rel = (from: string, to: string, certain = true): GraphRelation => ({ from, to, kind: 'calls', line: 1, certain });
const graph = {
  outgoing: (ids: string[], kinds: string[]) => (kinds.includes('calls') ? [rel('main', 'b'), rel('main', 'a2', false), rel('main', 'a1'), rel('main', 'b'), rel('main', 'gone'), rel('other', 'b')] : [])
    .filter(r => ids.includes(r.from)),
  symbols: (ids: string[]) => new Map(ids.flatMap(id => (known.has(id) ? [[id, known.get(id)!] as const] : []))),
} as unknown as GraphApi;

test('calleesOf groups direct calls by source, de-duplicated, heuristic kept, dangling dropped, ordered by file and line', () => {
  const out = calleesOf(graph, ['main', 'leaf']);
  assert.deepEqual([...out.keys()], ['main', 'leaf']);
  assert.deepEqual(out.get('main')!.map(s => s.id), ['a1', 'a2', 'b']);
  assert.deepEqual(out.get('leaf'), []);
  assert.deepEqual(calleesOf(graph, []), new Map());
});
