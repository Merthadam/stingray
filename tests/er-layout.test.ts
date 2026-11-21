import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { DiagramEdge, DiagramField, DiagramNode, ViewResult } from '../src/views';
import { cardRows, cardSize, elkGraph, EXPLANATION_HEIGHT, HEADER_HEIGHT, handleId, layoutPositions, MAX_ROWS, portId, ROW_HEIGHT, storedPositions, type Positions } from '../src/views-ui/er-layout';

const elk = new ELK();
const field = (id: string, badges: string[] = []): DiagramField => ({ id, label: id, type: 'Integer', badges, detail: null, source: null });
const node = (id: string, fields: DiagramField[] = [field('id', ['PK'])]): DiagramNode =>
  ({ id, label: id, kind: 'table', subtitle: null, group: null, fields, source: null, symbol: null, role: null, order: null, detail: null });
const fk = (from: string, fromField: string | null, to: string, toField: string | null = 'id'): DiagramEdge =>
  ({ id: `${from}.${fromField}->${to}`, from, to, fromField, toField, kind: 'foreign-key', style: 'solid', certain: true, label: null, source: null });
const result = (nodes: DiagramNode[], edges: DiagramEdge[], layout: Positions | null = null) =>
  ({ nodes, edges, layout: layout && { positions: layout } }) as unknown as ViewResult;

// `wide` has 20 fields; its FK `owner_id` is a key field, `late_ref` (field 19) is not and gets collapsed away.
const wideFields = [field('id', ['PK']), ...Array.from({ length: 17 }, (_, i) => field(`c${i}`)), field('owner_id', ['FK']), field('late_ref')];
const base = result(
  [node('users'), node('posts', [field('id', ['PK']), field('author_id', ['FK'])]), node('wide', wideFields), node('lonely')],
  [fk('posts', 'author_id', 'users'), fk('wide', 'owner_id', 'users'), fk('wide', 'late_ref', 'posts'), { ...fk('users', null, 'posts', null), kind: 'relationship' }],
);

test('cardRows keeps key fields and the first others up to MAX_ROWS, in field order', () => {
  const { rows, more, toggle } = cardRows(base.nodes[2], false);
  assert.equal(rows.length, MAX_ROWS);
  assert.equal(more, wideFields.length - MAX_ROWS);
  assert.ok(toggle);
  assert.deepEqual(rows.map(f => f.id), ['id', ...Array.from({ length: 10 }, (_, i) => `c${i}`), 'owner_id']);
  assert.equal(cardRows(base.nodes[2], true).rows.length, wideFields.length);
  assert.equal(cardSize(base.nodes[2], false).height, cardSize(node('x', wideFields.slice(0, 13)), false).height);
});

test('elkGraph has ports per visible field row and maps collapsed or field-less ends', () => {
  const graph = elkGraph(base, [], []);
  const wide = graph.children!.find(c => c.id === 'wide')!;
  // card + 12 rows + "+N more", each with a target and a source port
  assert.equal(wide.ports!.length, (1 + MAX_ROWS + 1) * 2);
  assert.equal(wide.layoutOptions!['elk.portConstraints'], 'FIXED_ORDER');
  const edge = (id: string) => graph.edges!.find(e => e.id === id)!;
  assert.deepEqual(edge('posts.author_id->users').sources, [portId('posts', 'f:author_id:s')]);
  assert.deepEqual(edge('posts.author_id->users').targets, [portId('users', 'f:id:t')]);
  assert.deepEqual(edge('wide.late_ref->posts').sources, [portId('wide', 'more:s')]);
  assert.deepEqual(edge('users.null->posts').sources, [portId('users', 'card:s')]);
  assert.equal(handleId(base.nodes[2], 'late_ref', true, 's'), 'f:late_ref:s');
  const ports = new Set(graph.children!.flatMap(c => c.ports!.map(p => p.id)));
  for (const e of graph.edges!) for (const p of [...e.sources, ...e.targets]) assert.ok(ports.has(p), p);
});

