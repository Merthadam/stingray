// Plain-text rendering of a diagram, shared by the `stingray-views` CLI (agents read it to check a view) and the Views tab. Pure and deterministic.
import type { DiagramEdge, DiagramField, DiagramGroup, DiagramNode, ViewKind } from './views';

export interface TextDiagramInput { kind: ViewKind; groups: DiagramGroup[]; nodes: DiagramNode[]; edges: DiagramEdge[]; truncated: boolean }
export const MAX_TEXT_LINES = 400;

export function formatText({ kind, groups, nodes, edges, truncated }: TextDiagramInput, maxLines = MAX_TEXT_LINES): string {
  // Labels name nodes; a label shared by several nodes gets its id appended so edges stay unambiguous.
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.label, (counts.get(n.label) ?? 0) + 1);
  const names = new Map(nodes.map(n => [n.id, counts.get(n.label)! > 1 && n.label !== n.id ? `${n.label} (${n.id})` : n.label]));
  const name = (id: string) => names.get(id) ?? id;
  const fieldName = (nodeId: string, fieldId: string | null) =>
    fieldId === null ? '' : '.' + (nodes.find(n => n.id === nodeId)?.fields.find(f => f.id === fieldId)?.label ?? fieldId);
  const edgeLine = (e: DiagramEdge, label = e.label) =>
    `  ${name(e.from)}${fieldName(e.from, e.fromField)} ${e.certain && e.style !== 'dashed' ? '->' : '..>'} ${name(e.to)}${fieldName(e.to, e.toField)}${label ? ` [${label}]` : ''}`;
  const fieldLine = (f: DiagramField) =>
    `    - ${f.label}${f.type ? `: ${f.type}` : ''}${f.badges.length ? ` [${f.badges.join(', ')}]` : ''}${f.detail ? ` — ${f.detail}` : ''}`;
  const nodeLine = (n: DiagramNode) =>
    `  ${n.role ? `[${n.role}] ` : ''}${name(n.id)}${n.kind && kind !== 'tables' ? ` (${n.kind})` : ''}${n.subtitle ? ` — ${n.subtitle}` : ''}${n.detail ? ` · ${n.detail}` : ''}`;

  const lines = [`${kind}: ${nodes.length} nodes, ${edges.length} edges${truncated ? ' (truncated: a limit was hit)' : ''}`];
  const byGroups = () => {
    const known = new Set(groups.map(g => g.id));
    const sections: [string | null, DiagramNode[]][] = [[null, nodes.filter(n => n.group === null || !known.has(n.group))],
      ...groups.map(g => [g.label, nodes.filter(n => n.group === g.id)] as [string, DiagramNode[]])];
    for (const [label, members] of sections) {
      if (!members.length) continue;
      if (label !== null) lines.push(`${label}:`);
      for (const n of members) lines.push(nodeLine(n), ...n.fields.map(fieldLine));
    }
  };

  if (kind === 'flowchart') {
    lines.push(...flowchartLines(nodes, edges, groups));
  } else if (kind === 'timeline') {
    const preds = new Map<string, string[]>();
    for (const e of edges) preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
    timelineOrder(nodes, edges).forEach((n, i) => {
      const after = preds.get(n.id);
      lines.push(`  ${i + 1}. ${nodeLine(n).trimStart()}${after ? `  <- ${after.map(name).join(', ')}` : ''}`);
    });
  } else {
    byGroups();
    if (edges.length) {
      lines.push('edges:');
      lines.push(...edges.map(e => edgeLine(e, kind === 'tables' ? e.label ?? e.kind : e.label)));
    }
  }
  if (lines.length > maxLines) return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join('\n');
  return lines.join('\n');
}

const MARKERS: Record<string, string> = { start: '(start)', end: '(end)', error: '(error)', decision: '<?>', loop: '<loop>', call: '[call]', action: '[ ]' };
const BRANCH_EDGE = (e: DiagramEdge) => e.kind === 'case' ? `case ${e.label}` : e.kind === 'except' ? `except ${e.label}` : e.label ?? e.kind;

/** Flowchart as an indented tree from the start node: decisions list their branches (Yes:/No:/case/except) until the
 * branches merge again (immediate post-dominator), expanded calls are indented under a "» name" header. */
