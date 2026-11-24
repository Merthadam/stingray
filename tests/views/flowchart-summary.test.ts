import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiagramEdge, DiagramGroup, DiagramNode } from '../../shared/contracts/views';
import { summarizeFlowchart } from '../../shared/views/flowchart-summary';

const n = (id: string, kind: string, extra: Partial<DiagramNode> = {}): DiagramNode =>
  ({ id, label: id, kind, subtitle: null, group: null, fields: [], source: { file: 'a.py', line: 1 }, symbol: null, role: null, order: null, detail: null, ...extra });
const e = (spec: string, extra: Partial<DiagramEdge> = {}): DiagramEdge => {
  const [, from, to, label] = /^(\S+)->(\S+?)(?::(\S+))?$/.exec(spec)!;
  const kind = label === 'Yes' ? 'yes' : label === 'No' ? 'no' : 'next';
  return { id: `${kind}:${spec}`, from, to, fromField: null, toField: null, kind, style: 'solid', certain: true, label: label ?? null, source: null, ...extra };
};
const chart = (nodes: DiagramNode[], edges: DiagramEdge[], groups: DiagramGroup[] = []) => ({ kind: 'flowchart' as const, nodes, edges, groups });
const flow = (r: { edges: DiagramEdge[] }) => r.edges.map(x => `${x.from}->${x.to}${x.label ? ':' + x.label : ''}`);

test('guards fold into a can-fail badge on the step before them; undescribed library steps are bridged', () => {
  const input = chart(
    [n('start', 'start', { role: 'start' }), n('load', 'call'), n('empty?', 'decision'), n('ValueError', 'error', { source: { file: 'a.py', line: 9 } }),
      n('clock', 'action'), n('save', 'action', { explanation: 'Stores the user' }), n('done', 'end', { role: 'end' })],
    [e('start->load'), e('load->empty?'), e('empty?->ValueError:Yes'), e('empty?->clock:No'), e('clock->save'), e('save->done')]);
  const { result, hidden, folded } = summarizeFlowchart(input);
  assert.deepEqual(result.nodes.map(x => x.id), ['start', 'load', 'save', 'done']);
  assert.deepEqual(flow(result), ['start->load', 'load->save', 'save->done']);
  assert.deepEqual(result.nodes[1].failures, [{ label: 'ValueError', condition: 'empty?', source: { file: 'a.py', line: 9 } }]);
  assert.deepEqual([hidden, folded], [1, 1]);
  assert.equal(input.nodes.find(x => x.id === 'load')!.failures, undefined, 'the input is not changed');
  assert.equal(summarizeFlowchart(input, { allSteps: true }).result, input);
});

test('a guard after the start goes on the step after it; the error branch on No is named; explained decisions stay', () => {
  const input = chart(
    [n('start', 'start'), n('ok?', 'decision'), n('Denied', 'error'), n('work', 'call'), n('valid?', 'decision', { explanation: 'Is the token valid' }),
      n('Bad', 'error'), n('done', 'end')],
    [e('start->ok?'), e('ok?->work:Yes'), e('ok?->Denied:No'), e('work->valid?'), e('valid?->done:Yes'), e('valid?->Bad:No')]);
  const { result } = summarizeFlowchart(input);
  assert.deepEqual(result.nodes.map(x => x.id), ['start', 'work', 'valid?', 'Bad', 'done']);
  assert.deepEqual(result.nodes[1].failures!.map(f => f.condition), ['ok? (No)']);
  assert.deepEqual(flow(result), ['start->work', 'work->valid?', 'valid?->done:Yes', 'valid?->Bad:No']);
});

test('decisions and loops left with one way out go; empty groups go; groups shown in full keep every step', () => {
  const input = chart(
    [n('start', 'start'), n('more?', 'loop', { group: 'g' }), n('log', 'action', { group: 'g' }), n('fast?', 'decision', { group: 'g' }),
      n('a', 'action', { group: 'g' }), n('b', 'action', { group: 'g' }), n('done', 'end')],
    [e('start->more?'), e('more?->log:Yes'), { ...e('log->more?'), kind: 'loop' }, e('more?->fast?:No'), e('fast?->a:Yes'), e('fast?->b:No'),
      e('a->done', { certain: false, style: 'dashed' }), e('b->done')],
    [{ id: 'g', label: 'scan', source: null, parent: null }, { id: 'g2', label: 'inner', source: null, parent: 'g' }]);
  const { result, hidden } = summarizeFlowchart(input);
  assert.deepEqual(result.nodes.map(x => x.id), ['start', 'done']);
  assert.deepEqual(flow(result), ['start->done']);
  assert.equal(result.edges[0].style, 'dashed', 'a bridge over an uncertain edge is dashed');
  assert.deepEqual(result.groups, []);
  assert.equal(hidden, 5);
  const full = summarizeFlowchart(input, { allStepsIn: ['g'] });
  assert.deepEqual([full.hidden, full.folded], [0, 0]);
  assert.equal(full.result, input);
});
