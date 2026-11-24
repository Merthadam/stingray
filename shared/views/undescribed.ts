// Which nodes a reader needs described (a docstring or an `explain:` entry), per view kind: the Views tab marks them and
// `stingray-views check` lists them as a to-do. Services, modules, files, infra and tables are left out: their name is
// their meaning.
import type { DiagramNode, ViewKind } from '../contracts/views';

const FLOWCHART_STEPS = new Set(['decision', 'loop', 'call', 'action']);
const NAMED = new Set(['service', 'module', 'file', 'table']); // layers units and tables

/** Flowchart decisions, loops, calls and actions; graph and flow views' steps backed by a symbol (graph steps, layers
 * symbols, rule nodes with `symbol:`) and every flow step; not start/end pills, cloud resources or tables. */
export function describable(node: DiagramNode, kind: ViewKind): boolean {
  if (kind === 'flowchart') return FLOWCHART_STEPS.has(node.kind);
  if (kind !== 'graph' && kind !== 'flow') return false;
  return !node.role && !node.service && !NAMED.has(node.kind) && (kind === 'flow' || !!node.symbol);
}

/** A describable node without an explanation. */
export const undescribed = (node: DiagramNode, kind: ViewKind) => !node.explanation && describable(node, kind);
