import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticCount, matchingLines, pickView, saveViewInput, splitMatches } from '../src/views-tab-model';
import type { DiagramNode, ViewResult, ViewSummary } from '../src/views';

const node = (id: string, label: string): DiagramNode => ({ id, label, kind: 'table', subtitle: null, group: null, fields: [], source: null, symbol: null, role: null, order: null, detail: null });
const result = (extra: Partial<ViewResult> = {}): ViewResult => ({
  id: 'database', name: 'Database', kind: 'tables', description: '', builtin: true, file: null, error: null,
  workspaceId: 'w', computedAt: 0, truncated: false, groups: [], edges: [], warnings: [], stats: {},
  graph: { state: 'ready', message: null }, diagnostics: null, layout: null,
  nodes: [node('g#users', 'users'), node('g#posts', 'posts'), node('h#posts', 'posts')], ...extra,
});

test('saveViewInput maps hidden ids to unique labels and keeps positions of shown nodes only', () => {
  const state = { hidden: ['g#posts', 'h#posts', 'gone'], positions: { 'g#users': { x: 1, y: 2 }, 'g#posts': { x: 3, y: 4 } }, expanded: [] };
  assert.deepEqual(saveViewInput('  Core  ', result(), state, true),
    { name: 'Core', basedOn: 'database', exclude: ['posts'], layout: { positions: { 'g#users': { x: 1, y: 2 } } } });
  assert.equal(saveViewInput('Core', result(), state, false).layout, null);
  assert.equal(saveViewInput('Core', result(), { ...state, positions: {} }, true).layout, null);
});

test('diagnosticCount sums warnings, rule errors/warnings and the graph step error', () => {
  const w = { file: 'a', line: 1, message: 'm' };
  assert.equal(diagnosticCount(result({ warnings: [w] })), 1);
  assert.equal(diagnosticCount(result({ warnings: [w], diagnostics: {
    rules: [{ rule: 'view#a', language: 'python', filesScanned: 1, matches: 0, emitted: 0, skipped: 0, errors: [w], warnings: [w, w], ms: 1 }],
    graph: { started: 0, reached: 0, helpers: 0, truncated: false, error: 'not ready' }, unresolved: [], limits: { filesScanned: 1, matches: 0, truncated: false }, ms: 1,
  } })), 5);
});

test('pickView keeps a stored view that still exists, else the first', () => {
  const list = [{ id: 'database' }, { id: 'flow' }] as ViewSummary[];
  assert.equal(pickView(list, 'flow'), 'flow');
  assert.equal(pickView(list, 'gone'), 'database');
  assert.equal(pickView([], 'flow'), null);
});

test('text search finds lines and splits matches case-insensitively', () => {
  assert.deepEqual(matchingLines(['Users', 'posts', 'user_id'], 'user'), [0, 2]);
  assert.deepEqual(matchingLines(['a'], ''), []);
  assert.deepEqual(splitMatches('aXbxc', 'x'), [{ text: 'a', match: false }, { text: 'X', match: true }, { text: 'b', match: false }, { text: 'x', match: true }, { text: 'c', match: false }]);
  assert.deepEqual(splitMatches('abc', ''), [{ text: 'abc', match: false }]);
});
