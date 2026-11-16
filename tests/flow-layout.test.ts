import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { DiagramEdge, DiagramNode, ViewResult } from '../src/views';
import { flowFrames, flowGraph, flowPositions, flowSize, shortEdgeLabel } from '../src/views-ui/flow-layout';

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
