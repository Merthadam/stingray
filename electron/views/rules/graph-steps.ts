// Graph steps (m3-design.md "Graph steps"): expand start symbols through the code graph into nodes and edges. Pure.
import path from 'node:path';
import type { DiagramEdge, DiagramField, DiagramNode } from '../../../src/views';
import { explanationOf } from '../explanation';
import type { FollowKind, GraphRelation, GraphSymbol, RunGraphStep } from './types';

export const MAX_GRAPH_NODES = 150;
const EDGE_KINDS: Record<FollowKind, string[]> = {
  calls: ['calls'], imports: ['imports'], inherits: ['extends', 'implements'], references: ['references', 'instantiates'],
};
const FOLLOW_OF = new Map(Object.entries(EDGE_KINDS).flatMap(([follow, kinds]) => kinds.map(kind => [kind, follow as FollowKind])));
const nodeId = (symbol: GraphSymbol) => 'sym:' + symbol.id;
const at = (s: GraphSymbol) => `${s.file}:${s.line}`;

export const runGraphStep: RunGraphStep = (step, graph, inScope) => {
  const matches = (file: string, globs: string[]) => globs.some(g => path.posix.matchesGlob(file, g));
  const excluded = (s: GraphSymbol) => matches(s.file, step.exclude ?? []);
  const included = (s: GraphSymbol) => (step.include ? matches(s.file, step.include) : inScope(s.file));

  const errors: string[] = [], starts: GraphSymbol[] = [];
  for (const { symbol, file } of step.start) {
    const found = graph.findSymbols(symbol, file);
    if (!found.length) errors.push(`start symbol not found: ${symbol}${file ? ` in ${file}` : ''}`);
    else if (!file && found.length > 1) errors.push(`ambiguous start symbol ${symbol}: add a file (${found.map(at).join(', ')})`);
    else starts.push(...found);
  }

  // BFS for discovery; nodes outside `include` are reached but not expanded, excluded ones are never reached.
  const kinds = step.follow.flatMap(f => EDGE_KINDS[f]);
  const reached = new Map<string, GraphSymbol>(), seen = new Set<string>();
  let truncated = false;
  const add = (s: GraphSymbol) => {
    if (reached.has(s.id) || excluded(s)) return false;
    seen.add(s.id);
    if (reached.size >= MAX_GRAPH_NODES) { truncated = true; return false; }
    reached.set(s.id, s); return true;
  };
  let frontier = starts.filter(add);
  for (let depth = 0; depth < step.depth && frontier.length && !truncated; depth++) {
    const ids = frontier.filter(included).map(s => s.id), order = new Map(ids.map((id, i) => [id, i]));
    const next: string[] = [];
    const visit = (relations: GraphRelation[], near: 'from' | 'to') => relations
      .map(r => ({ r, rank: order.get(r[near]) ?? Infinity }))
      .sort((a, b) => a.rank - b.rank || (a.r.line ?? 0) - (b.r.line ?? 0))
      .forEach(({ r }) => next.push(near === 'from' ? r.to : r.from));
    if (step.direction !== 'in') visit(graph.outgoing(ids, kinds), 'from');
    if (step.direction !== 'out') visit(graph.incoming(ids, kinds), 'to');
    const unknown = [...new Set(next)].filter(id => !reached.has(id));
    const symbols = graph.symbols(unknown);
    frontier = unknown.map(id => symbols.get(id)).filter((s): s is GraphSymbol => !!s && add(s));
  }

  // All followed relations between reached symbols, deduped per (kind, from, to); certain if any site is certain.
  const edges = new Map<string, DiagramEdge>();
  for (const r of graph.outgoing([...reached.keys()], kinds)) {
    const from = reached.get(r.from), to = reached.get(r.to), follow = FOLLOW_OF.get(r.kind);
    if (!from || !to || !follow || from === to) continue;
    const id = `${follow}:${nodeId(from)}->${nodeId(to)}`, edge = edges.get(id);
    if (edge) { if (r.certain && !edge.certain) Object.assign(edge, { certain: true, style: 'solid' }); continue; }
    edges.set(id, { id, from: nodeId(from), to: nodeId(to), fromField: null, toField: null, kind: follow,
      style: r.certain ? 'solid' : 'dashed', certain: r.certain, label: null, source: r.line === null ? null : { file: from.file, line: r.line } });
  }

  const startIds = new Set(starts.map(s => s.id));
  const into = (id: string) => [...edges.values()].filter(e => e.to === id);
  const helpers = new Set([...reached.values()].filter(s => !startIds.has(s.id) && (!included(s) ||
    ((s.kind === 'function' || s.kind === 'method') && new Set(into(nodeId(s)).map(e => e.from)).size >= 2 && ![...edges.values()].some(e => e.from === nodeId(s))))).map(nodeId));

  const nodes = new Map<string, DiagramNode>([...reached.values()].map(s => [nodeId(s), {
    id: nodeId(s), label: s.name, kind: s.kind, subtitle: null, group: null, fields: [], source: { file: s.file, line: s.line },
    symbol: { id: s.id, name: s.name, kind: s.kind, file: s.file, line: s.line }, role: null, order: null, detail: null, ...explanationOf(s),
  }]));
  if (step.helpers !== 'show') {
    for (const id of helpers) {
      const helper = nodes.get(id)!;
      if (step.helpers === 'collapse') for (const e of into(id)) {
        const caller = nodes.get(e.from), field: DiagramField = { id: 'helper:' + helper.label, label: helper.label, type: null, badges: [], detail: 'helper', source: helper.source };
        if (caller && !helpers.has(caller.id) && !caller.fields.some(f => f.id === field.id)) caller.fields.push(field);
      }
    }
    for (const id of helpers) nodes.delete(id);
  }
  const rank = new Map([...reached.values()].map((s, i) => [nodeId(s), i]));
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].filter(e => nodes.has(e.from) && nodes.has(e.to))
      .sort((x, y) => rank.get(x.from)! - rank.get(y.from)! || rank.get(x.to)! - rank.get(y.to)! || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0)),
    diagnostic: { started: starts.length, reached: seen.size, helpers: helpers.size, truncated, error: errors.length ? errors.join('; ') : null },
    truncated,
  };
};
