// Computes views per worktree and pushes ViewsChangedEvent when code, view files or the code graph change.
import { isSqlSource } from '../db-schema';
import type { DbSchemaResult } from '../../../shared/contracts/db-schema';
import type { ViewResult, ViewSummary } from '../../../shared/contracts/views';
import { unavailableGraph, type GraphChange, type GraphHost, type WorktreeGraph } from './graph';
import type { DbSchemaSource, FileProviderFactory, ViewFiles, ViewsPublisher } from './ports';
import { DATABASE_VIEW, databaseView } from './database';
import { combineSchemas, computeView, linkSymbols } from './compute';
import { LAYERS_VIEW, RULES_DIR, VIEWS_DIR, VIEW_SLUG, inScope, listViewFiles, readViewFile, type ViewFileEntry } from './view-file';

interface Worktree {
  root: string;
  graph: WorktreeGraph;
  unsubscribe: (() => void)[];
  schema: Promise<DbSchemaResult> | null; // latest database extraction, shared by all tables views
  sqlSchema: Promise<DbSchemaResult> | null;
  pending: { viewIds: Set<string>; listChanged: boolean; timer: ReturnType<typeof setTimeout> } | null;
  degraded?: boolean; // graph is the stand-in because host.open threw; retried on the next request
}

/** A schema source that timed out or had no worker: not cached, the next request scans again. */
const degradedResult = (r: DbSchemaResult) => r.warnings.some(w => w.message.startsWith('Schema scan unavailable'));

/** Whether changed files can change a view: a rule file it uses; for valid views, any .py file with sqlalchemy (a base
 * class or mixin outside the scope changes the tables inside it), any code file with a graph, flowchart, layers or sequence step, or a file its rules read. */
function affects(v: ViewFileEntry, changed: string[], code: string[], python: boolean, sql: boolean): boolean {
  if (v.ruleFiles.some(r => changed.includes(r))) return true;
  const view = v.view;
  if (!view) return false;
  if ((sql && view.builtins.includes('sql')) || (python && view.builtins.includes('sqlalchemy')) || (code.length && (view.graph || view.flowchart || view.layers || view.sequence))) return true;
  return code.some(f => inScope(f, view.scope) && view.rules.some(({ rule }) => !rule.files || inScope(f, { include: rule.files, exclude: [] })));
}

/** api.view options: a depth override and flowchart call paths opened/closed (see FlowchartStep.expand/collapse). */
export interface ViewOptions { depth?: number; expanded?: string[]; collapsed?: string[] }

const degradedSchema = (workspaceId: string, error: unknown): DbSchemaResult => ({ workspaceId, scannedAt: Date.now(), filesScanned: 0, filesParsed: 0,
  truncated: false, groups: [], warnings: [{ file: '', line: null, message: `Schema scan unavailable: ${error instanceof Error ? error.message : String(error)}` }] });

export class ViewService {
  private readonly worktrees = new Map<string, Worktree>();
  private readonly computations = new Map<string, Promise<ViewResult>>();
  private readonly released = new Set<string>();
  private readonly host: GraphHost;
  private readonly schemas: DbSchemaSource;
  private readonly emit: ViewsPublisher;
  private readonly debounceMs: number;
  private readonly viewFiles: ViewFiles;
  private readonly fileProvider: FileProviderFactory;
  private readonly log: (message: string, error: unknown) => void;

  // grammarPath is read by the wiring's in-process DbSchemaSource, not here.
  constructor(options: { host: GraphHost; grammarPath: string; emit: ViewsPublisher; debounceMs?: number; dbSchema: DbSchemaSource;
    viewFiles: ViewFiles; fileProvider: FileProviderFactory; log?: (message: string, error: unknown) => void }) {
    this.host = options.host; this.schemas = options.dbSchema; this.emit = options.emit; this.debounceMs = options.debounceMs ?? 300;
    this.viewFiles = options.viewFiles; this.fileProvider = options.fileProvider; this.log = options.log ?? console.error;
  }

  async listViews(workspaceId: string, root: string): Promise<ViewSummary[]> {
    this.worktree(workspaceId, root);
    return [DATABASE_VIEW, LAYERS_VIEW.summary, ...(await listViewFiles(this.viewFiles, root)).map(v => v.summary)];
  }

  /** Concurrent requests for the same view (and depth override and call expansions) of a worktree share one computation. */
  computeView(workspaceId: string, root: string, viewId: string, options: ViewOptions = {}): Promise<ViewResult> {
    const paths = (p?: string[]) => [...p ?? []].sort().join('\n');
    const key = `${workspaceId}\0${viewId}\0${options.depth ?? ''}\0${paths(options.expanded)}\0${paths(options.collapsed)}`;
    let computation = this.computations.get(key);
    if (!computation) {
      const started: Promise<ViewResult> = computation = this.compute(workspaceId, root, viewId, options)
        .finally(() => { if (this.computations.get(key) === started) this.computations.delete(key); });
      this.computations.set(key, computation);
    }
    return computation;
  }

