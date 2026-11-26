// Contracts of the rule-based view engine (M3, see .superpowers/sdd/views-platform/m3-design.md).
// The engine is pure: it reads files and the code graph only through the interfaces below, so the CodeGraph child
// process, the `stingray-views` CLI and tests can all drive it.
import type { DiagramEdge, DiagramGroup, DiagramNode, GraphStatus, GraphStepDiagnostic, SequenceData, ViewDiagnostics, ViewKind, ViewWarning } from '../../../../shared/contracts/views';

// ---- Definitions (parsed from YAML; templates are unrendered strings like "@name") ----

export interface NodeEmit {
  id: string; label?: string; kind?: string; subtitle?: string; group?: string;
  role?: string;              // template rendering to "start" | "end" (anything else: per-match warning, role null)
  order?: string;             // template rendering to a finite number
  detail?: string;
  symbol?: string;            // symbol name to link through the code graph
  aliases?: string[];         // extra keys edges/fields may use to reach this node
}
export interface EdgeEmit {
  from: string; to: string; kind?: string; label?: string;
  style?: 'solid' | 'dashed';
  certain?: boolean;          // false -> dashed
  create?: 'none' | 'from' | 'to' | 'both'; // create placeholder nodes for unresolved ends
}
export interface FieldEmit { node: string; id: string; label?: string; type?: string; badges?: string[]; detail?: string }
export interface GroupEmit { id: string; label?: string }
export type Emit = { node: NodeEmit } | { edge: EdgeEmit } | { field: FieldEmit } | { group: GroupEmit };

export interface Rule {
  id: string;                 // [a-z0-9-]{1,64}, unique within its YAML file
  language: string;           // CodeGraph grammar name, e.g. "python", "typescript", "tsx", "terraform"
  files?: string[];           // safe globs narrowing the view scope for this rule
  query: string;              // tree-sitter query, ≤ 8 KiB
  within?: { function?: string; class?: string }; // globs on the nearest enclosing definition names
  emit: Emit;
}

export type RuleSourceName = 'view' | `rules/${string}` | `builtin/${string}`;

/** A rule plus where it was defined, so diagnostics can point into the YAML. */
export interface SourcedRule {
  source: RuleSourceName;
  file: string | null;        // worktree-relative YAML file; null for builtin sets
  line: number | null;        // 1-based line of the rule in that file
  queryLine: number | null;   // 1-based line where the query text starts (query errors are reported relative to it)
  rule: Rule;
}

export type FollowKind = 'calls' | 'imports' | 'inherits' | 'references';
export interface GraphStep {
  start: { symbol: string; file?: string }[]; // 1-10
  follow: FollowKind[];
  direction: 'out' | 'in' | 'both';           // default out
  depth: number;                              // 1-6, default 3
  include?: string[];                         // default: the view scope
  exclude?: string[];
  helpers: 'show' | 'collapse' | 'hide';      // default collapse
}

/** `flowchart:` of a `kind: flowchart` view (see docs/flowchart-view-spec.md). */
export interface FlowchartStep {
  start: { symbol: string; file?: string };   // exactly one entry function; file optional if the name is unique
  depth: number;                              // 0-4, default 1: call levels expanded inline
  include?: string[];                         // files whose functions may be expanded (default: the view scope)
  exclude?: string[];
  hide?: string[];                            // calls drawn as nothing (no box, no expansion): callee names or dotted
                                              // paths ("log", "self.metrics.*"); '*' matches any run of characters
  expand?: string[];                          // calls expanded beyond `depth`: a call path ("finish>create_session",
                                              // "audit#2") or a callee name (any call of it inside an expanded frame)
  collapse?: string[];                        // runtime only (Views tab): call paths drawn closed even within `depth`
}

export const LINK_SETS = ['http', 'auth', 'langgraph', 'events', 'ipc'] as const;
export type LinkSet = typeof LINK_SETS[number];
export const SEQUENCE_PARTICIPANTS = ['auto', 'service', 'module', 'file', 'class'] as const;

/** `sequence:` of a `kind: sequence` view (see docs/sequence-view-spec.md). */
export interface SequenceStep {
  start: { symbol?: string; route?: string; ipc?: string; file?: string }; // exactly one of symbol | route | ipc (schema-checked)
  trigger?: string;                           // first arrow from the actor (label); no actor without it
  actor: string;                              // default "User"
  depth: number;                              // 0-6, default 3: call levels followed
  participants: typeof SEQUENCE_PARTICIPANTS[number]; // lifeline granularity, default auto
  internal: 'collapse' | 'show';              // calls inside one participant: folded away or drawn as self arrows
  returns: boolean;                           // dashed return arrows
  links: LinkSet[];                           // builtin link sets followed (default: all)
  externals: Record<string, string>;          // import/module prefix -> external lifeline label
  include?: string[];                         // files whose functions may be followed (default: the view scope)
  exclude?: string[];
}

