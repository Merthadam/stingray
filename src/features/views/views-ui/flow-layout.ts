// Flow geometry stays in absolute coordinates so local state and saved views share the tables contract.
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { DiagramEdge, DiagramNode, ViewResult } from '../../../../shared/contracts/views';
import { splitWords } from '../../../../shared/views/words';
import type { ElkLayouter, Positions } from './er-layout';

// Flowchart shapes (kind: flowchart): pills for start/end/error, diamonds for decision/loop, boxes otherwise.
const CHART_SIZES: Record<string, { width: number; height: number }> = {
  start: { width: 180, height: 36 }, end: { width: 180, height: 36 }, error: { width: 180, height: 36 },
  decision: { width: 220, height: 88 }, loop: { width: 220, height: 88 },
};
// Room for an explanation (docstring summary) clamped to 3 lines: in a box (wider, taller) and under a frame title.
const EXPLAINED_WIDTH = 260, EXPLANATION_HEIGHT = 48;
export const FRAME_EXPLANATION_HEIGHT = 52;
// One line per field in a step card (graph views: collapsed helpers of a function; a field wraps to at most 2 lines), at
// most MAX_FIELDS + a '+N more' row.
const FIELD_HEIGHT = 16, MAX_FIELDS = 8;
/** Fields listed on a step card and how many more are cut (the inspector lists all). */
export const cardFields = (node: DiagramNode) => ({ fields: node.fields.slice(0, MAX_FIELDS), more: Math.max(0, node.fields.length - MAX_FIELDS) });
/** Whether the node's card shows its explanation (never diamonds or the plain flow's tiny start/end pills). */
export const showsExplanation = (node: DiagramNode, flowchart = false) =>
  !!node.explanation && (flowchart ? node.kind !== 'decision' && node.kind !== 'loop' : !node.role);
// Cloud resource (node.service): a 48px service icon with the resource name and the service name under it.
const INFRA_SIZE = { width: 168, height: 104 };
/** Name of a cloud resource under its icon: a Terraform address without its type (`aws_s3_bucket.logs` → `logs`, also
 * `data.<type>.<name>`); other labels (CDK construct ids) as they are. */
