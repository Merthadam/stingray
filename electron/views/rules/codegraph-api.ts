// Adapts an open CodeGraph instance (read-write or read-only) to GraphApi. Never throws: errors read as an empty graph.
import type { CodeGraph, Edge, Node } from '@colbymchenry/codegraph';
import type { GraphApi, GraphRelation, GraphSymbol } from './types';

const symbol = (n: Node): GraphSymbol => ({ id: n.id, name: n.name, kind: n.kind, file: n.filePath, line: n.startLine });
const relation = (e: Edge): GraphRelation => ({ from: e.source, to: e.target, kind: e.kind, line: e.line ?? null, certain: e.provenance !== 'heuristic' });
const safe = <T>(read: () => T, empty: T) => { try { return read(); } catch { return empty; } };

export function createGraphApi(cg: CodeGraph): GraphApi {
  return {
    findSymbols: (name, file) => safe(() => (file ? cg.getNodesInFile(file).filter(n => n.name === name) : cg.getNodesByName(name)).map(symbol), []),
    symbols: ids => safe(() => new Map([...cg.getNodesByIds(ids)].map(([id, n]) => [id, symbol(n)])), new Map()),
    outgoing: (ids, kinds) => safe(() => (ids.length ? cg.getOutgoingEdgesFrom(ids, kinds as Edge['kind'][]).map(relation) : []), []),
    incoming: (ids, kinds) => safe(() => (ids.length ? cg.getIncomingEdgesTo(ids, kinds as Edge['kind'][]).map(relation) : []), []),
  };
}
