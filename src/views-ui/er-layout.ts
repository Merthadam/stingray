// Pure ER layout: card geometry, ELK graph with one port per visible field row, and stable/incremental placement.
// Runs in the renderer (ELK in a worker) and in Node tests (elk.bundled.js); the ELK instance is injected.
import type { ElkNode, ElkPort, ElkExtendedEdge } from 'elkjs/lib/elk-api.js';
import type { DiagramEdge, DiagramField, DiagramNode, ViewResult } from '../views';

export type Positions = Record<string, { x: number; y: number }>;
export interface ElkLayouter { layout(graph: ElkNode): Promise<ElkNode> }

export const CARD_WIDTH = 260;
export const HEADER_HEIGHT = 44;
export const ROW_HEIGHT = 22;
export const MAX_ROWS = 12;
const GAP = 40;

const isKey = (f: DiagramField) => f.badges.includes('PK') || f.badges.includes('FK');

/** Rows a card shows: all fields, or (collapsed, > MAX_ROWS) key fields first, then the first others, in field order. */
export function cardRows(node: DiagramNode, expanded: boolean): { rows: DiagramField[]; more: number; toggle: boolean } {
  const toggle = node.fields.length > MAX_ROWS;
  if (!toggle || expanded) return { rows: node.fields, more: 0, toggle };
  const keep = new Set(node.fields.filter(isKey).slice(0, MAX_ROWS));
  for (const f of node.fields) { if (keep.size >= MAX_ROWS) break; keep.add(f); }
  const rows = node.fields.filter(f => keep.has(f));
  return { rows, more: node.fields.length - rows.length, toggle };
}

/** Card size; a long card has one extra row for "+N more" / "Show less". */
export function cardSize(node: DiagramNode, expanded: boolean) {
  const { rows, toggle } = cardRows(node, expanded);
  return { width: CARD_WIDTH, height: HEADER_HEIGHT + (rows.length + (toggle ? 1 : 0)) * ROW_HEIGHT };
}

/** React Flow handle id for an edge end: the field row, the "+N more" row when the field is collapsed away, else the card. */
export function handleId(node: DiagramNode, fieldId: string | null, expanded: boolean, side: 's' | 't'): string {
  if (fieldId === null || !node.fields.some(f => f.id === fieldId)) return `card:${side}`;
  return cardRows(node, expanded).rows.some(f => f.id === fieldId) ? `f:${fieldId}:${side}` : `more:${side}`;
}

export function visibleNodes(result: ViewResult, hidden: Iterable<string>): DiagramNode[] {
  const h = new Set(hidden);
  return result.nodes.filter(n => !h.has(n.id));
}

export function visibleEdges(result: ViewResult, visible: DiagramNode[]): DiagramEdge[] {
  const ids = new Set(visible.map(n => n.id));
  return result.edges.filter(e => ids.has(e.from) && ids.has(e.to));
}

export const portId = (nodeId: string, handle: string) => `${nodeId}|${handle}`;

export function elkGraph(result: ViewResult, hidden: Iterable<string>, expanded: Iterable<string>): ElkNode {
  const exp = new Set(expanded);
  const nodes = visibleNodes(result, hidden);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const children: ElkNode[] = nodes.map(n => {
    const { rows, toggle } = cardRows(n, exp.has(n.id));
    const ports: ElkPort[] = [];
    const add = (handle: string, y: number) => {
      ports.push({ id: portId(n.id, `${handle}:t`), x: 0, y, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'WEST' } });
      ports.push({ id: portId(n.id, `${handle}:s`), x: CARD_WIDTH - 1, y, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'EAST' } });
    };
    add('card', HEADER_HEIGHT / 2);
    rows.forEach((f, i) => add(`f:${f.id}`, HEADER_HEIGHT + i * ROW_HEIGHT + ROW_HEIGHT / 2));
    if (toggle) add('more', HEADER_HEIGHT + rows.length * ROW_HEIGHT + ROW_HEIGHT / 2);
    return { id: n.id, ...cardSize(n, exp.has(n.id)), ports, layoutOptions: { 'elk.portConstraints': 'FIXED_ORDER' } };
  });
  const edges: ElkExtendedEdge[] = visibleEdges(result, nodes).map(e => ({
    id: e.id,
    sources: [portId(e.from, handleId(byId.get(e.from)!, e.fromField, exp.has(e.from), 's'))],
    targets: [portId(e.to, handleId(byId.get(e.to)!, e.toField, exp.has(e.to), 't'))],
  }));
  return {
    id: 'root', children, edges,
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': String(GAP), 'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.spacing.componentComponent': String(GAP),
    },
  };
}

