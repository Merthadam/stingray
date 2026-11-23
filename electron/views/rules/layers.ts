// Layers step (`layers:` of a kind: graph view): stinggraph's service layers as a drill-down hierarchy. Services (L1),
// modules (L2), files (L3) and top-level symbols (L4) are nodes down to `depth`, the levels above them nested groups;
// edges between files roll up to the drawn nodes and are labelled with their counts. Pure.
import path from 'node:path';
import type { DiagramEdge, DiagramGroup, DiagramNode, LayersDiagnostic, ViewWarning } from '../../../shared/contracts/views';
import type { GraphApi, GraphRelation, GraphRollupEdge, GraphSymbol, LayersStep } from './types';
import { symbolRef } from '../explanation';

/** The edge kinds stinggraph's roll-up counts (ROLLUP_EDGE_KINDS), used for symbol-level edges too. */
const ROLLUP_KINDS = ['calls', 'references', 'imports', 'instantiates', 'extends', 'implements'];
const UNASSIGNED = '(unassigned)'; // stinggraph's UNASSIGNED

export interface LayersOutput {
  groups: DiagramGroup[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  warnings: ViewWarning[];
  diagnostic: LayersDiagnostic;
}

const serviceId = (service: string) => `service:${service}`;
const moduleId = (service: string, module: string) => `module:${service}/${module}`;
const fileId = (file: string) => `file:${file}`;
const symbolId = (s: GraphSymbol) => `sym:${s.id}`;
const node = (id: string, label: string, kind: string, extra: Partial<DiagramNode> = {}): DiagramNode =>
  ({ id, label, kind, subtitle: null, group: null, fields: [], source: null, symbol: null, role: null, order: null, detail: null, ...extra });
const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

export function runLayers(step: LayersStep, graph: GraphApi, inScope: (file: string) => boolean): LayersOutput {
  const layers = graph.layers();
  if (!layers) return { groups: [], nodes: [], edges: [], warnings: [],
    diagnostic: { config: null, depth: step.depth, services: 0, files: 0, nodes: 0, error: 'service layers could not be computed' } };
  const warnings = layers.errors.map(e => ({ file: e.source, line: null, message: `layers: ${e.message}` }));
  const services = new Map(layers.services.map(s => [s.id, s]));
  const expand = new Set(step.expand ?? []);
  const depthOf = (service: string) => !expand.size || expand.has(service) || expand.has(services.get(service)?.label ?? service) ? step.depth : 1;

  // Inferred layers (no layers.yaml) leave only tests, scripts, docs and root files unassigned: not part of the picture,
  // unless nothing else was found. A declared config's unassigned files stay visible (they were left out on purpose).
  const hideUnassigned = !layers.config && layers.services.some(s => s.id !== UNASSIGNED);
  const scoped = Object.entries(layers.assignments)
    .filter(([file, a]) => inScope(file) && !(hideUnassigned && a.service === UNASSIGNED)).sort(([a], [b]) => a.localeCompare(b));
  const groups = new Map<string, DiagramGroup>(), nodes = new Map<string, DiagramNode>(), counts = new Map<string, number>();
  const units: Record<string, string> = {}, symbolFiles: string[] = [];
  for (const [file] of scoped) {
    const { service, module } = layers.assignments[file], depth = depthOf(service);
    const sid = serviceId(service), mid = moduleId(service, module);
    const serviceLabel = services.get(service)?.label ?? service;
    const moduleLabel = services.get(service)?.modules.find(m => m.id === module)?.label ?? module;
    for (const id of [sid, mid]) counts.set(id, (counts.get(id) ?? 0) + 1);
    if (depth === 1) { nodes.set(sid, node(sid, serviceLabel, 'service', { detail: services.get(service)?.aliases.join(', ') || null })); units[file] = sid; continue; }
    if (!groups.has(sid)) groups.set(sid, { id: sid, label: serviceLabel, source: null, parent: null });
    if (depth === 2) { nodes.set(mid, node(mid, moduleLabel, 'module', { group: sid })); units[file] = mid; continue; }
    if (!groups.has(mid)) groups.set(mid, { id: mid, label: moduleLabel, source: null, parent: sid });
    const dir = path.posix.dirname(file);
    nodes.set(fileId(file), node(fileId(file), path.posix.basename(file), 'file', { group: mid, subtitle: dir === '.' ? null : dir, source: { file, line: 1 } }));
    if (depth === 3) units[file] = fileId(file);
    else symbolFiles.push(file);
  }
  for (const n of nodes.values()) if (n.kind === 'service' || n.kind === 'module') n.subtitle = files(counts.get(n.id)!);

  // Symbol level: a file's top-level symbols (children of its file node) replace it; members count as their symbol.
  const perFile = new Map(symbolFiles.map(f => [f, graph.fileSymbols(f)]));
  const all = [...perFile.values()].flat(), byId = new Map(all.map(s => [s.id, s]));
  const parents = new Map(all.length ? graph.incoming(all.map(s => s.id), ['contains']).map(r => [r.to, r.from]) : []);
  for (const [file, symbols] of perFile) {
    const fileNode = symbols.find(s => s.kind === 'file');
    const children = symbols.filter(s => s.kind !== 'file' && s.kind !== 'import' && parents.get(s.id) === fileNode?.id);
    const fid = fileId(file), drawn = nodes.get(fid)!;
    if (!children.length) { units[file] = fid; continue; } // e.g. a config file: stays a file node
    nodes.delete(fid);
    groups.set(fid, { id: fid, label: drawn.label, source: { file, line: 1 }, parent: drawn.group });
    for (const s of children) nodes.set(symbolId(s), node(symbolId(s), s.name, s.kind, { group: fid, source: { file: s.file, line: s.line },
      symbol: symbolRef(s) }));
  }

  const rolled: GraphRollupEdge[] = graph.rollup(units);
  if (all.length) {
    const top = new Map<string, string | undefined>(); // node id of a symbol file -> its drawn top-level symbol
    const topOf = (id: string): string | undefined => {
      if (!top.has(id)) {
        const s = byId.get(id);
        top.set(id, !s || s.kind === 'file' ? undefined : nodes.has(symbolId(s)) ? symbolId(s) : parents.has(id) ? topOf(parents.get(id)!) : undefined);
      }
      return top.get(id);
    };
    // All outgoing relations of symbol files, plus incoming ones from elsewhere (between two symbol files they are outgoing too).
    const ids = all.map(s => s.id);
    const relations: GraphRelation[] = [...graph.outgoing(ids, ROLLUP_KINDS), ...graph.incoming(ids, ROLLUP_KINDS).filter(r => !byId.has(r.from))];
    const others = graph.symbols([...new Set(relations.flatMap(r => [r.from, r.to]).filter(id => !byId.has(id)))]);
    // Other ends roll up to their file's unit. Module-level code and imports of a symbol file belong to no symbol: left out.
    const end = (id: string) => byId.has(id) ? topOf(id) : units[others.get(id)?.file ?? ''];
    const pairs = new Map<string, GraphRollupEdge>();
    for (const r of relations) {
      const from = end(r.from), to = end(r.to);
      if (!from || !to || from === to) continue;
      const key = `${from}\0${to}`, pair = pairs.get(key) ?? { from, to, total: 0, synthesized: 0, byKind: {} };
      pair.total++; pair.byKind[r.kind] = (pair.byKind[r.kind] ?? 0) + 1;
      if (!r.certain) pair.synthesized++; // heuristic resolution: as unsure as an inferred cross-service edge
      pairs.set(key, pair);
    }
    rolled.push(...pairs.values());
  }

  return {
    groups: [...groups.values()], nodes: [...nodes.values()], warnings,
    edges: rolled.filter(e => nodes.has(e.from) && nodes.has(e.to)).sort((a, b) => b.total - a.total || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)).map(edge),
    diagnostic: { config: layers.config, depth: step.depth, services: new Set(scoped.map(([, a]) => a.service)).size, files: scoped.length, nodes: nodes.size, error: null },
  };
}

/** "141 · imports 44, calls 40": the total, then per kind; dashed when every edge was inferred (synthesized or heuristic). */
function edge({ from, to, ...counts }: GraphRollupEdge): DiagramEdge {
  const kinds = Object.entries(counts.byKind).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([kind, n]) => `${kind} ${n}`).join(', ');
  const certain = counts.synthesized < counts.total;
  return { id: `depends:${from}->${to}`, from, to, fromField: null, toField: null, kind: 'depends', style: certain ? 'solid' : 'dashed', certain,
    label: `${counts.total} · ${kinds}`, source: null };
}
