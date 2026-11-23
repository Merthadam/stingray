import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FLOW_NODES, computedDepth, diagnosticCount, isFlowDiagram, isSequenceDiagram, textViewNote, viewDepth, matchingLines, pickView, saveViewInput, splitMatches } from '../src/views-tab-model';
import type { DiagramNode, ViewResult, ViewSummary } from '../shared/contracts/views';

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

const chartDiagnostics = (error: string | null) => ({ rules: [], graph: null, unresolved: [], limits: { filesScanned: 0, matches: 0, truncated: false }, ms: 1,
  flowchart: { start: 'login (app/auth.py:3)', depth: 2, functions: 2, nodes: 9, truncated: false, error } });

test('diagnosticCount counts a flowchart error', () => {
  assert.equal(diagnosticCount(result({ kind: 'flowchart', diagnostics: chartDiagnostics('start symbol not found: login') })), 1);
  assert.equal(diagnosticCount(result({ kind: 'flowchart', diagnostics: chartDiagnostics(null) })), 0);
});

test('viewDepth prefers the session override, else the computed depth; layers start at 1; null without a depth', () => {
  const chart = result({ kind: 'flowchart', diagnostics: chartDiagnostics(null) });
  assert.deepEqual(viewDepth(chart, undefined), { value: 2, min: 0, max: 4, layers: false });
  assert.deepEqual(viewDepth(chart, 0), { value: 0, min: 0, max: 4, layers: false });
  const layers = result({ kind: 'graph', diagnostics: { ...chartDiagnostics(null), flowchart: null,
    layers: { config: null, depth: 1, services: 2, files: 3, nodes: 2, error: null } } });
  assert.deepEqual(viewDepth(layers, undefined), { value: 1, min: 1, max: 4, layers: true });
  assert.deepEqual(viewDepth(layers, 3), { value: 3, min: 1, max: 4, layers: true });
  assert.equal(viewDepth(result(), 3), null);
  assert.equal(viewDepth(null, 3), null);
  assert.ok(isFlowDiagram(layers) && isFlowDiagram(chart) && isFlowDiagram(result({ kind: 'graph' })) && isFlowDiagram(result({ kind: 'flow' })));
  assert.ok(!isFlowDiagram(result()) && !isFlowDiagram(result({ kind: 'timeline' })), 'tables draw as ER, timeline falls back to text');
  const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}` })) as ViewResult['nodes'];
  const big = result({ kind: 'graph', nodes: nodes(MAX_FLOW_NODES + 1) });
  assert.ok(isFlowDiagram(result({ kind: 'graph', nodes: nodes(MAX_FLOW_NODES) })) && !isFlowDiagram(big), 'too many nodes fall back to text');
  assert.match(textViewNote(big), /401 nodes, more than the 400/);
  assert.match(textViewNote(result({ kind: 'timeline' })), /isn't drawn in the app yet/);
});

const sequenceDiagnostics = (error: string | null) => ({ ...chartDiagnostics(null), flowchart: null,
  sequence: { start: 'submit (web/Login.tsx:3)', depth: 3, participants: 'service', functions: 4, messages: 9, links: { http: 1 }, truncated: false, error } });

test('sequence views: depth slider 0-6 from the sequence diagnostic, error counted, drawn only with a computed sequence', () => {
  const ok = result({ kind: 'sequence', diagnostics: sequenceDiagnostics(null), sequence: { participants: [], messages: [], fragments: [], notes: [] } });
  assert.deepEqual(viewDepth(ok, undefined), { value: 3, min: 0, max: 6, layers: false });
  assert.deepEqual(viewDepth(ok, 6), { value: 6, min: 0, max: 6, layers: false });
  assert.equal(computedDepth(ok), 3);
  assert.equal(computedDepth(result({ kind: 'flowchart', diagnostics: chartDiagnostics(null) })), 2);
  assert.ok(isSequenceDiagram(ok) && !isFlowDiagram(ok));
  const failed = result({ kind: 'sequence', diagnostics: sequenceDiagnostics('start symbol not found: submit'), sequence: null });
  assert.ok(!isSequenceDiagram(failed) && !isSequenceDiagram(result()));
  assert.equal(diagnosticCount(failed), 1);
  assert.match(textViewNote(failed), /No sequence was computed/);
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