export const infraName = (node: DiagramNode) => node.label.replace(/^(data\.)?[a-z0-9]+_[a-z0-9_]+\.(?=.)/, '');
// Flowchart text metrics (layout runs without a DOM): average glyph widths of the card fonts, line heights, and the
// widest a card may grow before its label wraps to more lines (labels clamp at MAX_LINES; full text when selected).
const GLYPH = { box: 7, pill: 6.6 }, LINE = 16, MAX_LINES = 3, WIDE = 300;
/** Lines `text` takes when word-wrapped at `width` px (greedy, like the browser), at most MAX_LINES. */
export function textLines(text: string, width: number, glyph = GLYPH.box): number {
  const max = Math.max(1, Math.floor(width / glyph));
  let lines = 1, used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let w = word.length; w > 0; w -= max) { // a word longer than a line breaks (overflow-wrap: anywhere)
      const len = Math.min(w, max);
      if (used && used + 1 + len > max) { lines++; used = len; } else used += used ? 1 + len : len;
    }
  }
  return Math.min(lines, MAX_LINES);
}
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** Title of a step card (graph, flow and layers views): a symbol's or rule step's identifier in words (`get_user` → "get
 * user", like flowchart calls); other labels as they are. The raw name is in the inspector header. */
export const cardTitle = (node: DiagramNode) =>
  !node.role && (node.symbol || node.kind === 'step') && IDENTIFIER.test(node.label) ? splitWords(node.label) || node.label : node.label;
const CODE = /[()[\]{}=_/\\<>@#$`;:.]/;
/** A step card's subtitle when it reads as words ("3 files"); a code-like one (a handler name, a path, a constructor
 * call) only shows in the inspector, like `detail`. */
export const cardSubtitle = (node: DiagramNode) => {
  const s = node.subtitle?.trim();
  return s && /\s/.test(s) && !CODE.test(s) && s !== node.symbol?.name ? s : null;
};
/** Edge text on the canvas: a layers roll-up shows its total ("141"); the per-kind breakdown is in the edge inspector. */
export const edgeLabel = (edge: Pick<DiagramEdge, 'kind' | 'label'>) => edge.kind === 'depends' && edge.label ? edge.label.split(' · ')[0] : edge.label;
const DIAMONDS = new Set(['decision', 'loop']);
/** Text a flowchart card is titled with: a decision's or loop's explanation (an `explain:` entry, e.g. keyed by its
 * condition) replaces the label tidied from the code; other cards keep their label and show the explanation under it. */
export const chartLabel = (node: DiagramNode) => DIAMONDS.has(node.kind) && node.explanation ? node.explanation : node.label;
/** Steps a reader cannot follow without the code: decisions, loops, calls and actions without an explanation. */
export const undescribed = (node: DiagramNode) => !node.explanation && (DIAMONDS.has(node.kind) || node.kind === 'call' || node.kind === 'action');
/** Flowchart card size from its label: shapes keep their default size while the label fits in 2 lines (1 for pills),
 * else widen to WIDE and grow one LINE per extra line. */
function chartSize(node: DiagramNode) {
  const base = CHART_SIZES[node.kind] ?? { width: 220, height: 56 };
  if (node.kind === 'start' || node.kind === 'end' || node.kind === 'error') {
    const width = Math.min(WIDE, Math.max(base.width, Math.ceil(node.label.length * GLYPH.pill) + 28));
    return { width, height: base.height + (textLines(node.label, width - 24, GLYPH.pill) - 1) * 12 };
  }
  const diamond = DIAMONDS.has(node.kind), text = chartLabel(node);
  const pad = diamond ? 96 : node.kind === 'call' ? 46 : 28; // diamond insets, chevron
  const fits = textLines(text, base.width - pad) <= 2;
  const width = fits ? base.width : WIDE, lines = textLines(text, width - pad);
  return { width, height: base.height + Math.max(0, lines - (diamond ? 2 : 1)) * LINE };
}
/** Height of the "can fail" badge on a flowchart card with folded guards (node.failures). */
export const FAILURE_HEIGHT = 20;
/** Badge text: the first failure, "+N" for more. */
export const failureText = (node: DiagramNode) =>
  node.failures?.length ? `can fail: ${node.failures[0].label}${node.failures.length > 1 ? ` (+${node.failures.length - 1})` : ''}` : null;
/** Step card size (graph, flow and layers views) from its text: 220px (260 with an explanation) while the title fits in 2
 * lines, else WIDE; the title (up to 3 lines), a prose subtitle, fields (up to 2 lines each) and the explanation stack. */
function stepSize(node: DiagramNode) {
  const title = cardTitle(node), explained = showsExplanation(node), base = explained ? EXPLAINED_WIDTH : 220;
  const width = textLines(title, base - 28) <= 2 ? base : WIDE, { fields, more } = cardFields(node);
  const rows = fields.reduce((n, f) => n + Math.min(2, textLines(f.label, width - 40, 6.2)), 0) + (more ? 1 : 0);
  return { width, height: 32 + textLines(title, width - 28) * LINE + (cardSubtitle(node) ? 19 : 0) + (rows ? 5 + rows * FIELD_HEIGHT : 0)
    + (explained ? EXPLANATION_HEIGHT : 0) };
}
export const flowSize = (node: DiagramNode, flowchart = false) => {
  if (!flowchart && !node.service && !node.role) return stepSize(node);
  const sized = flowchart ? chartSize(node) : null;
  const base = sized ? (node.failures?.length ? { ...sized, height: sized.height + FAILURE_HEIGHT } : sized) : node.service ? INFRA_SIZE : { width: 88, height: 32 };
  return showsExplanation(node, flowchart) ? { width: Math.max(base.width, EXPLAINED_WIDTH), height: base.height + EXPLANATION_HEIGHT } : base;
};
const BRANCH_KINDS = new Set(['branch', 'yes', 'no', 'case', 'except']);
// Edge labels wrap to two lines; longer ones are cut (full text on hover and in the transition inspector).
const EDGE_LABEL_MAX = 60, EDGE_LABEL_WIDTH = 220;
export const shortEdgeLabel = (label: string) => label.length > EDGE_LABEL_MAX ? `${label.slice(0, EDGE_LABEL_MAX - 1)}…` : label;
const edgeLabelSize = (label: string) => {
  const text = shortEdgeLabel(label), width = Math.min(EDGE_LABEL_WIDTH, Math.ceil(text.length * 6.5) + 16);
  return { text, width, height: textLines(text, width - 14, 6.5) > 1 ? 38 : 24 };
};
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
      labels: e.label ? [edgeLabelSize(edgeLabel(e)!)] : [],
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

/** Fallback when ELK fails or times out: cards in node order, rows of 6, each row as tall as its tallest card. */
export function flowGrid(result: ViewResult): Positions {
  const chart = result.kind === 'flowchart', positions: Positions = {};
  for (let i = 0, y = 0; i < result.nodes.length; i += 6) {
    const row = result.nodes.slice(i, i + 6);
    row.forEach((n, j) => { positions[n.id] = { x: j * 320, y }; });
    y += Math.max(...row.map(n => flowSize(n, chart).height)) + 100;
  }
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

/** Frame and parent of each group id, built once per `flowFrames` result for routing every edge. */
export function frameIndex(result: ViewResult, frames: FlowFrame[]) {
  return { byGroup: new Map(frames.map(f => [f.group.id, f])), parents: new Map(result.groups.map(g => [g.id, g.parent])),
    explained: frames.some(f => f.group.explanation) };
}
export type FrameIndex = ReturnType<typeof frameIndex>;

/** Detour for an edge entering an explained frame from above (or from beside its band), so neither the line nor its label crosses the frame's
 * explanation: down to `aboveY`, across to a lane beside the frame, down to `belowY` (under the band), across to the target.
 * The label sits on the lane just above the frame, at (`labelX`, `labelY`). Undefined for edges that need no detour. */
export function bandEntry(result: ViewResult, index: FrameIndex, positions: Positions, from: DiagramNode, to: DiagramNode) {
  if (!index.explained) return undefined;
  const chain = (id: string | null | undefined) => {
    const ids: string[] = [];
    for (let g = id; g && !ids.includes(g); g = index.parents.get(g)) ids.push(g);
    return ids;
  };
  const outside = new Set(chain(from.group));
  // The outermost explained frame the edge enters; frames nested in it start below its band.
  const frame = chain(to.group).reverse().filter(id => !outside.has(id)).map(id => index.byGroup.get(id))
    .find(f => f?.group.explanation);
  const p = positions[from.id], size = flowSize(from, result.kind === 'flowchart');
  if (!frame || !p) return undefined;
  const sx = p.x + size.width / 2, sy = p.y + size.height;
  // A source ending beside the frame's title or explanation (above its first row) also detours: across to the lane just
  // under the source, labelled on that crossing; a source ending lower keeps its path.
  if (sy >= frame.y + frame.head) return undefined;
  const beside = sy >= frame.y, aboveY = beside ? sy + 16 : (sy + frame.y) / 2;
  const laneX = sx < frame.x + frame.width / 2 ? frame.x - 20 : frame.x + frame.width + 20;
  return { laneX, aboveY, belowY: frame.y + frame.head - 13,
    labelX: beside ? (sx + laneX) / 2 : laneX, labelY: beside ? aboveY : (aboveY + frame.y) / 2 };
}

/** Lines a frame title wraps to (at most 2) in a frame `width` px wide, minus padding (and a flowchart frame's buttons). */
const frameLabelLines = (label: string, width: number, chart: boolean) => Math.min(2, textLines(label, width - (chart ? 150 : 32), 7.2));

/** Group frames around their nodes and nested groups' frames, in `result.groups` order (flowchart: parents first); `head` is
 * the room above the first row (title, wrapped to 2 lines, and the explanation). */
export function flowFrames(result: ViewResult, positions: Positions) {
  const chart = result.kind === 'flowchart';
  type Box = { x: number; y: number; right: number; bottom: number; head?: number };
  // Children per group, indexed once: this runs on every drag step.
  const inner = new Map<string, Box[]>(), childGroups = new Map<string, string[]>();
  for (const n of result.nodes) if (n.group && positions[n.id]) {
    const p = positions[n.id], size = flowSize(n, chart);
    if (!inner.has(n.group)) inner.set(n.group, []);
    inner.get(n.group)!.push({ x: p.x, y: p.y, right: p.x + size.width, bottom: p.y + size.height });
  }
  for (const g of result.groups) if (g.parent) {
    if (!childGroups.has(g.parent)) childGroups.set(g.parent, []);
    childGroups.get(g.parent)!.push(g.id);
  }
  const explained = new Set(result.groups.filter(g => g.explanation).map(g => g.id)), labels = new Map(result.groups.map(g => [g.id, g.label]));
  const boxes = new Map<string, Required<Box> | null>();
  const box = (id: string): Required<Box> | null => {
    if (boxes.has(id)) return boxes.get(id)!;
    boxes.set(id, null); // guards parent cycles
    const all: Box[] = [...inner.get(id) ?? [], ...(childGroups.get(id) ?? []).flatMap(g => box(g) ?? [])];
    if (!all.length) return null;
    const x = Math.min(...all.map(i => i.x)) - 40, right = Math.max(...all.map(i => i.right)) + 100;
    const top = 50 + (explained.has(id) ? FRAME_EXPLANATION_HEIGHT : 0) + (frameLabelLines(labels.get(id) ?? '', right - x, chart) - 1) * LINE;
    const b = { x, y: Math.min(...all.map(i => i.y)) - top, right, bottom: Math.max(...all.map(i => i.bottom)) + 40, head: top };
    boxes.set(id, b);
    return b;
  };
  return result.groups.flatMap(group => {
    const b = box(group.id);
    return b ? [{ group, x: b.x, y: b.y, width: b.right - b.x, height: b.bottom - b.y, head: b.head }] : [];
  });
}
