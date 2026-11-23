// Pure diff between two results of the same view, for live-update flashes, fades and the toolbar note.
import type { DiagramNode, ViewResult } from '../../shared/contracts/views';

export interface ResultDiff { added: string[]; removed: DiagramNode[]; changed: string[] }

const shape = (n: DiagramNode) => JSON.stringify([n.label, n.subtitle, n.fields.map(f => [f.id, f.label, f.type, f.badges])]);

export function diffResults(prev: ViewResult, next: ViewResult): ResultDiff {
  const before = new Map(prev.nodes.map(n => [n.id, n]));
  const after = new Set(next.nodes.map(n => n.id));
  return {
    added: next.nodes.filter(n => !before.has(n.id)).map(n => n.id),
    removed: prev.nodes.filter(n => !after.has(n.id)),
    changed: next.nodes.filter(n => before.has(n.id) && shape(before.get(n.id)!) !== shape(n)).map(n => n.id),
  };
}

/** e.g. "1 table added · 2 tables changed"; empty when nothing differs. */
export function describeDiff(d: ResultDiff): string {
  const part = (count: number, verb: string) => count ? `${count} table${count === 1 ? '' : 's'} ${verb}` : null;
  return [part(d.added.length, 'added'), part(d.removed.length, 'removed'), part(d.changed.length, 'changed')].filter(Boolean).join(' · ');
}