function flowchartLines(nodes: DiagramNode[], edges: DiagramEdge[], groups: DiagramGroup[]): string[] {
  const byId = new Map(nodes.map(n => [n.id, n])), outgoing = new Map<string, DiagramEdge[]>();
  for (const e of edges) if (byId.has(e.from) && byId.has(e.to)) outgoing.set(e.from, [...outgoing.get(e.from) ?? [], e]);
  const parents = new Map(groups.map(g => [g.id, g.parent ?? null])), labels = new Map(groups.map(g => [g.id, g.label]));
  const depthOf = (group: string | null): number => group === null || !parents.has(group) ? 0 : 1 + depthOf(parents.get(group)!);

  // Post-dominators (iterative; nodes without successors lead to a virtual exit).
  const EXIT = '\0exit', all = new Set([...byId.keys(), EXIT]);
  const pdom = new Map<string, Set<string>>([...byId.keys()].map(id => [id, all]));
  pdom.set(EXIT, new Set([EXIT]));
  for (let changed = true, rounds = 0; changed && rounds < 1000; rounds++) {
    changed = false;
    for (const id of byId.keys()) {
      const succ = (outgoing.get(id) ?? []).map(e => pdom.get(e.to)!);
      const next = new Set([id, ...[...(succ.length ? succ : [pdom.get(EXIT)!]).reduce((a, b) => new Set([...a].filter(x => b.has(x))))]]);
      if (next.size !== pdom.get(id)!.size) { pdom.set(id, next); changed = true; }
    }
  }
  // The strict post-dominators form a chain; the immediate one is the one with the most post-dominators itself.
  const merge = (id: string) => [...pdom.get(id)!].filter(d => d !== id).reduce<string | null>((best, d) =>
    best === null || pdom.get(d)!.size > pdom.get(best)!.size ? d : best, null);

  const lines: string[] = [], printed = new Set<string>();
  const nodeText = (n: DiagramNode) => `${MARKERS[n.kind] ?? `[${n.kind}]`} ${n.label}${n.subtitle ? ` — ${n.subtitle}` : ''}${n.source ? ` · L${n.source.line}` : ''}`;
  const walk = (from: string, stop: string | null, indent: number, baseDepth: number, group: string | null) => {
    for (let id: string | null = from; id !== null && id !== stop && id !== EXIT;) {
      const n = byId.get(id)!, pad = ' '.repeat(indent + 2 * Math.max(0, depthOf(n.group) - baseDepth));
      if (printed.has(id)) { lines.push(`${pad}↻ ${n.label}`); return; }
      printed.add(id);
      if (n.group !== group && n.group !== null && depthOf(n.group) > depthOf(group))
        lines.push(`${' '.repeat(indent + 2 * Math.max(0, depthOf(n.group) - 1 - baseDepth))}» ${labels.get(n.group) ?? n.group}`);
      group = n.group;
      lines.push(pad + nodeText(n));
      const out: DiagramEdge[] = outgoing.get(id) ?? [];
      if (out.length === 1 && out[0].kind !== 'yes' && out[0].kind !== 'no') { id = out[0].to; continue; }
      if (!out.length) return;
      const join = merge(id);
      for (const e of out) {
        lines.push(`${pad}  ${BRANCH_EDGE(e)}:`);
        if (e.to === join) lines.push(`${pad}    (continue)`);
        else walk(e.to, join, pad.length + 4, depthOf(n.group), n.group);
      }
      id = join;
    }
  };
  const start = nodes.find(n => n.role === 'start' && n.kind === 'start') ?? nodes[0];
  if (start) walk(start.id, null, 2, 0, null);
  const rest = nodes.filter(n => !printed.has(n.id));
  if (rest.length) lines.push('not reached from start:', ...rest.map(n => `  ${nodeText(n)}`));
  return lines;
}

/** By `order` when any node has one (nodes without go last), else topological by edges; ties and cycles keep input order. */
function timelineOrder(nodes: DiagramNode[], edges: DiagramEdge[]): DiagramNode[] {
  if (nodes.some(n => n.order !== null)) {
    return nodes.map((n, i) => ({ n, i })).sort((a, b) =>
      (a.n.order ?? Infinity) - (b.n.order ?? Infinity) || a.i - b.i).map(x => x.n);
  }
  const ids = new Set(nodes.map(n => n.id));
  const indegree = new Map(nodes.map(n => [n.id, 0]));
  const next = new Map<string, string[]>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    indegree.set(e.to, indegree.get(e.to)! + 1);
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  }
  const result: DiagramNode[] = [], done = new Set<string>();
  for (;;) {
    // Smallest input index among ready nodes; on a cycle, the first remaining node.
    const ready = nodes.find(n => !done.has(n.id) && indegree.get(n.id) === 0) ?? nodes.find(n => !done.has(n.id));
    if (!ready) return result;
    done.add(ready.id); result.push(ready);
    for (const to of next.get(ready.id) ?? []) indegree.set(to, indegree.get(to)! - 1);
  }
}
