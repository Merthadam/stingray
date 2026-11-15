// Main <-> renderer contract for Views: named, generic diagrams computed from a worktree's source.
// Every view type (database tables today; flows, timelines, ... later) produces the same diagram model,
// so one renderer can draw all of them. Results come from static analysis; repository code is never executed.

export type ViewKind = 'tables' | 'flow' | 'timeline' | 'graph';

/** Worktree-relative POSIX path and 1-based line. */
export interface SourceRef { file: string; line: number }

/** A row inside a node, e.g. a table column. */
export interface DiagramField {
  id: string;                  // unique within its node (e.g. the column attribute)
  label: string;               // display name (e.g. DB column name)
  type: string | null;         // e.g. "String(255)"; null = unknown
  badges: string[];            // short markers in display order, e.g. ["PK", "FK", "UQ", "NULL"]
  detail: string | null;       // secondary text, e.g. "attribute email · from TimestampMixin"
  source: SourceRef | null;
}

/** A symbol in the worktree's code graph (CodeGraph), for click-through and callers/callees later. */
export interface SymbolRef {
  id: string;                  // CodeGraph node id; only meaningful for the same worktree's graph
  name: string;
  kind: string;                // CodeGraph node kind, e.g. "class", "function"
  file: string;
  line: number;
}

export interface DiagramNode {
  id: string;                  // unique within the view; edges reference it
  label: string;
  kind: string;                // presentation hint, e.g. "table"
  subtitle: string | null;     // e.g. the model class name
  group: string | null;        // DiagramGroup.id
  fields: DiagramField[];
  source: SourceRef | null;
  symbol: SymbolRef | null;    // linked code-graph symbol (e.g. the model class); null when not linked yet
  role: 'start' | 'end' | null; // flow entry/exit (e.g. LangGraph START/END)
  order: number | null;        // position on a timeline; null = derive from edges
  detail: string | null;       // secondary text under the label, e.g. a LangGraph step's handler
}

export interface DiagramEdge {
  id: string;                  // unique within the view
  from: string;                // DiagramNode.id
  to: string;                  // DiagramNode.id
  fromField: string | null;    // DiagramField.id on `from`, when the edge starts at a field
  toField: string | null;      // DiagramField.id on `to`
  kind: string;                // e.g. "foreign-key", "relationship"
  style: 'solid' | 'dashed';   // always 'dashed' when certain is false
  certain: boolean;            // false when static analysis could not be sure (e.g. heuristic call resolution)
  label: string | null;
  source: SourceRef | null;
}

export interface DiagramGroup {
  id: string;
  label: string;
  source: SourceRef | null;
}

export interface ViewWarning { file: string | null; line: number | null; message: string }

export interface ViewSummary {
  id: string;                  // stable view id: "database" (builtin) or the repo view file's slug
  name: string;
  kind: ViewKind;
  description: string;
  builtin: boolean;            // shipped with Stingray (vs. defined by a file in the repo)
  file: string | null;         // worktree-relative view file, e.g. ".stingray/views/crud.yaml"; null for builtin
  error: string | null;        // the view file is invalid; the view cannot be computed until it is fixed
}

/** State of the worktree's code graph. Views still compute without it; symbol links and live updates degrade. */
export type GraphState = 'starting' | 'indexing' | 'ready' | 'read-only' | 'unavailable';
export interface GraphStatus { state: GraphState; message: string | null }

/** Pushed from main when views of a worktree may have changed (code, view files, or graph state). */
export interface ViewsChangedEvent {
  workspaceId: string;
  viewIds: string[];           // views whose result may differ now; refetch with view()
  listChanged: boolean;        // view files were added, removed or renamed; refetch views()
}

export interface ViewResult extends ViewSummary {
  workspaceId: string;
  computedAt: number;          // Date.now() when computation finished
  truncated: boolean;          // a scan limit was hit; the diagram may be incomplete
  groups: DiagramGroup[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];        // only between nodes present in `nodes`
  warnings: ViewWarning[];
  stats: Record<string, number>; // view-specific counters, e.g. { filesScanned: 38 }
  graph: GraphStatus;          // code-graph state when this result was computed
  diagnostics: ViewDiagnostics | null; // rule/graph-step feedback for repo views; null for builtin views
  layout: ViewLayout | null;   // positions saved in the view file (`layout:`); null for builtin views or when absent
}

/** Diagram positions (React Flow coordinates, top-left of the node). Stored in a view file's `layout:` and locally. */
export interface ViewLayout { positions: Record<string, { x: number; y: number }> } // key: DiagramNode.id; max 1000

// ---- Views UI (renderer <-> main) ----

/** Per-user state of one view in one worktree, kept in Stingray's app data (never in the repo). */
export interface ViewLocalState {
  hidden: string[];            // DiagramNode ids filtered out (max 2000)
  positions: Record<string, { x: number; y: number }>; // dragged/laid-out positions (max 1000)
  expanded: string[];          // node ids whose long field lists are expanded (max 500)
}

export type EditorId = 'repo-map' | 'vscode' | 'cursor' | 'zed' | 'system';
export interface EditorSettings {
  selected: EditorId;          // 'system' = the OS default app (no line number)
  available: EditorId[];       // detected on this machine; always includes 'repo-map' and 'system'
}

/** "Save as view…": a new repo view file derived from a shown view. */
export interface SaveViewInput {
  name: string;                // 1-80 chars; the slug (file name) is derived from it
  basedOn: string;             // ViewSummary.id the user was looking at ("database" or a repo view slug)
  exclude: string[];           // labels of hidden nodes (tables: table names), merged into the base view's exclude
  layout: ViewLayout | null;   // include current positions when the user ticks "save positions"
}
export interface SaveViewResult { id: string; file: string } // slug and worktree-relative file

/** Feedback for one rule of a view (inline, from .stingray/rules/<name>.yaml, or a builtin set). */
export interface RuleDiagnostic {
  rule: string;                // "<source>#<id>"; source = "view" | "rules/<name>" | "builtin/<name>"
  language: string;
  filesScanned: number;
  matches: number;             // raw query matches (before emit)
  emitted: number;             // nodes + edges + fields + groups produced
  skipped: number;             // matches dropped by emit (missing capture, invalid order, cap)
  errors: ViewWarning[];       // query compile errors (file = YAML file, line inside it), parse failures
  warnings: ViewWarning[];     // 0 matches, match cap hit, ...
  ms: number;
}

export interface GraphStepDiagnostic {
  started: number;             // start symbols found
  reached: number;             // symbols reached before helpers handling / cap
  helpers: number;             // symbols treated as helpers
  truncated: boolean;          // node cap hit
  error: string | null;        // e.g. "code graph not ready (indexing)", "start symbol not found: x"
}

export interface UnresolvedLink { rule: string; value: string; file: string; line: number }

export interface ViewDiagnostics {
  rules: RuleDiagnostic[];
  graph: GraphStepDiagnostic | null; // null when the view has no graph step
  unresolved: UnresolvedLink[];      // first 50 edge endpoints that matched no node id/alias
  limits: { filesScanned: number; matches: number; truncated: boolean };
  ms: number;
}