  /** Stop the worktree's graph (e.g. before its folder is removed); it is not reopened until reopen(). */
  async release(workspaceId: string): Promise<void> {
    this.released.add(workspaceId);
    const w = this.worktrees.get(workspaceId);
    if (!w) return;
    this.worktrees.delete(workspaceId);
    w.unsubscribe.forEach(u => u());
    if (w.pending) clearTimeout(w.pending.timer);
    await this.host.close(workspaceId);
  }

  /** Undo release() when the worktree stays (e.g. its removal failed). */
  reopen(workspaceId: string) { this.released.delete(workspaceId); }

  /** One closeAll instead of a close per worktree: the host bounds it, so quitting never waits long. */
  async dispose(): Promise<void> {
    for (const w of this.worktrees.values()) { w.unsubscribe.forEach(u => u()); if (w.pending) clearTimeout(w.pending.timer); }
    this.worktrees.clear();
    await this.host.closeAll();
  }

  private async compute(workspaceId: string, root: string, viewId: string, { depth, expanded = [], collapsed = [] }: ViewOptions): Promise<ViewResult> {
    const w = this.worktree(workspaceId, root);
    const findSymbols = w.graph.findSymbols.bind(w.graph);
    if (viewId === DATABASE_VIEW.id) return linkSymbols(databaseView(combineSchemas(await Promise.all([this.schema(w, workspaceId), this.sqlSchema(w, workspaceId)])), w.graph.status()), findSymbols);
    const file = viewId === LAYERS_VIEW.summary.id ? LAYERS_VIEW : await readViewFile(this.viewFiles, root, viewId);
    if (!file) throw new Error(`Unknown view: ${viewId}`);
    let { view } = file;
    if (!view) throw new Error(`View file ${file.summary.file} is invalid: ${file.summary.error}`);
    let layout = file.layout;
    // Another depth draws other nodes: the file's saved positions belong to its own depth.
    if (depth !== undefined && view.flowchart && depth !== view.flowchart.depth) { view = { ...view, flowchart: { ...view.flowchart, depth: Math.min(4, depth) } }; layout = null; }
    // Calls opened/closed in the Views tab: like a depth override, other nodes than the file's layout is for.
    if (view.flowchart && (expanded.length || collapsed.length)) {
      view = { ...view, flowchart: { ...view.flowchart, expand: [...new Set([...view.flowchart.expand ?? [], ...expanded])], collapse: collapsed } }; layout = null;
    }
    if (depth !== undefined && view.layers && depth !== view.layers.depth) { view = { ...view, layers: { ...view.layers, depth: Math.min(4, Math.max(1, depth)) } }; layout = null; }
    if (depth !== undefined && view.sequence && depth !== view.sequence.depth) { view = { ...view, sequence: { ...view.sequence, depth } }; layout = null; }
    return computeView({ ...file, view, layout }, {
      workspaceId, graph: w.graph.status(), findSymbols, callees: ids => w.graph.callees(ids), fileSymbols: f => w.graph.fileSymbols(f), readSource: this.fileProvider(root).read, sqlalchemy: () => this.schema(w, workspaceId), sql: () => this.sqlSchema(w, workspaceId),
      evaluate: v => w.graph.evaluateView(v).catch((error: Error) => { throw new Error(`View ${viewId} could not be computed: ${error.message}`); }),
    });
  }

  // Rule 2: a failing schema source gives the Database view a warning instead of failing it (cache logic unchanged).
  private schema(w: Worktree, id: string) { return this.rawSchema(w, id).catch(error => degradedSchema(id, error)); }
  private sqlSchema(w: Worktree, id: string) { return this.rawSqlSchema(w, id).catch(error => degradedSchema(id, error)); }

  private rawSchema(w: Worktree, workspaceId: string): Promise<DbSchemaResult> {
    if (w.schema) return w.schema;
    const scan = this.schemas.dbSchema(workspaceId, w.root);
    w.schema = scan;
    // Keep the result only while the graph reports changes; otherwise share just the in-flight scan.
    const drop = (r: DbSchemaResult) => { if (w.schema === scan && (w.graph.status().state === 'unavailable' || degradedResult(r))) w.schema = null; };
    scan.then(drop, () => { if (w.schema === scan) w.schema = null; });
    return scan;
  }

