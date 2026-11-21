// Adapts an open CodeGraph instance (read-write or read-only) to GraphApi. Never throws: errors read as an empty graph.
import type { CodeGraph, Edge, MergedEdge, MergedNode, Node, Overlay } from '@colbymchenry/codegraph';
import type { GraphApi, GraphLayers, GraphRelation, GraphRollupEdge, GraphSymbol } from './types';

type CodeGraphLibrary = typeof import('@colbymchenry/codegraph');

const symbol = (n: Node): GraphSymbol => ({ id: n.id, name: n.name, kind: n.kind, file: n.filePath, line: n.startLine, endLine: n.endLine, ...(n.docstring ? { docstring: n.docstring } : {}), ...(n.qualifiedName ? { qualifiedName: n.qualifiedName } : {}) });
const relation = (e: Edge & { possibly_stale?: boolean }): GraphRelation => ({ from: e.source, to: e.target, kind: e.kind, line: e.line ?? null,
  certain: e.provenance !== 'heuristic' && !e.possibly_stale, ...(e.metadata ? { meta: e.metadata } : {}) });
const safe = <T>(read: () => T, empty: T) => { try { return read(); } catch { return empty; } };

export function createGraphApi(cg: CodeGraph): GraphApi {
  return {
    findSymbols: (name, file) => safe(() => (file ? cg.getNodesInFile(file).filter(n => n.name === name) : cg.getNodesByName(name)).map(symbol), []),
    symbols: ids => safe(() => new Map([...cg.getNodesByIds(ids)].map(([id, n]) => [id, symbol(n)])), new Map()),
    outgoing: (ids, kinds) => safe(() => (ids.length ? cg.getOutgoingEdgesFrom(ids, kinds as Edge['kind'][]).map(relation) : []), []),
    incoming: (ids, kinds) => safe(() => (ids.length ? cg.getIncomingEdgesTo(ids, kinds as Edge['kind'][]).map(relation) : []), []),
    fileSymbols: file => safe(() => cg.getNodesInFile(file).map(symbol), []),
    layers: () => safe(() => cg.getLayers(), null),
    // The roll-up groups files by their service; handing it units as services rolls up to any mix of levels in one query.
    rollup: units => safe(() => {
      const known = new Set(Object.values(units));
      const assignments = Object.fromEntries(Object.entries(units).map(([file, unit]) => [file, { service: unit, module: '' }]));
      return cg.getLayerRollup({ layers: { config: null, services: [], assignments, errors: [], compose: [] } }).edges
        .filter(e => known.has(e.from) && known.has(e.to)) as GraphRollupEdge[];
    }, []),
  };
}

/** The same over a stinggraph overlay's merged view (shared base + worktree overlay); dangling edges are left out. */
export function createOverlayGraphApi(overlay: Overlay, root?: string, lib?: Pick<CodeGraphLibrary, 'computeLayers' | 'computeLayerRollup' | 'overlayLayerSource'>): GraphApi {
  // shortcut: loads the whole merged graph once per GraphApi (one view evaluation); upgrade to id-filtered merged-view
  // queries when stinggraph exports them and large repos make this slow.
  let nodes: Map<string, MergedNode> | undefined, edges: MergedEdge[] | undefined;
  const byId = () => nodes ??= new Map(overlay.getNodes().map(n => [n.id, n]));
  const related = (end: 'source' | 'target', ids: string[], kinds: string[]) => {
    const wanted = new Set(ids);
    return (edges ??= overlay.getEdges().filter(e => !e.dangling)).filter(e => wanted.has(e[end]) && (!kinds.length || kinds.includes(e.kind))).map(relation);
  };
  return {
    findSymbols: (name, file) => safe(() => overlay.getNodes(file ? { filePath: file, name } : { name }).map(symbol), []),
    symbols: ids => safe(() => new Map(ids.flatMap(id => { const n = byId().get(id); return n ? [[id, symbol(n)] as const] : []; })), new Map()),
    outgoing: (ids, kinds) => safe(() => related('source', ids, kinds), []),
    incoming: (ids, kinds) => safe(() => related('target', ids, kinds), []),
    fileSymbols: file => safe(() => overlay.getNodes({ filePath: file }).map(symbol), []),
    // Layers and roll-up over the merged view, so a branch's own changes (and its own layers.yaml) show; null/[] without the library.
    layers: () => safe(() => (root && lib ? lib.computeLayers(root, lib.overlayLayerSource(overlay)) as unknown as GraphLayers : null), null),
    rollup: units => safe(() => {
      if (!lib) return [];
      const known = new Set(Object.values(units));
      const assignments = Object.fromEntries(Object.entries(units).map(([file, unit]) => [file, { service: unit, module: '' }]));
      const layers = { config: null, services: [], assignments, errors: [], compose: [] };
      return lib.computeLayerRollup(layers, lib.overlayLayerSource(overlay).fileEdgeCounts()).edges
        .filter(e => known.has(e.from) && known.has(e.to)) as GraphRollupEdge[];
    }, []),
  };
}
