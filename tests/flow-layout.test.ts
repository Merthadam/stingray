import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { DiagramEdge, DiagramNode, ViewResult } from '../src/views';
import { FRAME_EXPLANATION_HEIGHT, flowFrames, flowGraph, flowPositions, flowSize, shortEdgeLabel } from '../src/views-ui/flow-layout';

const node = (id: string, group: string | null, role: DiagramNode['role'] = null): DiagramNode => ({
  id, label: id, group, role, kind: 'step', subtitle: 'handler', detail: null, fields: [], source: null, symbol: null, order: null,
});
const edge = (from: string, to: string, label: string | null = null): DiagramEdge => ({
  id: `${from}->${to}`, from, to, label, kind: label ? 'branch' : 'next', style: label ? 'dashed' : 'solid', certain: true,
  fromField: null, toField: null, source: null,
});
const result = {
  groups: [{ id: 'agent', label: 'Agent', source: null }, { id: 'research', label: 'Research', source: null }],
  nodes: [node('start', 'agent', 'start'), ...['stays', 'flights', 'cars', 'trains'].map(id => node(id, 'agent')), node('end', 'agent', 'end'),
    node('sub-start', 'research', 'start'), node('research', 'research'), node('sub-end', 'research', 'end')],
  edges: [...['stays', 'flights', 'cars', 'trains'].flatMap(id => [edge('start', id, `topic = ${id}`), edge(id, 'end')]),
    edge('sub-start', 'research'), edge('research', 'sub-end')],
} as ViewResult;

test('flow layout is layered top-to-bottom, keeps separate graph frames and fits every card', async () => {
  const graph = flowGraph(result);
  assert.equal(graph.layoutOptions!['elk.direction'], 'DOWN');
  assert.equal(graph.children!.length, 2);
  const positions = await flowPositions(new ELK(), result);
  assert.equal(Object.keys(positions).length, result.nodes.length);
  for (const e of result.edges) assert.ok(positions[e.from].y < positions[e.to].y, e.id);
  const frames = flowFrames(result, positions);
  assert.equal(frames.length, 2);
  const [a, b] = frames;
  assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  for (const n of result.nodes) {
    const frame = frames.find(f => f.group.id === n.group)!;
    const p = positions[n.id], size = flowSize(n);
    assert.ok(p.x >= frame.x && p.y >= frame.y + 40);
    assert.ok(p.x + size.width <= frame.x + frame.width && p.y + size.height <= frame.y + frame.height);
  }
});

test('flow layout accepts self-loops, back edges, cross-group edges and ungrouped nodes', async () => {
  const cyclic = { ...result, nodes: [...result.nodes, node('loose', null)], edges: [...result.edges,
    edge('stays', 'stays', 'retry'), edge('end', 'start', 'restart'), edge('end', 'research'), edge('research', 'loose')] };
  const positions = await flowPositions(new ELK(), cyclic);
  for (const n of cyclic.nodes) assert.ok(Number.isFinite(positions[n.id].x) && Number.isFinite(positions[n.id].y), n.id);
  assert.equal(Object.keys(positions).length, cyclic.nodes.length);
});

test('flow frames follow stored or dragged absolute positions; labels are bounded', () => {
  const single = { ...result, nodes: [node('start', 'agent', 'start')], edges: [] };
  const [frame] = flowFrames(single, { start: { x: -100, y: 200 } });
  assert.equal(frame.x, -140);
  assert.equal(frame.y, 150);
  assert.deepEqual(flowSize(single.nodes[0]), { width: 88, height: 32 });
  assert.equal(shortEdgeLabel('else'), 'else');
  assert.equal(shortEdgeLabel('1. topic ∈ {stays, flights, cars, trains, ferries, cruises}').length, 38);
});

test('branch targets are placed left to right in router condition order', async () => {
  const positions = await flowPositions(new ELK(), result);
  const xs = ['stays', 'flights', 'cars', 'trains'].map(id => positions[id].x);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b));
  const reversed = { ...result, edges: [...result.edges].reverse() };
  const back = await flowPositions(new ELK(), reversed);
  const rx = ['trains', 'cars', 'flights', 'stays'].map(id => back[id].x);
  assert.deepEqual(rx, [...rx].sort((a, b) => a - b));
});