  private rawSqlSchema(w: Worktree, workspaceId: string): Promise<DbSchemaResult> {
    if (w.sqlSchema) return w.sqlSchema;
    const scan = this.schemas.sqlSchema(workspaceId, w.root);
    w.sqlSchema = scan;
    const drop = (r: DbSchemaResult) => { if (w.sqlSchema === scan && (w.graph.status().state === 'unavailable' || degradedResult(r))) w.sqlSchema = null; };
    scan.then(drop, () => { if (w.sqlSchema === scan) w.sqlSchema = null; });
    return scan;
  }

  private worktree(workspaceId: string, root: string): Worktree {
    if (this.released.has(workspaceId)) throw new Error('This workspace is being removed.');
    const existing = this.worktrees.get(workspaceId);
    // Reopening marks the graph recently used and restarts it if the host closed it (open-graph cap, crashed process).
    let reopened: WorktreeGraph | undefined;
    if (existing) {
      try { reopened = this.host.open(workspaceId, root); } catch { /* already degraded or logged on first open */ }
      if (!existing.degraded || !reopened) return existing;
      // The graph recovered after a failed first open: rebuild this worktree on the real graph.
      existing.unsubscribe.forEach(u => u());
      if (existing.pending) clearTimeout(existing.pending.timer);
      this.worktrees.delete(workspaceId);
    }
    let graph: WorktreeGraph;
    let degraded = false;
    if (reopened) graph = reopened;
    else try { graph = this.host.open(workspaceId, root); } catch (error) {
      this.log('Code graph unavailable for views:', error);
      graph = unavailableGraph(workspaceId, root, 'Code graph unavailable; views without the graph still work.');
      degraded = true;
    }
    const wt: Worktree = { root, graph, unsubscribe: [], schema: null, sqlSchema: null, pending: null, degraded };
    this.worktrees.set(workspaceId, wt);
    wt.unsubscribe.push(
      graph.onChange(change => { void this.changed(workspaceId, wt, change).catch(() => {}); }),
      graph.onStatus(() => {
        wt.sqlSchema = null;
        wt.schema = null; // changes may have been missed while the graph was not watching
        void this.allViewIds(wt).then(ids => this.queue(workspaceId, wt, ids, false)).catch(() => {});
      }),
    );
    return wt;
  }

  private async changed(workspaceId: string, w: Worktree, change: GraphChange) {
    const ids = new Set<string>();
    let listChanged = false;
    for (const f of change.files) {
      if (!f.startsWith(VIEWS_DIR + '/')) continue;
      listChanged = true;
      const slug = f.slice(VIEWS_DIR.length + 1).replace(/\.yaml$/, '');
      if (VIEW_SLUG.test(slug)) ids.add(slug);
    }
    const sql = change.files.some(isSqlSource);
    if (sql) { w.sqlSchema = null; ids.add(DATABASE_VIEW.id); }
    const python = change.files.some(f => f.endsWith('.py'));
    if (python) { w.schema = null; ids.add(DATABASE_VIEW.id); }
    const code = change.files.filter(f => !f.startsWith('.stingray/'));
    const rules = change.files.some(f => f.startsWith(RULES_DIR + '/'));
    listChanged ||= rules; // a rule file can make a view valid or invalid (its summary error)
    if (code.length) ids.add(LAYERS_VIEW.summary.id);
    if (code.length || rules) {
      for (const v of await listViewFiles(this.viewFiles, w.root).catch(() => [])) if (affects(v, change.files, code, python, sql)) ids.add(v.summary.id);
    }
    this.queue(workspaceId, w, ids, listChanged);
  }

  private async allViewIds(w: Worktree) {
    return [DATABASE_VIEW.id, LAYERS_VIEW.summary.id, ...(await listViewFiles(this.viewFiles, w.root).catch(() => [])).map(v => v.summary.id)];
  }

  /** Coalesce changes into one event per worktree, at most debounceMs after the first change. */
  private queue(workspaceId: string, w: Worktree, ids: Iterable<string>, listChanged: boolean) {
    if (this.worktrees.get(workspaceId) !== w) return; // released meanwhile
    const p = w.pending ??= { viewIds: new Set(), listChanged: false, timer: setTimeout(() => {
      w.pending = null;
      if (!p.viewIds.size && !p.listChanged) return;
      // A computation that started before the change must not answer the refetch this event triggers.
      for (const key of this.computations.keys()) {
        const [ws, id] = key.split('\0');
        if (ws === workspaceId && p.viewIds.has(id)) this.computations.delete(key); // every depth override of the view
      }
      try { this.emit({ workspaceId, viewIds: [...p.viewIds].sort(), listChanged: p.listChanged }); } catch { /* never throw from listeners */ }
    }, this.debounceMs) };
    for (const id of ids) p.viewIds.add(id);
    p.listChanged ||= listChanged;
  }
}
