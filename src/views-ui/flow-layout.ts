// Flow geometry stays in absolute coordinates so local state and saved views share the tables contract.
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { DiagramNode, ViewResult } from '../views';
import type { ElkLayouter, Positions } from './er-layout';

export const flowSize = (node: DiagramNode) => node.role ? { width: 88, height: 32 } : { width: 220, height: 64 };
export const shortEdgeLabel = (label: string) => label.length > 38 ? `${label.slice(0, 37)}…` : label;
const options = {
  'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.nodeNode': '90', 'elk.layered.spacing.nodeNodeBetweenLayers': '100',
  'elk.spacing.componentComponent': '100', 'elk.padding': '[top=50,left=40,bottom=40,right=100]',
};

export function flowGraph(result: ViewResult): ElkNode {
  const groups = new Map(result.groups.map((g, i) => [g.id, { id: `group:${i}`, children: [] as ElkNode[], layoutOptions: options }]));
  const children: ElkNode[] = [];
  // Use internal IDs so arbitrary extractor IDs cannot collide with compound IDs or ELK ports.
  const ids = new Map(result.nodes.map((n, i) => [n.id, `node:${i}`]));
  for (const n of result.nodes) {
    const node = { id: ids.get(n.id)!, ...flowSize(n) };
    const group = n.group && groups.get(n.group);
    (group ? group.children : children).push(node);
  }
  children.push(...[...groups.values()].filter(g => g.children.length));
  return {
    id: 'root', children,
    layoutOptions: { ...options, 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' },
    edges: result.edges.filter(e => ids.has(e.from) && ids.has(e.to)).map((e, i) => ({
      id: `edge:${i}`, sources: [ids.get(e.from)!], targets: [ids.get(e.to)!],
      labels: e.label ? [{ text: shortEdgeLabel(e.label), width: shortEdgeLabel(e.label).length * 6.5 + 16, height: 24 }] : [],
    })),
  };
}

export async function flowPositions(elk: ElkLayouter, result: ViewResult): Promise<Positions> {
  const graph = await elk.layout(flowGraph(result));
  const positions: Positions = {};
  const visit = (parent: ElkNode, x: number, y: number) => {
    for (const child of parent.children ?? []) {
      const px = x + (child.x ?? 0), py = y + (child.y ?? 0);
      if (child.id.startsWith('node:')) positions[result.nodes[Number(child.id.slice(5))].id] = { x: Math.round(px), y: Math.round(py) };
      visit(child, px, py);
    }
  };
  visit(graph, 0, 0);
  orderBranches(result, positions);
  return positions;
}

// ELK's model-order options crash with nested hierarchies, so put branch targets in extractor order (router
// condition order: 1., 2., ..., else) by swapping the x slots of same-layer siblings after layout.
function orderBranches(result: ViewResult, positions: Positions) {
  const bySource = new Map<string, string[]>();
  for (const e of result.edges) if (e.kind === 'branch' && e.from !== e.to && positions[e.to]) {
    const targets = bySource.get(e.from) ?? [];
    if (!targets.includes(e.to)) bySource.set(e.from, [...targets, e.to]);
  }
  for (const targets of bySource.values()) {
    if (targets.length < 2 || new Set(targets.map(id => positions[id].y)).size !== 1) continue;
    const slots = targets.map(id => positions[id].x).sort((a, b) => a - b);
    targets.forEach((id, i) => { positions[id] = { ...positions[id], x: slots[i] }; });
  }
}

export function flowFrames(result: ViewResult, positions: Positions) {
  return result.groups.flatMap(group => {
    const nodes = result.nodes.filter(n => n.group === group.id && positions[n.id]);
    if (!nodes.length) return [];
    const x = Math.min(...nodes.map(n => positions[n.id].x)) - 40;
    const y = Math.min(...nodes.map(n => positions[n.id].y)) - 50;
    const right = Math.max(...nodes.map(n => positions[n.id].x + flowSize(n).width)) + 100;
    const bottom = Math.max(...nodes.map(n => positions[n.id].y + flowSize(n).height)) + 40;
    return [{ group, x, y, width: right - x, height: bottom - y }];
  });
}
