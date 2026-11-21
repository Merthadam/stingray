import test from 'node:test';
import assert from 'node:assert/strict';
import { formatText } from '../src/views-text';
import type { DiagramEdge, DiagramField, DiagramNode } from '../src/views';

const node = (id: string, extra: Partial<DiagramNode> = {}): DiagramNode =>
  ({ id, label: id, kind: 'step', subtitle: null, group: null, fields: [], source: null, symbol: null, role: null, order: null, detail: null, ...extra });
const edge = (from: string, to: string, extra: Partial<DiagramEdge> = {}): DiagramEdge =>
  ({ id: `${from}->${to}`, from, to, fromField: null, toField: null, kind: 'next', style: 'solid', certain: true, label: null, source: null, ...extra });
const field = (id: string, extra: Partial<DiagramField> = {}): DiagramField => ({ id, label: id, type: null, badges: [], detail: null, source: null, ...extra });

test('formatText flow: start/end markers, solid, uncertain and labelled edges', () => {
  const text = formatText({ kind: 'flow', groups: [], truncated: false,
    nodes: [node('START', { role: 'start' }), node('plan'), node('END', { role: 'end' })],
    edges: [edge('START', 'plan'), edge('plan', 'END', { certain: false, label: 'done' }), edge('plan', 'plan', { style: 'dashed' })] });
  assert.equal(text, [
    'flow: 3 nodes, 3 edges',
    '  [start] START (step)', '  plan (step)', '  [end] END (step)',
    'edges:', '  START -> plan', '  plan ..> END [done]', '  plan ..> plan',
  ].join('\n'));
});

test('formatText timeline: by order when set, else topological; ties keep input order', () => {
  const ordered = formatText({ kind: 'timeline', groups: [], truncated: false, edges: [],
    nodes: [node('b', { order: 2 }), node('x'), node('a', { order: 1 })] });
  assert.deepEqual(ordered.split('\n').slice(1), ['  1. a (step)', '  2. b (step)', '  3. x (step)']);
  const topo = formatText({ kind: 'timeline', groups: [], truncated: true,
    nodes: [node('m3'), node('m2'), node('m1'), node('loose')], edges: [edge('m1', 'm2'), edge('m2', 'm3')] });
  assert.deepEqual(topo.split('\n'), ['timeline: 4 nodes, 2 edges (truncated: a limit was hit)',
    '  1. m1 (step)', '  2. m2 (step)  <- m1', '  3. m3 (step)  <- m2', '  4. loose (step)']);
  // A cycle still lists every node once.
  const cycle = formatText({ kind: 'timeline', groups: [], truncated: false, nodes: [node('a'), node('b')], edges: [edge('a', 'b'), edge('b', 'a')] });
  assert.equal(cycle.split('\n').length, 3);
});

test('formatText tables: groups, fields with types and badges, field-level FK edges', () => {
  const text = formatText({ kind: 'tables', truncated: false, groups: [{ id: 'g', label: 'app.models', source: null }],
    nodes: [
      node('users', { kind: 'table', group: 'g', subtitle: 'User', fields: [field('id', { type: 'Integer', badges: ['PK'] })] }),
      node('posts', { kind: 'table', group: 'g', fields: [field('user_id', { label: 'author_id', type: 'Integer', badges: ['FK', 'NULL'] })] }),
    ],
    edges: [edge('posts', 'users', { kind: 'foreign-key', fromField: 'user_id', toField: 'id' })] });
  assert.equal(text, [
    'tables: 2 nodes, 1 edges', 'app.models:',
    '  users — User', '    - id: Integer [PK]', '  posts', '    - author_id: Integer [FK, NULL]',
    'edges:', '  posts.author_id -> users.id [foreign-key]',
  ].join('\n'));
});

test('formatText graph: ungrouped first, then groups; duplicate labels get their id', () => {
  const text = formatText({ kind: 'graph', truncated: false, groups: [{ id: 'net', label: 'Network', source: null }],
    nodes: [node('a', { group: 'net', label: 'svc' }), node('b', { label: 'svc', kind: 'function', fields: [field('calls', { detail: 'slugify' })] })],
    edges: [edge('b', 'a', { kind: 'calls' })] });
  assert.equal(text, [
    'graph: 2 nodes, 1 edges', '  svc (b) (function)', '    - calls — slugify', 'Network:', '  svc (a) (step)', 'edges:', '  svc (b) -> svc (a)',
  ].join('\n'));
});

test('formatText: an explanation follows the node line; nodes without one are unchanged', () => {
  const text = formatText({ kind: 'graph', truncated: false, groups: [],
    nodes: [node('auth', { kind: 'function', detail: 'auth.py', explanation: 'Accept only genuine tokens.' }), node('plain', { explanation: null })], edges: [] });
  assert.equal(text, ['graph: 2 nodes, 0 edges', '  auth (function) · auth.py — Accept only genuine tokens.', '  plain (step)'].join('\n'));
});

test('formatText: a long explanation is cut at 300 chars with an ellipsis', () => {
  const long = 'word '.repeat(100).trim();
  const line = formatText({ kind: 'graph', truncated: false, groups: [], nodes: [node('a', { explanation: long })], edges: [] }).split('\n')[1];
  const shown = line.split(' — ')[1];
  assert.equal(shown.length, 300);
  assert.ok(shown.endsWith('…') && long.startsWith(shown.slice(0, -1)));
});

test('formatText flowchart: expanded-call group headers and call nodes show their explanation', () => {
  const text = formatText({ kind: 'flowchart', truncated: false, groups: [{ id: 'g', label: 'identity', source: null, explanation: 'Accept a token.' }],
    nodes: [node('s', { kind: 'start', role: 'start', label: 'sign_in' }), node('c', { kind: 'call', label: 'verify', group: 'g', explanation: 'Check it.' })],
    edges: [edge('s', 'c')] });
  assert.deepEqual(text.split('\n').slice(1), ['  (start) sign_in', '  » identity — Accept a token.', '    [call] verify — Check it.']);
});

test('formatText caps output lines', () => {
  const nodes = Array.from({ length: 500 }, (_, i) => node(`n${i}`));
  const lines = formatText({ kind: 'graph', groups: [], nodes, edges: [], truncated: false }).split('\n');
  assert.equal(lines.length, 401);
  assert.equal(lines[400], '… 101 more lines');
});

test('formatText graph: nested groups (layers) are titled by their path', () => {
  const text = formatText({ kind: 'graph', truncated: false, edges: [], groups: [{ id: 's', label: 'CRUD backend', source: null, parent: null },
    { id: 'm', label: '(root)', source: null, parent: 's' }], nodes: [{ ...node('file:a.py'), label: 'a.py', kind: 'file', group: 'm' }] });
  assert.deepEqual(text.split('\n'), ['graph: 1 nodes, 0 edges', 'CRUD backend / (root):', '  a.py (file)']);
});
