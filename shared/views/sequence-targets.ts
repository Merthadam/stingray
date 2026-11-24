// `explain:` targets of a sequence view besides its participants (which are the result's nodes): every message into a repo
// function but the trigger (keyed like a call: the callee's symbol name) and every alt/opt/loop condition (keyed like a flowchart
// decision: a snippet of its code). They are built from the sequence data when needed, so the explain pipeline
// (matching, fingerprints, "Describe…", `check`'s to-do) works on them like on nodes, and written back afterwards.
import type { DiagramNode, SequenceData, ViewResult } from '../contracts/views';

const CONDITIONS = new Set(['alt', 'opt', 'loop']);
export const messageTarget = (id: string) => `msg:${id}`;
export const conditionTarget = (id: string) => `cond:${id}`;

const target = (id: string, extra: Partial<DiagramNode>): DiagramNode => ({ id, label: '', kind: 'message', subtitle: null, group: null, fields: [],
  source: null, symbol: null, role: null, order: null, detail: null, ...extra });

/** Messages with a callee symbol (kind `message`) and fragments with a condition (kind `decision`, its code as `detail`),
 * carrying their current explanation. Pure. */
export function sequenceTargets(sequence: SequenceData): DiagramNode[] {
  const own = (t: { explanation?: string | null; explanationStatus?: DiagramNode['explanationStatus']; explanationReason?: string }) =>
    ({ explanation: t.explanation, explanationStatus: t.explanationStatus, explanationReason: t.explanationReason });
  return [
    // Not the trigger (actor -> entry): its label is the view's own words.
    ...sequence.messages.filter(m => m.symbol && m.kind !== 'return' && m.from !== 'actor').map(m =>
      target(messageTarget(m.id), { label: m.label, detail: m.detail, symbol: m.symbol, source: m.source, ...own(m) })),
    ...sequence.fragments.filter(f => CONDITIONS.has(f.kind) && f.detail).map(f =>
      target(conditionTarget(f.id), { label: f.label, kind: 'decision', detail: f.detail, source: f.source, ...own(f) })),
  ];
}

/** The result with its sequence targets appended to its nodes (what `explain:` keys match); other views as they are. Pure. */
export const explainable = <T extends Pick<ViewResult, 'nodes' | 'sequence'>>(result: T): T =>
  result.sequence ? { ...result, nodes: [...result.nodes, ...sequenceTargets(result.sequence)] } : result;

/** The sequence with the explanations of its participants' nodes and of `targets` (sequenceTargets after `explain:` was
 * applied) written back. A message keeps its docstring summary unless an entry replaced it. Pure. */
export function withSequenceExplanations(sequence: SequenceData, nodes: DiagramNode[], targets: DiagramNode[]): SequenceData {
  const byId = new Map([...nodes, ...targets].map(n => [n.id, n]));
  const own = (n: DiagramNode | undefined) => n?.explanationStatus
    ? { explanation: n.explanation, explanationStatus: n.explanationStatus, ...(n.explanationReason ? { explanationReason: n.explanationReason } : {}) } : {};
  return {
    ...sequence,
    participants: sequence.participants.map(p => { const n = byId.get(p.id); return n?.explanation ? { ...p, explanation: n.explanation } : p; }),
    messages: sequence.messages.map(m => ({ ...m, ...own(byId.get(messageTarget(m.id))) })),
    fragments: sequence.fragments.map(f => ({ ...f, ...own(byId.get(conditionTarget(f.id))) })),
  };
}
