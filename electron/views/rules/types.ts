// Contracts of the rule-based view engine (M3, see .superpowers/sdd/views-platform/m3-design.md).
// The engine is pure: it reads files and the code graph only through the interfaces below, so the CodeGraph child
// process, the `stingray-views` CLI and tests can all drive it.
import type {
  DiagramEdge, DiagramGroup, DiagramNode, GraphStatus, GraphStepDiagnostic, ViewDiagnostics, ViewKind, ViewWarning,
} from '../../../src/views';

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

export interface Scope { include: string[]; exclude: string[] }

/** A view file with its `use` resolved: everything the engine needs, no further file reads of YAML. */
export interface ResolvedView {
  id: string;
  kind: ViewKind;
  scope: Scope;
  rules: SourcedRule[];
  graph: GraphStep | null;
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

export interface GraphSymbol { id: string; name: string; kind: string; file: string; line: number }
export interface GraphRelation {
  from: string; to: string;   // GraphSymbol ids
  kind: string;               // CodeGraph edge kind, e.g. "calls", "imports", "extends"
  line: number | null;
  certain: boolean;           // false for heuristic resolution
}
/** Read-only view of one worktree's code graph (CodeGraph adapter in the child/CLI, fake in tests). */
export interface GraphApi {
  /** Symbols named exactly `name`, optionally only in `file`. */
  findSymbols(name: string, file?: string): GraphSymbol[];
  symbols(ids: string[]): Map<string, GraphSymbol>;
  outgoing(ids: string[], kinds: string[]): GraphRelation[];
  incoming(ids: string[], kinds: string[]): GraphRelation[];
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
}

export interface GraphStepOutput {
  nodes: DiagramNode[];       // symbol always set; collapsed helpers appear as fields of their callers
  edges: DiagramEdge[];
  diagnostic: GraphStepDiagnostic;
  truncated: boolean;
}

export type Evaluate = (input: EvaluateInput) => Promise<EvaluateOutput>;
export type RunGraphStep = (step: GraphStep, graph: GraphApi, inScope: (file: string) => boolean) => GraphStepOutput;
