import type { GraphApi, GraphSymbol } from './types';

/** Direct `calls` targets per source id (heuristic relations included), de-duplicated, in-repo symbols only. */
export function calleesOf(graph: GraphApi, ids: string[]): Map<string, GraphSymbol[]> {
  const targets = new Map<string, Set<string>>(ids.map(id => [id, new Set()]));
  const relations = ids.length ? graph.outgoing(ids, ['calls']) : [];
  for (const r of relations) targets.get(r.from)?.add(r.to);
  const symbols = graph.symbols([...new Set(relations.map(r => r.to))]);
  return new Map([...targets].map(([id, to]) => [id, [...to].flatMap(t => symbols.get(t) ?? [])
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)]));
}