test('flowchart layout nests expanded callees as frames inside their caller and sizes nodes by shape', async () => {
  const chartNode = (id: string, kind: string, group: string | null): DiagramNode => ({ ...node(id, group), kind });
  const chart = {
    kind: 'flowchart',
    groups: [{ id: 'call:a', label: 'a', source: null, parent: null }, { id: 'call:b', label: 'b', source: null, parent: 'call:a' }],
    nodes: [chartNode('start', 'start', null), chartNode('check', 'decision', 'call:a'), chartNode('save', 'call', 'call:a'),
      chartNode('fail', 'error', 'call:a'), chartNode('write', 'action', 'call:b'), chartNode('end', 'end', null)],
    edges: [edge('start', 'check'), { ...edge('check', 'save', 'Yes'), kind: 'yes' }, { ...edge('check', 'fail', 'No'), kind: 'no' },
      edge('save', 'write'), edge('write', 'end')],
  } as ViewResult;
  assert.deepEqual(flowSize(chart.nodes[1], true), { width: 220, height: 88 });
  assert.deepEqual(flowSize(chart.nodes[0], true), { width: 180, height: 36 });
  assert.deepEqual(flowSize(chart.nodes[2], true), { width: 220, height: 56 });
  const graph = flowGraph(chart);
  const outer = graph.children!.find(c => c.id === 'group:0')!;
  assert.ok(outer.children!.some(c => c.id === 'group:1'));
  const positions = await flowPositions(new ELK(), chart);
  assert.ok(positions.save.x < positions.fail.x, 'Yes branch left of No');
  const [a, b] = flowFrames(chart, positions);
  assert.ok(a.x < b.x && a.y < b.y && a.x + a.width > b.x + b.width && a.y + a.height > b.y + b.height);
});

test('step cards grow by one row per field (graph views: collapsed helpers), explanation room on top', () => {
  const helper = (name: string) => ({ id: `helper:${name}`, label: name, type: null, badges: [], detail: 'helper', source: null });
  const handle = { ...node('handle', null), fields: [helper('clean'), helper('log')] };
  assert.deepEqual(flowSize(handle), { width: 220, height: 100 });
  assert.deepEqual(flowSize({ ...handle, explanation: 'Handle a request.' }), { width: 260, height: 148 });
});

test('explained nodes and frames get room for the explanation; others keep their size', async () => {
  const chartNode = (id: string, kind: string, group: string | null, explanation?: string): DiagramNode => ({ ...node(id, group), kind, explanation });
  const why = 'Accept a Cognito access token and return the signed-in user.';
  assert.deepEqual(flowSize(chartNode('c', 'call', null, why), true), { width: 260, height: 104 });
  assert.deepEqual(flowSize(chartNode('s', 'start', null, why), true), { width: 260, height: 84 });
  assert.deepEqual(flowSize(chartNode('d', 'decision', null, why), true), { width: 220, height: 88 }, 'diamonds never show it');
  assert.deepEqual(flowSize(chartNode('c', 'call', null), true), { width: 220, height: 56 });
  assert.deepEqual(flowSize({ ...node('step', null), explanation: why }), { width: 260, height: 112 });
  assert.deepEqual(flowSize({ ...node('start', null, 'start'), explanation: why }), { width: 88, height: 32 }, 'flow pills never show it');
  const chart = {
    kind: 'flowchart',
    groups: [{ id: 'call:a', label: 'a', source: null, parent: null, explanation: why }, { id: 'call:b', label: 'b', source: null, parent: null }],
    nodes: [chartNode('start', 'start', null, why), chartNode('save', 'call', 'call:a', why), chartNode('write', 'action', 'call:b')],
    edges: [edge('start', 'save'), edge('save', 'write')],
  } as ViewResult;
  const positions = await flowPositions(new ELK(), chart);
  const [a, b] = flowFrames(chart, positions);
  assert.equal(positions.save.y - a.y, 50 + FRAME_EXPLANATION_HEIGHT);
  assert.equal(positions.write.y - b.y, 50);
  assert.ok(a.y >= positions.start.y + flowSize(chart.nodes[0], true).height, 'explained frame clears the start node');
  assert.ok(b.y >= a.y + a.height, 'frames do not overlap');
});
