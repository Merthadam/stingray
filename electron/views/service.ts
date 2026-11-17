// Computes views per worktree and pushes ViewsChangedEvent when code, view files or the code graph change.
import { extractDbSchema } from '../db-schema';
import { extractSqlSchema, isSqlSource } from '../sql-schema';
import type { DbSchemaResult } from '../../src/db-schema';
import type { ViewResult, ViewSummary, ViewsChangedEvent } from '../../src/views';
import type { GraphChange, GraphHost, WorktreeGraph } from './graph';
import { DATABASE_VIEW, databaseView } from './database';
import { combineSchemas, computeView, linkSymbols } from './compute';
import { RULES_DIR, VIEWS_DIR, VIEW_SLUG, inScope, listViewFiles, readViewFile, type ViewFileEntry } from './view-file';

interface Worktree {
  root: string;
  graph: WorktreeGraph;
  unsubscribe: (() => void)[];
  schema: Promise<DbSchemaResult> | null; // latest database extraction, shared by all tables views
  sqlSchema: Promise<DbSchemaResult> | null;
  pending: { viewIds: Set<string>; listChanged: boolean; timer: NodeJS.Timeout } | null;
}

/** Whether changed files can change a view: a rule file it uses; for valid views, any .py file with sqlalchemy (a base
 * class or mixin outside the scope changes the tables inside it), any code file with a graph or flowchart step, or a file its rules read. */
function affects(v: ViewFileEntry, changed: string[], code: string[], python: boolean, sql: boolean): boolean {
  if (v.ruleFiles.some(r => changed.includes(r))) return true;
  const view = v.view;
  if (!view) return false;
  if ((sql && view.builtins.includes('sql')) || (python && view.builtins.includes('sqlalchemy')) || (code.length && (view.graph || view.flowchart))) return true;
  return code.some(f => inScope(f, view.scope) && view.rules.some(({ rule }) => !rule.files || inScope(f, { include: rule.files, exclude: [] })));
}

export class ViewService {
  private readonly worktrees = new Map<string, Worktree>();
  private readonly computations = new Map<string, Promise<ViewResult>>();
  private readonly released = new Set<string>();
  private readonly host: GraphHost;
  private readonly grammarPath: string;
  private readonly emit: (event: ViewsChangedEvent) => void;
  private readonly debounceMs: number;

  constructor(options: { host: GraphHost; grammarPath: string; emit: (event: ViewsChangedEvent) => void; debounceMs?: number }) {
    this.host = options.host; this.grammarPath = options.grammarPath; this.emit = options.emit; this.debounceMs = options.debounceMs ?? 300;
  }

  async listViews(workspaceId: string, root: string): Promise<ViewSummary[]> {
    this.worktree(workspaceId, root);
    return [DATABASE_VIEW, ...(await listViewFiles(root)).map(v => v.summary)];
  }

  /** Concurrent requests for the same view (and depth override) of a worktree share one computation. */
  computeView(workspaceId: string, root: string, viewId: string, options: { depth?: number } = {}): Promise<ViewResult> {
    const key = `${workspaceId}\0${viewId}\0${options.depth ?? ''}`;
    let computation = this.computations.get(key);
    if (!computation) {
      const started: Promise<ViewResult> = computation = this.compute(workspaceId, root, viewId, options.depth)
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

  private async compute(workspaceId: string, root: string, viewId: string, depth: number | undefined): Promise<ViewResult> {
    const w = this.worktree(workspaceId, root);
    const findSymbols = w.graph.findSymbols.bind(w.graph);
    if (viewId === DATABASE_VIEW.id) return linkSymbols(databaseView(combineSchemas(await Promise.all([this.schema(w, workspaceId), this.sqlSchema(w, workspaceId)])), w.graph.status()), findSymbols);
    const file = await readViewFile(root, viewId);
    if (!file) throw new Error(`Unknown view: ${viewId}`);
    let { view } = file;
    if (!view) throw new Error(`View file ${file.summary.file} is invalid: ${file.summary.error}`);
    let layout = file.layout;
    // Another depth draws other nodes: the file's saved positions belong to its own depth.
    if (depth !== undefined && view.flowchart && depth !== view.flowchart.depth) { view = { ...view, flowchart: { ...view.flowchart, depth } }; layout = null; }
    return computeView({ ...file, view, layout }, {
      workspaceId, graph: w.graph.status(), findSymbols, sqlalchemy: () => this.schema(w, workspaceId), sql: () => this.sqlSchema(w, workspaceId),
      evaluate: v => w.graph.evaluateView(v).catch((error: Error) => { throw new Error(`View ${viewId} could not be computed: ${error.message}`); }),
    });
  }

  private schema(w: Worktree, workspaceId: string): Promise<DbSchemaResult> {
    if (w.schema) return w.schema;
    const scan = extractDbSchema(workspaceId, w.root, this.grammarPath);
    w.schema = scan;
    // Keep the result only while the graph reports changes; otherwise share just the in-flight scan.
    const drop = () => { if (w.schema === scan && w.graph.status().state === 'unavailable') w.schema = null; };
    scan.then(drop, () => { if (w.schema === scan) w.schema = null; });
    return scan;
  }

  private sqlSchema(w: Worktree, workspaceId: string): Promise<DbSchemaResult> {
    if (w.sqlSchema) return w.sqlSchema;
    const scan = extractSqlSchema(workspaceId, w.root);
    w.sqlSchema = scan;
    const drop = () => { if (w.sqlSchema === scan && w.graph.status().state === 'unavailable') w.sqlSchema = null; };
    scan.then(drop, () => { if (w.sqlSchema === scan) w.sqlSchema = null; });
    return scan;
  }

  private worktree(workspaceId: string, root: string): Worktree {
    if (this.released.has(workspaceId)) throw new Error('This workspace is being removed.');
    const existing = this.worktrees.get(workspaceId);
    // Reopening marks the graph recently used and restarts it if the host closed it (open-graph cap, crashed process).
    if (existing) { this.host.open(workspaceId, root); return existing; }
    const graph = this.host.open(workspaceId, root);
    const wt: Worktree = { root, graph, unsubscribe: [], schema: null, sqlSchema: null, pending: null };
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
    if (code.length || rules) {
      for (const v of await listViewFiles(w.root).catch(() => [])) if (affects(v, change.files, code, python, sql)) ids.add(v.summary.id);
    }
    this.queue(workspaceId, w, ids, listChanged);
  }

  private async allViewIds(w: Worktree) {
    return [DATABASE_VIEW.id, ...(await listViewFiles(w.root).catch(() => [])).map(v => v.summary.id)];
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