test('an explanation band grows the card and shifts its field ports; unexplained cards are unchanged', async () => {
  const explained: DiagramNode = { ...base.nodes[2], explanation: 'Wide table with many columns.' };
  for (const expanded of [false, true]) {
    assert.equal(cardSize(explained, expanded).height, cardSize(base.nodes[2], expanded).height + EXPLANATION_HEIGHT);
  }
  assert.equal(cardSize({ ...base.nodes[0], explanation: null }, false).height, HEADER_HEIGHT + ROW_HEIGHT);
  const portY = (r: ViewResult, id: string, handle: string) =>
    elkGraph(r, [], []).children!.find(c => c.id === id)!.ports!.find(p => p.id === portId(id, handle))!.y!;
  const withExplained = result([base.nodes[0], base.nodes[1], explained, base.nodes[3]], base.edges);
  assert.equal(portY(withExplained, 'wide', 'card:s'), HEADER_HEIGHT / 2);
  assert.equal(portY(withExplained, 'wide', 'f:id:s'), HEADER_HEIGHT + EXPLANATION_HEIGHT + ROW_HEIGHT / 2);
  assert.equal(portY(withExplained, 'wide', 'more:t'), portY(base, 'wide', 'more:t') + EXPLANATION_HEIGHT);
  assert.deepEqual(elkGraph(withExplained, [], []).children!.filter(c => c.id !== 'wide'), elkGraph(base, [], []).children!.filter(c => c.id !== 'wide'));
  assertNoOverlap(withExplained, await layoutPositions(elk, withExplained, [], [], {}), []);
});

test('hidden nodes and their edges are excluded', () => {
  const graph = elkGraph(base, ['users'], []);
  assert.deepEqual(graph.children!.map(c => c.id), ['posts', 'wide', 'lonely']);
  assert.deepEqual(graph.edges!.map(e => e.id), ['wide.late_ref->posts']);
});

test('positions: local state beats the view file, ELK fills the rest without overlaps', async () => {
  const withFile = { ...base, layout: { positions: { users: { x: 1, y: 1 }, posts: { x: 2, y: 2 } } } } as ViewResult;
  const fixed = storedPositions(withFile, { users: { x: 500, y: 500 } }, true);
  assert.deepEqual(fixed, { users: { x: 500, y: 500 }, posts: { x: 2, y: 2 } });
  assert.deepEqual(storedPositions(withFile, {}, false), {});
  const all = await layoutPositions(elk, base, [], [], {});
  assert.deepEqual(Object.keys(all).sort(), ['lonely', 'posts', 'users', 'wide']);
  assertNoOverlap(base, all, []);
  const allFixed = { users: { x: 0, y: 0 }, posts: { x: 400, y: 0 }, wide: { x: 0, y: 400 }, lonely: { x: 400, y: 400 } };
  assert.deepEqual(await layoutPositions({ layout: () => { throw new Error('ELK not needed') } }, base, [], [], allFixed), allFixed);
  assert.deepEqual(Object.keys(await layoutPositions(elk, base, ['wide', 'lonely'], [], {})).sort(), ['posts', 'users']);
});

test('incremental placement keeps existing positions and avoids overlaps', async () => {
  // Existing cards crowd the area where new cards would go relative to their neighbour.
  const existing: Positions = { users: { x: 0, y: 0 }, posts: { x: 0, y: 120 }, lonely: { x: 300, y: 0 } };
  const added = result([...base.nodes, node('comments', [field('id', ['PK']), field('post_id', ['FK'])]), node('island')],
    [...base.edges, fk('comments', 'post_id', 'posts')]);
  const out = await layoutPositions(elk, added, [], [], existing);
  for (const [id, p] of Object.entries(existing)) assert.deepEqual(out[id], p);
  assert.deepEqual(Object.keys(out).sort(), ['comments', 'island', 'lonely', 'posts', 'users', 'wide']);
  assertNoOverlap(added, out, []);
  // Deterministic for the same input.
  assert.deepEqual(await layoutPositions(elk, added, [], [], existing), out);
});

test('large graph lays out (150 tables x 15 columns)', async () => {
  const nodes = Array.from({ length: 150 }, (_, i) => node(`t${i}`, [field('id', ['PK']), field('parent_id', ['FK']), ...Array.from({ length: 13 }, (_, j) => field(`c${j}`))]));
  const edges = nodes.slice(1).map((n, i) => fk(n.id, 'parent_id', `t${Math.floor(i / 3)}`));
  const big = result(nodes, edges);
  const out = await layoutPositions(elk, big, [], [], {});
  assert.equal(Object.keys(out).length, 150);
  assertNoOverlap(big, out, []);
});

function assertNoOverlap(r: ViewResult, pos: Positions, expanded: string[]) {
  const rects = r.nodes.filter(n => pos[n.id]).map(n => ({ id: n.id, ...pos[n.id], ...cardSize(n, expanded.includes(n.id)) }));
  for (const a of rects) for (const b of rects) {
    if (a.id >= b.id) continue;
    const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
  }
}