/** `layers:` of a `kind: graph` view: stinggraph's service layers drawn as a hierarchy (see layers.ts). */
export interface LayersStep {
  depth: number;                              // 1-4, default 1: 1 services, 2 modules, 3 files, 4 symbols
  expand?: string[];                          // service ids or labels drawn below services (default: all)
}

export interface Scope { include: string[]; exclude: string[] }

/** A view file with its `use` resolved: everything the engine needs, no further file reads of YAML. */
export interface ResolvedView {
  id: string;
  kind: ViewKind;
  scope: Scope;
  rules: SourcedRule[];
  graph: GraphStep | null;
  flowchart: FlowchartStep | null;
  layers?: LayersStep | null;
  sequence?: SequenceStep | null;
  builtins: string[];         // TypeScript extractors computed by the main process, e.g. ["sqlalchemy"]
  include: string[];          // node ids/labels always kept
  exclude: string[];          // node ids/labels always dropped (wins)
}

// ---- Environment ----

export interface FileProvider {
  /** Candidate files (worktree-relative POSIX), already excluding .git, .codegraph, node_modules, symlinks; capped.
   * `keep` (e.g. the view scope) filters before the cap, so out-of-scope files in a large repo do not use it up. */
  list(keep?: (file: string) => boolean): Promise<{ files: string[]; truncated: boolean }>;
  /** File text, or null when missing/unreadable/too large (> 1 MiB) or not a regular file. */
  read(file: string): Promise<string | null>;
}

export interface GraphSymbol {
  id: string; name: string; kind: string; file: string; line: number;
  endLine?: number;           // last line of the body; absent when unknown
  docstring?: string | null;  // raw CodeGraph docstring; absent when the symbol has none
  qualifiedName?: string;     // CodeGraph's qualified name, e.g. "SessionStore::get_user"; absent when empty
}
export interface GraphRelation {
  from: string; to: string;   // GraphSymbol ids
  kind: string;               // CodeGraph edge kind, e.g. "calls", "imports", "extends"
  line: number | null;
  certain: boolean;           // false for heuristic resolution
  meta?: Record<string, unknown>; // CodeGraph edge metadata, e.g. { channel: "http", method, href } of a client call to a route
}
/** stinggraph's service layers (CodeGraph.getLayers; its `Layers` type fits this shape). */
export interface GraphLayers {
  config: string | null;      // ".stinggraph/layers.yaml" when it was used, else null (inferred only)
  services: { id: string; label: string; aliases: string[]; origin: string; modules: { id: string; label: string }[] }[];
  assignments: Record<string, { service: string; module: string }>; // every indexed file
  errors: { source: string; message: string }[];
}
/** Edges between two units of a `rollup`, counted per edge kind. */
export interface GraphRollupEdge { from: string; to: string; total: number; synthesized: number; byKind: Record<string, number> }

/** Read-only view of one worktree's code graph (CodeGraph adapter in the child/CLI, fake in tests). */
export interface GraphApi {
  /** Symbols named exactly `name`, optionally only in `file`. */
  findSymbols(name: string, file?: string): GraphSymbol[];
  symbols(ids: string[]): Map<string, GraphSymbol>;
  outgoing(ids: string[], kinds: string[]): GraphRelation[];
  incoming(ids: string[], kinds: string[]): GraphRelation[];
  /** Every node of a file, the file node itself (kind "file") included. */
  fileSymbols(file: string): GraphSymbol[];
  layers(): GraphLayers | null;
  /** Cross-file edges rolled up to `units[file]` (files without a unit are left out); edges inside one unit are not counted. */
  rollup(units: Record<string, string>): GraphRollupEdge[];
}

// ---- Evaluation ----

export interface EvaluateInput {
  view: ResolvedView;
  files: FileProvider;
  graph: GraphApi | null;     // null when the code graph is not ready
  graphStatus: GraphStatus;
  grammarDir: string;         // directory with tree-sitter-<language>.wasm (CodeGraph's extraction/wasm)
  signal?: AbortSignal;
}

export interface EvaluateOutput {
  groups: DiagramGroup[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  warnings: ViewWarning[];
  diagnostics: ViewDiagnostics;
  truncated: boolean;
  stats: Record<string, number>;
  sequence?: SequenceData | null; // kind: sequence views only
}

export interface GraphStepOutput {
  nodes: DiagramNode[];       // symbol always set; collapsed helpers appear as fields of their callers
  edges: DiagramEdge[];
  diagnostic: GraphStepDiagnostic;
  truncated: boolean;
}

export type Evaluate = (input: EvaluateInput) => Promise<EvaluateOutput>;
export type RunGraphStep = (step: GraphStep, graph: GraphApi, inScope: (file: string) => boolean) => GraphStepOutput;
