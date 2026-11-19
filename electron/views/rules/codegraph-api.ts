// Adapts an open CodeGraph instance (read-write or read-only) to GraphApi. Never throws: errors read as an empty graph.
import type { CodeGraph, Edge, Node } from '@colbymchenry/codegraph';
import type { GraphApi, GraphRelation, GraphRollupEdge, GraphSymbol } from './types';

const symbol = (n: Node): GraphSymbol => ({ id: n.id, name: n.name, kind: n.kind, file: n.filePath, line: n.startLine });
const relation = (e: Edge): GraphRelation => ({ from: e.source, to: e.target, kind: e.kind, line: e.line ?? null, certain: e.provenance !== 'heuristic' });
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
