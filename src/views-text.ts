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

  if (kind === 'timeline') {
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
