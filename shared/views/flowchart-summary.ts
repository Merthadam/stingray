// Summary of a flowchart (docs/flowchart-drilldown-plan.md, phase 3): what a reader who did not write the code needs.
// Shared by the Views tab and the `stingray-views` CLI. Pure and deterministic.
//  - guards fold: an undescribed decision whose one branch only ends in an error becomes a "can fail" badge on the step
//    before it (else the step after it), a step of the same function;
//  - undescribed library steps (`action` nodes without an explanation) are dropped, their edges bridged;
//  - decisions and loops left with a single way out (every branch reaches the same step) are dropped.
// Nodes inside groups listed in `allStepsIn` (or below them) are kept as they are; `allSteps` returns the result unchanged.
import type { DiagramEdge, DiagramGroup, DiagramNode, NodeFailure, ViewKind } from '../contracts/views';

export interface SummaryInput { kind: ViewKind; nodes: DiagramNode[]; edges: DiagramEdge[]; groups: DiagramGroup[] }
export interface SummaryOptions { allSteps?: boolean; allStepsIn?: Iterable<string> }
export interface FlowchartSummary<T extends SummaryInput> {
  result: T; hidden: number; folded: number;
  touched: string[];          // groups (and their ancestors) where steps were hidden or folded: "show all steps" applies
}

const MAX_ROUNDS = 20;

export function summarizeFlowchart<T extends SummaryInput>(input: T, opts: SummaryOptions = {}): FlowchartSummary<T> {
  if (input.kind !== 'flowchart' || opts.allSteps) return { result: input, hidden: 0, folded: 0, touched: [] };
  const parents = new Map(input.groups.map(g => [g.id, g.parent ?? null]));
  const full = new Set(opts.allStepsIn ?? []);
  const inFull = (group: string | null): boolean => {
    for (let g = group, guard = 0; g !== null && guard < 50; g = parents.get(g) ?? null, guard++) if (full.has(g)) return true;
    return false;
  };
  const nodes = new Map(input.nodes.map(n => [n.id, { ...n }]));
  let edges = [...input.edges];
  const ids = new Set(edges.map(e => e.id));
  const uniqueId = (base: string) => { let id = base; for (let i = 2; ids.has(id); i++) id = `${base}#${i}`; ids.add(id); return id; };
  const keep = (n: DiagramNode) => !!n.explanation || inFull(n.group);
  const into = (id: string) => edges.filter(e => e.to === id);
  const out = (id: string) => edges.filter(e => e.from === id);
  let hidden = 0, folded = 0;
  const touched = new Set<string>();
  const touch = (group: string | null) => { for (let g = group, guard = 0; g !== null && guard < 50; g = parents.get(g) ?? null, guard++) touched.add(g); };

  /** Drop `id`, joining each incoming edge to each target: the incoming edge's kind and label; dashed if either was. */
  const bridge = (id: string, targets: DiagramEdge[]) => {
    const ins = into(id).filter(e => e.from !== id);
    edges = edges.filter(e => e.from !== id && e.to !== id);
    for (const a of ins) for (const b of targets) {
      if (b.to === id) continue;
      const kind = b.kind === 'loop' ? 'loop' : a.kind, certain = a.certain && b.certain;
      if (edges.some(e => e.from === a.from && e.to === b.to && e.kind === kind && e.label === a.label)) continue;
      edges.push({ ...a, id: uniqueId(`${kind}:${a.from}->${b.to}`), to: b.to, kind, certain, style: certain ? a.style : 'dashed' });
    }
    touch(nodes.get(id)?.group ?? null);
    nodes.delete(id);
  };

  for (let round = 0, changed = true; changed && round < MAX_ROUNDS; round++) {
    changed = false;
    // Guards: decision D -> (error E | T), E reached only from D.
    for (const d of [...nodes.values()]) {
      if (d.kind !== 'decision' || keep(d)) continue;
      const branches = out(d.id);
      if (branches.length !== 2) continue;
      const toError = branches.find(e => nodes.get(e.to)?.kind === 'error' && into(e.to).length === 1 && !out(e.to).length);
      const onward = branches.find(e => e !== toError);
      if (!toError || !onward || onward.to === d.id) continue;
      const err = nodes.get(toError.to)!, ins = into(d.id);
      const pred = ins.length === 1 ? nodes.get(ins[0].from) : undefined;
      const next = nodes.get(onward.to)!;
      // The badge stays in the guard's function: a guard first in an expanded callee does not go on the caller's step.
      const hosts = (x: DiagramNode | undefined): x is DiagramNode => !!x && (x.kind === 'action' || x.kind === 'call') && x.group === d.group;
      const host = hosts(pred) ? pred : hosts(next) ? next : null;
      if (!host) continue;
      const failure: NodeFailure = { label: err.label, condition: toError.label && toError.label !== 'Yes' ? `${d.label} (${toError.label})` : d.label, source: err.source };
      host.failures = [...host.failures ?? [], failure];
      edges = edges.filter(e => e !== toError);
      touch(err.group);
      nodes.delete(err.id);
      bridge(d.id, [onward]);
      folded++; changed = true;
    }
    // Undescribed library steps (a step that can fail stays: its badge says something).
    for (const a of [...nodes.values()]) {
      if (a.kind !== 'action' || keep(a) || a.failures?.length) continue;
      bridge(a.id, out(a.id));
      hidden++; changed = true;
    }
    // Decisions and loops with one way out.
    for (const d of [...nodes.values()]) {
      if ((d.kind !== 'decision' && d.kind !== 'loop') || keep(d)) continue;
      const exits = out(d.id).filter(e => e.to !== d.id);
      if (!exits.length || new Set(exits.map(e => e.to)).size !== 1) continue;
      bridge(d.id, [{ ...exits[0], kind: 'next', label: null, certain: exits.every(e => e.certain) }]);
      hidden++; changed = true;
    }
  }
  if (!hidden && !folded) return { result: input, hidden, folded, touched: [] };

  // Groups left without nodes (in them or below them) go too.
  const used = new Set<string>();
  for (const n of nodes.values()) for (let g = n.group, guard = 0; g !== null && guard < 50 && !used.has(g); g = parents.get(g) ?? null, guard++) used.add(g);
  const order = new Map(input.edges.map((e, i) => [e.id, i]));
  const rank = new Map(input.nodes.map((n, i) => [n.id, i]));
  edges.sort((a, b) => (rank.get(a.from)! - rank.get(b.from)!) || ((order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9)));
  return {
    result: { ...input, nodes: input.nodes.filter(n => nodes.has(n.id)).map(n => nodes.get(n.id)!), edges, groups: input.groups.filter(g => used.has(g.id)) },
    hidden, folded, touched: input.groups.map(g => g.id).filter(g => touched.has(g)),
  };
}
