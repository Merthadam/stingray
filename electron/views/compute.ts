// Computes a repo view (`.stingray/views/<slug>.yaml`) from its resolved definition. Shared by ViewService (rules run in the
// CodeGraph child) and the `stingray-views` CLI (rules run in-process), so both show the same result.
//
// `use: [sqlalchemy]` merges the database tables (narrowed like a tables view: scope, include, exclude) into the rule output.
// Rules reach a table through its keys: node id, table name (label) or model class (subtitle). A rule node whose id is such a
// key is the table node (table properties win, rule fields append); an edge end that is a key points at the table. Rule edges
// to tables resolve inside the engine first, so they need `create: to|from|both` (the placeholder becomes the table) or a rule
// node with that id.
import type { DbSchemaResult } from '../../src/db-schema';
import type { DiagramEdge, DiagramNode, GraphStatus, SymbolRef, ViewResult, ViewWarning } from '../../src/views';
import type { SymbolQuery } from './graph';
import { databaseView } from './database';
import { TS_EXTRACTORS } from './sets';
import type { EvaluateOutput, ResolvedView } from './rules/types';
import { tablesView, type ViewFileEntry } from './view-file';

export const MAX_WARNINGS = 200;

export interface ComputeDeps {
  evaluate: (view: ResolvedView) => Promise<EvaluateOutput>;
  sqlalchemy?: () => Promise<DbSchemaResult>;
  sql?: () => Promise<DbSchemaResult>;
  findSymbols: (queries: SymbolQuery[]) => Promise<(SymbolRef | null)[]>;
  graph: GraphStatus;
  workspaceId?: string;
}

const EMPTY: EvaluateOutput = {
  groups: [], nodes: [], edges: [], warnings: [], truncated: false, stats: {},
  diagnostics: { rules: [], graph: null, unresolved: [], limits: { filesScanned: 0, matches: 0, truncated: false }, ms: 0 },
};

export async function computeView(entry: ViewFileEntry & { view: ResolvedView }, deps: ComputeDeps): Promise<ViewResult> {
  const { view, summary } = entry;
  // Views with only builtins (e.g. a plain sqlalchemy tables view) do not need the engine.
  const evaluated = view.rules.length > 0 || view.graph !== null || view.flowchart !== null || !!view.layers;
  const [output, schemas] = await Promise.all([
    evaluated ? deps.evaluate(view) : EMPTY,
    Promise.all(TS_EXTRACTORS.filter(name => view.builtins.includes(name) && deps[name]).map(name => deps[name]!())),
  ]);
  const schema = schemas.length ? combineSchemas(schemas) : null;
  const tables = schema ? tablesView(databaseView(schema, deps.graph), summary, view) : null;
  const merged = tables ? mergeTables(output, tables) : { nodes: output.nodes, edges: output.edges };
  const warnings: ViewWarning[] = [...output.warnings, ...tables?.warnings ?? []];
  const result: ViewResult = {
    ...summary, workspaceId: deps.workspaceId ?? '', computedAt: evaluated || !tables ? Date.now() : tables.computedAt, truncated: output.truncated || !!tables?.truncated,
    groups: [...new Map([...output.groups, ...tables?.groups ?? []].map(g => [g.id, g])).values()],
    nodes: merged.nodes, edges: merged.edges,
    warnings: warnings.slice(0, MAX_WARNINGS),
    stats: { ...tables?.stats, ...output.stats, nodes: merged.nodes.length, edges: merged.edges.length,
      ...(warnings.length > MAX_WARNINGS ? { warningsDropped: warnings.length - MAX_WARNINGS } : {}) },
    graph: deps.graph, diagnostics: output.diagnostics, layout: entry.layout ?? null,
  };
  return linkSymbols(result, deps.findSymbols);
}

/** Merge narrowed sqlalchemy tables into engine output (see the header for the key semantics). Pure. */
export function mergeTables(output: Pick<EvaluateOutput, 'nodes' | 'edges'>, tables: Pick<ViewResult, 'nodes' | 'edges'>) {
  const keys = new Map<string, string>(); // first table wins for a name shared by two metadata groups
  for (const t of tables.nodes) for (const k of [t.id, t.label, t.subtitle]) if (k !== null && !keys.has(k)) keys.set(k, t.id);
  const nodes = new Map<string, DiagramNode>(tables.nodes.map(t => [t.id, { ...t, fields: [...t.fields] }]));
  const ids = new Map<string, string>();
  for (const n of output.nodes) {
    const table = keys.get(n.id), node = table === undefined ? undefined : nodes.get(table);
    if (!node) { if (!nodes.has(n.id)) nodes.set(n.id, n); ids.set(n.id, n.id); continue; }
    ids.set(n.id, node.id);
    node.detail ??= n.detail; node.role ??= n.role; node.order ??= n.order; node.symbol ??= n.symbol;
    for (const f of n.fields) if (!node.fields.some(x => x.id === f.id)) node.fields.push(f);
  }
  const edges = new Map<string, DiagramEdge>(tables.edges.map(e => [e.id, e]));
  for (const e of output.edges) {
    const from = ids.get(e.from) ?? e.from, to = ids.get(e.to) ?? e.to;
    if (nodes.has(from) && nodes.has(to) && !edges.has(e.id)) edges.set(e.id, { ...e, from, to });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Link nodes without a symbol whose subtitle names a class in their file (e.g. a table's model), in one batch. */
export async function linkSymbols(result: ViewResult, findSymbols: ComputeDeps['findSymbols']): Promise<ViewResult> {
  const queries = result.nodes.map(n => (!n.symbol && n.source && n.subtitle ? { file: n.source.file, name: n.subtitle, kinds: ['class'] } : null));
  if (!queries.some(q => q)) return result;
  const symbols = await findSymbols(queries.filter(q => q !== null));
  let found = 0;
  return { ...result, nodes: result.nodes.map((n, i) => (queries[i] ? { ...n, symbol: symbols[found++] ?? null } : n)) };
}

/** Preserve extractor groups (and their edge identities) when composing the Database view. */
export function combineSchemas(schemas: DbSchemaResult[]): DbSchemaResult {
  return { workspaceId: schemas[0]?.workspaceId ?? '', scannedAt: Math.max(0, ...schemas.map(s => s.scannedAt)),
    filesScanned: schemas.reduce((n, s) => n + s.filesScanned, 0), filesParsed: schemas.reduce((n, s) => n + s.filesParsed, 0),
    truncated: schemas.some(s => s.truncated), groups: schemas.flatMap(s => s.groups), warnings: schemas.flatMap(s => s.warnings).slice(0, MAX_WARNINGS) };
}
