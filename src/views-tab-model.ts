// Pure helpers of the Views tab (ViewsTab.tsx and its panels); no DOM, no API.
import type { SaveViewInput, ViewLocalState, ViewResult, ViewSummary } from '../shared/contracts/views';

/** Errors + warnings shown on the Diagnostics toggle. */
export function diagnosticCount(result: ViewResult): number {
  const d = result.diagnostics;
  return result.warnings.length + (d ? d.rules.reduce((sum, r) => sum + r.errors.length + r.warnings.length, 0) + (d.graph?.error ? 1 : 0) + (d.flowchart?.error ? 1 : 0) + (d.layers?.error ? 1 : 0) + (d.sequence?.error ? 1 : 0) : 0);
}

export const LAYER_NAMES = ['', 'services', 'modules', 'files', 'symbols'];

/** Depth slider of a flowchart (call levels 0-4), sequence (call levels 0-6) or layers view (1 services … 4 symbols): the
 * session override, else the effective depth it was computed with; null for other views (no slider). */
export function viewDepth(result: ViewResult | null, override: number | undefined): { value: number; min: number; max: number; layers: boolean } | null {
  const d = result?.diagnostics, layers = !!d?.layers;
  const computed = result?.kind === 'flowchart' ? d?.flowchart?.depth : result?.kind === 'sequence' ? d?.sequence?.depth : d?.layers?.depth;
  return computed === undefined ? null : { value: override ?? computed, min: layers ? 1 : 0, max: result?.kind === 'sequence' ? 6 : 4, layers };
}

/** The effective depth a result was computed with (flowchart, sequence or layers), e.g. to remount its diagram when it changes. */
export const computedDepth = (result: ViewResult) => result.diagnostics?.flowchart?.depth ?? result.diagnostics?.sequence?.depth ?? result.diagnostics?.layers?.depth;

/** Sequence views with a computed sequence draw as a sequence diagram; without one (an error) they show as text. */
export const isSequenceDiagram = (result: ViewResult) => result.kind === 'sequence' && !!result.sequence;

// One ELK pass over more nodes than this is slow and the result unreadable; rule views can reach 2000 nodes.
export const MAX_FLOW_NODES = 400;
const flowKind = (result: ViewResult) => result.kind === 'flow' || result.kind === 'flowchart' || result.kind === 'graph';
/** Views drawn as a flow diagram (nodes, transitions, nested frames; graph includes layers); timeline and flow views over
 * MAX_FLOW_NODES fall back to text. */
export const isFlowDiagram = (result: ViewResult) => flowKind(result) && result.nodes.length <= MAX_FLOW_NODES;

/** Why a view shows as text: a kind without a drawn diagram, too many nodes to draw, or a sequence that failed. */
export const textViewNote = (result: ViewResult) => flowKind(result)
  ? `This view has ${result.nodes.length} nodes, more than the ${MAX_FLOW_NODES} the diagram draws — here is its text form.`
  : result.kind === 'sequence' ? 'No sequence was computed — see Diagnostics.'
  : 'This view type isn\'t drawn in the app yet — here is its text form.';

/** The stored selection if it still exists, else the first view (Database). */
export function pickView(list: ViewSummary[], stored: string | null): string | null {
  return list.find(v => v.id === stored)?.id ?? list[0]?.id ?? null;
}

/** "Save as view…" input: hidden node ids become labels (what view files exclude by); positions only for shown nodes. */
export function saveViewInput(name: string, result: ViewResult, state: ViewLocalState, savePositions: boolean): SaveViewInput {
  const hidden = new Set(state.hidden), shown = new Set(result.nodes.filter(n => !hidden.has(n.id)).map(n => n.id));
  const exclude = [...new Set(result.nodes.filter(n => hidden.has(n.id)).map(n => n.label))];
  const positions = Object.fromEntries(Object.entries(state.positions).filter(([id]) => shown.has(id)));
  return { name: name.trim(), basedOn: result.id, exclude, layout: savePositions && Object.keys(positions).length ? { positions } : null };
}

/** Indexes of lines containing `query` (case-insensitive); empty for an empty query. */
export function matchingLines(lines: string[], query: string): number[] {
  const q = query.toLowerCase();
  return q ? lines.flatMap((line, i) => line.toLowerCase().includes(q) ? [i] : []) : [];
}

/** A line split into plain and matching parts, for highlighting. */
export function splitMatches(line: string, query: string): { text: string; match: boolean }[] {
  if (!query) return [{ text: line, match: false }];
  const parts: { text: string; match: boolean }[] = [], lower = line.toLowerCase(), q = query.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, at)) {
    if (i > at) parts.push({ text: line.slice(at, i), match: false });
    parts.push({ text: line.slice(i, i + q.length), match: true });
    at = i + q.length;
  }
  if (at < line.length) parts.push({ text: line.slice(at), match: false });
  return parts;
}
