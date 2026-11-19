// Adapts an open CodeGraph instance (read-write or read-only) to GraphApi. Never throws: errors read as an empty graph.
import type { CodeGraph, Edge, MergedEdge, MergedNode, Node, Overlay } from '@colbymchenry/codegraph';
import type { GraphApi, GraphRelation, GraphSymbol } from './types';

const symbol = (n: Node): GraphSymbol => ({ id: n.id, name: n.name, kind: n.kind, file: n.filePath, line: n.startLine });
const relation = (e: Edge & { possibly_stale?: boolean }): GraphRelation => ({ from: e.source, to: e.target, kind: e.kind, line: e.line ?? null, certain: e.provenance !== 'heuristic' && !e.possibly_stale });
const safe = <T>(read: () => T, empty: T) => { try { return read(); } catch { return empty; } };

export function createGraphApi(cg: CodeGraph): GraphApi {
  return {
    findSymbols: (name, file) => safe(() => (file ? cg.getNodesInFile(file).filter(n => n.name === name) : cg.getNodesByName(name)).map(symbol), []),
    symbols: ids => safe(() => new Map([...cg.getNodesByIds(ids)].map(([id, n]) => [id, symbol(n)])), new Map()),
    outgoing: (ids, kinds) => safe(() => (ids.length ? cg.getOutgoingEdgesFrom(ids, kinds as Edge['kind'][]).map(relation) : []), []),
    incoming: (ids, kinds) => safe(() => (ids.length ? cg.getIncomingEdgesTo(ids, kinds as Edge['kind'][]).map(relation) : []), []),
  };
}

/** The same over a stinggraph overlay's merged view (shared base + worktree overlay); dangling edges are left out. */
export function createOverlayGraphApi(overlay: Overlay): GraphApi {
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
  };
}
