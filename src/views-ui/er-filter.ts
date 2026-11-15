// Pure filters for the ER diagram's hidden set.
import type { ViewResult } from '../views';

export function adjacency(result: ViewResult): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>(result.nodes.map(n => [n.id, new Set()]));
  for (const e of result.edges) { adj.get(e.from)?.add(e.to); adj.get(e.to)?.add(e.from); }
  return adj;
}

/** `id` plus every node within `hops` edges (either direction), over the full result. */
export function neighbours(result: ViewResult, id: string, hops: number): Set<string> {
  const adj = adjacency(result);
  const seen = new Set([id]);
  let frontier = [id];
  for (let i = 0; i < hops; i++) {
    const next: string[] = [];
    for (const n of frontier) for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); next.push(m); }
    frontier = next;
  }
  return seen;
}

/** Hidden set for "Only this + neighbours": everything outside the neighbourhood. */
export function onlyNeighbours(result: ViewResult, id: string, hops: number): string[] {
  const keep = neighbours(result, id, hops);
  return result.nodes.filter(n => !keep.has(n.id)).map(n => n.id);
}

/** Hidden set for "Hide tables without relations": visible nodes with no edge to another visible node are added. */
export function hideIsolated(result: ViewResult, hidden: string[]): string[] {
  const h = new Set(hidden);
  const linked = new Set<string>();
  for (const e of result.edges) {
    if (e.from !== e.to && !h.has(e.from) && !h.has(e.to)) { linked.add(e.from); linked.add(e.to); }
  }
  return [...hidden, ...result.nodes.filter(n => !h.has(n.id) && !linked.has(n.id)).map(n => n.id)];
}
