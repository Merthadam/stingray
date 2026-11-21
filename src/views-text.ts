// Plain-text rendering of a diagram, shared by the `stingray-views` CLI (agents read it to check a view) and the Views tab. Pure and deterministic.
import type { DiagramEdge, DiagramField, DiagramGroup, DiagramNode, ExplanationStatus, SequenceData, ViewKind } from './views';

export interface TextDiagramInput {
  kind: ViewKind; groups: DiagramGroup[]; nodes: DiagramNode[]; edges: DiagramEdge[]; truncated: boolean;
  sequence?: SequenceData | null; // kind: sequence
}
export const MAX_TEXT_LINES = 400;

export function formatText({ kind, groups, nodes, edges, truncated, sequence }: TextDiagramInput, maxLines = MAX_TEXT_LINES): string {
  if (kind === 'sequence') {
    const lines = sequence ? sequenceLines(sequence, truncated) : [`sequence: not computed${truncated ? ' (truncated: a limit was hit)' : ''}`];
    return (lines.length > maxLines ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`] : lines).join('\n');
  }
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
    `  ${n.role ? `[${n.role}] ` : ''}${name(n.id)}${n.kind && kind !== 'tables' ? ` (${n.kind})` : ''}${n.subtitle ? ` — ${n.subtitle}` : ''}${n.detail ? ` · ${n.detail}` : ''}${explained(n)}`;

  const lines = [`${kind}: ${nodes.length} nodes, ${edges.length} edges${truncated ? ' (truncated: a limit was hit)' : ''}`];
  const byGroups = () => {
    const known = new Map(groups.map(g => [g.id, g]));
    // Nested groups (layers: service > module > file) are named by their path.
    const title = (g: DiagramGroup, seen = new Set<string>()): string => {
      const parent = g.parent ? known.get(g.parent) : undefined;
      return parent && !seen.has(parent.id) ? `${title(parent, seen.add(g.id))} / ${g.label}` : g.label;
    };
    const sections: [string | null, DiagramNode[]][] = [[null, nodes.filter(n => n.group === null || !known.has(n.group))],
      ...groups.map(g => [title(g), nodes.filter(n => n.group === g.id)] as [string, DiagramNode[]])];
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

/** " — <explanation>" (a symbol's docstring summary or the view's `explain:` text, cut at TEXT_EXPLANATION chars, marked when its
 * code changed since) or nothing. */
const TEXT_EXPLANATION = 300;
const explained = ({ explanation: x, explanationStatus }: { explanation?: string | null; explanationStatus?: ExplanationStatus }) =>
  !x ? '' : ` — ${x.length > TEXT_EXPLANATION ? `${x.slice(0, TEXT_EXPLANATION - 1).trimEnd()}…` : x}${explanationStatus === 'stale' ? ' (may be outdated)' : ''}`;
const MARKERS: Record<string, string> = { start: '(start)', end: '(end)', error: '(error)', decision: '<?>', loop: '<loop>', call: '[call]', action: '[ ]' };
const BRANCH_EDGE = (e: DiagramEdge) => e.kind === 'case' ? `case ${e.label}` : e.kind === 'except' ? `except ${e.label}` : e.label ?? e.kind;

/** Flowchart as an indented tree from the start node: decisions list their branches (Yes:/No:/case/except) until the
 * branches merge again (immediate post-dominator; "→ x" = the branch goes straight to x), "↻ x" = back to x drawn
 * above (loops), expanded calls are indented under a "» name" header. */
function flowchartLines(nodes: DiagramNode[], edges: DiagramEdge[], groups: DiagramGroup[]): string[] {
  const byId = new Map(nodes.map(n => [n.id, n])), outgoing = new Map<string, DiagramEdge[]>();
  for (const e of edges) if (byId.has(e.from) && byId.has(e.to)) outgoing.set(e.from, [...outgoing.get(e.from) ?? [], e]);
  const parents = new Map(groups.map(g => [g.id, g.parent ?? null])), groupsById = new Map(groups.map(g => [g.id, g]));
  const depthOf = (group: string | null): number => group === null || !parents.has(group) ? 0 : 1 + depthOf(parents.get(group)!);
  const within = (group: string | null, ancestor: string): boolean => group !== null && (group === ancestor || within(parents.get(group) ?? null, ancestor));

  // Post-dominators (iterative). Only the main end (the last `end`, where the function finishes) and dangling nodes lead
  // to the exit; other ends and errors post-dominate everything, so a branch that stops early (guard clause) does not
  // prevent its siblings from merging.
  const EXIT = '\0exit', all = new Set([...byId.keys(), EXIT]);
  const mainEnd = [...nodes].reverse().find(n => n.kind === 'end')?.id;
  const stops = new Set(nodes.filter(n => (n.kind === 'end' || n.kind === 'error') && n.id !== mainEnd && !outgoing.has(n.id)).map(n => n.id));
  const pdom = new Map<string, Set<string>>([...byId.keys()].map(id => [id, all]));
  pdom.set(EXIT, new Set([EXIT]));
  for (let changed = true, rounds = 0; changed && rounds < 1000; rounds++) {
    changed = false;
    for (const id of byId.keys()) {
      if (stops.has(id)) continue;
      const succ = (outgoing.get(id) ?? []).map(e => pdom.get(e.to)!);
      const next = new Set([id, ...[...(succ.length ? succ : [pdom.get(EXIT)!]).reduce((a, b) => new Set([...a].filter(x => b.has(x))))]]);
      if (next.size !== pdom.get(id)!.size) { pdom.set(id, next); changed = true; }
    }
  }
  // The strict post-dominators form a chain; the immediate one is the one with the most post-dominators itself.
  const merge = (id: string) => pdom.get(id)!.size === all.size ? null : [...pdom.get(id)!].filter(d => d !== id).reduce<string | null>((best, d) =>
    best === null || pdom.get(d)!.size > pdom.get(best)!.size ? d : best, null);

  const lines: string[] = [], printed = new Set<string>();
  // Reached through a heuristic code-graph call (dashed in the diagram): a call node, or the first step of an expanded callee.
  const uncertain = new Set(edges.filter(e => !e.certain).map(e => e.to));
  const nodeText = (n: DiagramNode) => `${MARKERS[n.kind] ?? `[${n.kind}]`} ${n.label}${n.subtitle ? ` — ${n.subtitle}` : ''}`
    + `${n.kind === 'call' && uncertain.has(n.id) ? ' (uncertain)' : ''}${n.source ? ` · L${n.source.line}` : ''}${explained(n)}`;
  const walk = (from: string, stop: string | null, indent: number, baseDepth: number, group: string | null) => {
    for (let id: string | null = from; id !== null && id !== stop && id !== EXIT;) {
      const n = byId.get(id)!;
      if (printed.has(id)) { lines.push(`${' '.repeat(indent + 2 * Math.max(0, depthOf(n.group) - baseDepth))}↻ ${n.label}`); return; }
      printed.add(id);
      // Headers for each group entered (a sibling or nested callee), not for returning to an enclosing one. A group
      // shallower than this branch's own lowers the base, so its steps still indent under its header.
      const entered: string[] = [];
      for (let g: string | null = n.group; g !== null && !within(group, g); g = parents.get(g) ?? null) entered.unshift(g);
      if (entered.length) baseDepth = Math.min(baseDepth, depthOf(entered[0]) - 1);
      // shortcut: an uncertain call marks the outermost callee entered, even when it is a nested callee's call that is uncertain.
      for (const g of entered) lines.push(`${' '.repeat(indent + 2 * Math.max(0, depthOf(g) - 1 - baseDepth))}» ${groupsById.get(g)?.label ?? g}${g === entered[0] && uncertain.has(id) ? ' (uncertain)' : ''}${explained(groupsById.get(g) ?? {})}`);
      group = n.group;
      const pad = ' '.repeat(indent + 2 * Math.max(0, depthOf(n.group) - baseDepth));
      lines.push(pad + nodeText(n));
      const out: DiagramEdge[] = outgoing.get(id) ?? [];
      if (out.length === 1 && out[0].kind !== 'yes' && out[0].kind !== 'no') { id = out[0].to; continue; }
      if (!out.length) return;
      const join = merge(id);
      for (const e of out) {
        lines.push(`${pad}  ${BRANCH_EDGE(e)}:`);
        if (e.to === join) lines.push(`${pad}    → ${byId.get(join)!.label}`);
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

/** Sequence as arrows in row order (docs/sequence-view-spec.md §CLI text): indent = call level plus enclosing fragments,
 * `-->` = return, fragments open with `alt|opt|loop|try <label>`, later arms with `else <label>`, close with `end`. */
function sequenceLines({ participants, messages, fragments, notes }: SequenceData, truncated: boolean): string[] {
  const name = (id: string) => participants.find(p => p.id === id)?.label ?? id;
  const lines = [`sequence: ${participants.length} participants, ${messages.length} messages${truncated ? ' (truncated: a limit was hit)' : ''}`,
    `participants: ${participants.map(p => p.kind === 'participant' ? p.label : `${p.label} (${p.kind})`).join(', ')}`];
  let level = 0; // of the last message printed: notes indent like it
  // Rows [from, to] of one fragment arm (or the whole diagram): its messages, child fragments and notes in row order.
  const range = (from: number, to: number, parent: string | null, arm: number | null, nesting: number) => {
    const children = fragments.filter(f => f.parent === parent && f.first >= from && f.first <= to);
    const items: [number, () => void][] = [
      ...children.map((f): [number, () => void] => [f.first - 0.5, () => fragment(f, nesting)]),
      ...notes.filter(n => (n.fragment ?? null) === parent && (parent === null || n.arm === arm) && (n.after >= from - 1 && n.after <= to || parent !== null))
        .map((n): [number, () => void] => [n.after + 0.25, () => lines.push(`${'  '.repeat(level + nesting)}note ${name(n.participant)}: ${n.text}`)]),
    ];
    for (let row = from; row <= to; row++) {
      if (children.some(f => row >= f.first && row <= f.last)) continue;
      const m = messages[row];
      items.push([row, () => {
        level = m.level;
        lines.push(`${'  '.repeat(m.level + nesting)}${name(m.from)} ${m.kind === 'return' ? '-->' : '->'} ${name(m.to)}: ${m.label}`
          + `${m.kind === 'link' && m.link ? `  [link ${m.link}]` : ''}${m.certain ? '' : '  (uncertain)'}`);
      }]);
    }
    items.sort((a, b) => a[0] - b[0]).forEach(([, print]) => print());
  };
  const fragment = (f: SequenceData['fragments'][number], nesting: number) => {
    const indent = '  '.repeat((messages[f.first]?.level ?? level) + nesting);
    const arms = [{ label: f.label, first: f.first }, ...f.branches];
    lines.push(`${indent}${f.kind}${f.label !== f.kind ? ` ${f.label}` : ''}`);
    arms.forEach((a, i) => {
      if (i) lines.push(`${indent}else${a.label !== 'else' ? ` ${a.label}` : ''}`);
      range(a.first, Math.min(f.last, (arms[i + 1]?.first ?? f.last + 1) - 1), f.id, i, nesting + 1);
    });
    lines.push(`${indent}end`);
  };
  range(0, messages.length - 1, null, null, 0);
  return lines;
}