/** Stored positions by priority: local state > view file `layout:`. `useFile` is false after "Re-layout". */
export function storedPositions(result: ViewResult, local: Positions, useFile: boolean): Positions {
  return { ...(useFile ? result.layout?.positions : undefined), ...local };
}

/**
 * Positions for every visible node. Fixed nodes keep theirs; the rest come from ELK on the full visible graph.
 * When some nodes are fixed, each new node keeps its ELK offset to a fixed neighbour (or sits right of the
 * existing cards) and is pushed down until it overlaps no placed card.
 */
export async function layoutPositions(elk: ElkLayouter, result: ViewResult, hidden: Iterable<string>,
  expanded: Iterable<string>, fixed: Positions): Promise<Positions> {
  const exp = new Set(expanded);
  const nodes = visibleNodes(result, hidden);
  const out: Positions = {};
  for (const n of nodes) if (fixed[n.id]) out[n.id] = { ...fixed[n.id] };
  const fresh = nodes.filter(n => !out[n.id]);
  if (!fresh.length) return out;
  const laid = await elk.layout(elkGraph(result, hidden, exp));
  const elkPos: Positions = {};
  for (const c of laid.children ?? []) elkPos[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
  if (fresh.length === nodes.length) {
    for (const n of nodes) out[n.id] = elkPos[n.id] ?? { x: 0, y: 0 };
    return out;
  }

  const size = new Map(nodes.map(n => [n.id, cardSize(n, exp.has(n.id))]));
  const rects = Object.entries(out).map(([id, p]) => ({ ...p, ...size.get(id)! }));
  const right = Math.max(...rects.map(r => r.x + r.width)) + GAP * 2;
  const top = Math.min(...rects.map(r => r.y));
  const freshTop = Math.min(...fresh.map(n => elkPos[n.id]?.y ?? 0));
  const freshLeft = Math.min(...fresh.map(n => elkPos[n.id]?.x ?? 0));
  const neighbours = new Map<string, string[]>();
  for (const e of visibleEdges(result, nodes)) {
    neighbours.set(e.from, [...neighbours.get(e.from) ?? [], e.to]);
    neighbours.set(e.to, [...neighbours.get(e.to) ?? [], e.from]);
  }
  for (const n of fresh) {
    const own = elkPos[n.id] ?? { x: freshLeft, y: freshTop };
    const anchor = (neighbours.get(n.id) ?? []).find(id => out[id] && elkPos[id]);
    const p = anchor
      ? { x: out[anchor].x + own.x - elkPos[anchor].x, y: out[anchor].y + own.y - elkPos[anchor].y }
      : { x: right + own.x - freshLeft, y: top + own.y - freshTop };
    const { width, height } = size.get(n.id)!;
    // Push down past every overlapping card; each step clears one card, so this ends after at most rects.length moves.
    for (let moved = true; moved;) {
      moved = false;
      for (const r of rects) {
        if (p.x < r.x + r.width + GAP && p.x + width + GAP > r.x && p.y < r.y + r.height + GAP && p.y + height + GAP > r.y) {
          p.y = r.y + r.height + GAP; moved = true;
        }
      }
    }
    out[n.id] = p;
    rects.push({ ...p, width, height });
  }
  return out;
}
