// Flow geometry stays in absolute coordinates so local state and saved views share the tables contract.
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { DiagramNode, ViewResult } from '../views';
import type { ElkLayouter, Positions } from './er-layout';

// Flowchart shapes (kind: flowchart): pills for start/end/error, diamonds for decision/loop, boxes otherwise.
const CHART_SIZES: Record<string, { width: number; height: number }> = {
  start: { width: 180, height: 36 }, end: { width: 180, height: 36 }, error: { width: 180, height: 36 },
  decision: { width: 220, height: 88 }, loop: { width: 220, height: 88 },
};
// Room for an explanation (docstring summary) clamped to 3 lines: in a box (wider, taller) and under a frame title.
const EXPLAINED_WIDTH = 260, EXPLANATION_HEIGHT = 48;
export const FRAME_EXPLANATION_HEIGHT = 52;
// One row per field in a step card (graph views: collapsed helpers of a function), at most MAX_FIELDS + a '+N more' row.
const FIELD_HEIGHT = 18, MAX_FIELDS = 8;
/** Fields listed on a step card and how many more are cut (the inspector lists all). */
export const cardFields = (node: DiagramNode) => ({ fields: node.fields.slice(0, MAX_FIELDS), more: Math.max(0, node.fields.length - MAX_FIELDS) });
/** Whether the node's card shows its explanation (never diamonds or the plain flow's tiny start/end pills). */
export const showsExplanation = (node: DiagramNode, flowchart = false) =>
  !!node.explanation && (flowchart ? node.kind !== 'decision' && node.kind !== 'loop' : !node.role);
export const flowSize = (node: DiagramNode, flowchart = false) => {
  const base = flowchart ? CHART_SIZES[node.kind] ?? { width: 220, height: 56 } : node.role ? { width: 88, height: 32 }
    : { width: 220, height: 64 + Math.min(node.fields.length, MAX_FIELDS + 1) * FIELD_HEIGHT };
  return showsExplanation(node, flowchart) ? { width: Math.max(base.width, EXPLAINED_WIDTH), height: base.height + EXPLANATION_HEIGHT } : base;
};
const BRANCH_KINDS = new Set(['branch', 'yes', 'no', 'case', 'except']);
export const shortEdgeLabel = (label: string) => label.length > 38 ? `${label.slice(0, 37)}…` : label;
const options = {
  'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.nodeNode': '90', 'elk.layered.spacing.nodeNodeBetweenLayers': '100',
  'elk.spacing.componentComponent': '100', 'elk.padding': '[top=50,left=40,bottom=40,right=100]',
};
const explainedOptions = { ...options, 'elk.padding': `[top=${50 + FRAME_EXPLANATION_HEIGHT},left=40,bottom=40,right=100]` };

export function flowGraph(result: ViewResult): ElkNode {
  const chart = result.kind === 'flowchart';
  const groups = new Map(result.groups.map((g, i) => [g.id, { id: `group:${i}`, children: [] as ElkNode[], layoutOptions: g.explanation ? explainedOptions : options }]));
  const children: ElkNode[] = [];
  // Use internal IDs so arbitrary extractor IDs cannot collide with compound IDs or ELK ports.
  const ids = new Map(result.nodes.map((n, i) => [n.id, `node:${i}`]));
  for (const n of result.nodes) {
    const node = { id: ids.get(n.id)!, ...flowSize(n, chart) };
    const group = n.group && groups.get(n.group);
    (group ? group.children : children).push(node);
  }
  // Nested groups (flowchart: a callee expanded inside another expansion) become compound nodes of their parent.
  for (const g of result.groups) (g.parent && groups.get(g.parent)?.children || children).push(groups.get(g.id)!);
  const prune = (list: ElkNode[]): ElkNode[] => list.filter(c => !c.id.startsWith('group:') || (c.children = prune(c.children!)).length);
  return {
    id: 'root',
    children: prune(children), layoutOptions: { ...options, 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' },
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
  for (const e of result.edges) if (BRANCH_KINDS.has(e.kind) && e.from !== e.to && positions[e.to]) {
    const targets = bySource.get(e.from) ?? [];
    if (!targets.includes(e.to)) bySource.set(e.from, [...targets, e.to]);
  }
  for (const targets of bySource.values()) {
    if (targets.length < 2 || new Set(targets.map(id => positions[id].y)).size !== 1) continue;
    const slots = targets.map(id => positions[id].x).sort((a, b) => a - b);
    targets.forEach((id, i) => { positions[id] = { ...positions[id], x: slots[i] }; });
  }
}

export type FlowFrame = ReturnType<typeof flowFrames>[number];

/** Detour for an edge entering an explained frame from above, so neither the line nor its label crosses the frame's
 * explanation: down to `aboveY`, across to a lane beside the frame, down to `belowY` (under the band), across to the target.
 * The label sits on the lane just above the frame, at `labelY`. Undefined for edges that need no detour. */
export function bandEntry(result: ViewResult, frames: FlowFrame[], positions: Positions, from: DiagramNode, to: DiagramNode) {
  const chain = (id: string | null | undefined) => {
    const ids: string[] = [];
    for (let g = id; g && !ids.includes(g); g = result.groups.find(x => x.id === g)?.parent) ids.push(g);
    return ids;
  };
  const outside = new Set(chain(from.group));
  // The outermost explained frame the edge enters; frames nested in it start below its band.
  const frame = chain(to.group).reverse().filter(id => !outside.has(id)).map(id => frames.find(f => f.group.id === id))
    .find(f => f?.group.explanation);
  const p = positions[from.id], size = flowSize(from, result.kind === 'flowchart');
  if (!frame || !p || p.y + size.height >= frame.y) return undefined;
  const sx = p.x + size.width / 2, sy = p.y + size.height, aboveY = (sy + frame.y) / 2;
  return { laneX: sx < frame.x + frame.width / 2 ? frame.x - 20 : frame.x + frame.width + 20, aboveY,
    belowY: frame.y + 50 + FRAME_EXPLANATION_HEIGHT - 13, labelY: (aboveY + frame.y) / 2 };
}

/** Group frames around their nodes and nested groups' frames, in `result.groups` order (flowchart: parents first). */
export function flowFrames(result: ViewResult, positions: Positions) {
  const chart = result.kind === 'flowchart';
  type Box = { x: number; y: number; right: number; bottom: number };
  const boxes = new Map<string, Box | null>();
  const box = (id: string): Box | null => {
    if (boxes.has(id)) return boxes.get(id)!;
    boxes.set(id, null); // guards parent cycles
    const inner: Box[] = [
      ...result.nodes.filter(n => n.group === id && positions[n.id]).map(n => {
        const p = positions[n.id], size = flowSize(n, chart);
        return { x: p.x, y: p.y, right: p.x + size.width, bottom: p.y + size.height };
      }),
      ...result.groups.filter(g => g.parent === id).flatMap(g => box(g.id) ?? []),
    ];
    const top = 50 + (result.groups.find(g => g.id === id)?.explanation ? FRAME_EXPLANATION_HEIGHT : 0);
    const b = inner.length ? { x: Math.min(...inner.map(i => i.x)) - 40, y: Math.min(...inner.map(i => i.y)) - top,
      right: Math.max(...inner.map(i => i.right)) + 100, bottom: Math.max(...inner.map(i => i.bottom)) + 40 } : null;
    boxes.set(id, b);
    return b;
  };
  return result.groups.flatMap(group => {
    const b = box(group.id);
    return b ? [{ group, x: b.x, y: b.y, width: b.right - b.x, height: b.bottom - b.y }] : [];
  });
}
