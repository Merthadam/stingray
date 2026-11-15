// CodeGraph (https://github.com/colbymchenry/codegraph) embedded as a library: one index per worktree in <root>/.codegraph/.
// The app runs this host in codegraph-worker.ts (a node child with --liftoff-only), never in Electron's main process.
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { CodeGraph } from '@colbymchenry/codegraph';
import type { GraphChange, GraphHost, SymbolQuery, WorktreeGraph } from './views/graph';
import type { GraphState, GraphStatus, SymbolRef } from '../src/views';
import type { Evaluate, ResolvedView } from './views/rules/types';
import type { WorkerEvent, WorkerRequest } from './codegraph-process';
import { evaluate } from './views/rules/engine';
import { codegraphGrammarDir } from './views/rules/grammars';
import { createFileProvider } from './views/rules/files';
import { createGraphApi } from './views/rules/codegraph-api';

type CodeGraphLibrary = typeof import('@colbymchenry/codegraph');
export interface CodeGraphHostOptions {
  maxOpen?: number;      // open graphs (DB + watcher) kept at once; the least recently opened is closed beyond this
  debounceMs?: number;
  pollMs?: number;       // read-only mode: how often the index revision is checked
  load?: () => Promise<CodeGraphLibrary>;
  evaluate?: Evaluate;
  grammarDir?: () => string;
}
type Settings = Required<CodeGraphHostOptions>;
const defaults = { maxOpen: 4, debounceMs: 500, pollMs: 2000, load: loadCodeGraph, evaluate, grammarDir: codegraphGrammarDir };

// Views evaluate without a graph too (graph null), e.g. while indexing or when the index is unavailable.
const evaluateView = async (options: Settings, root: string, view: ResolvedView, cg: CodeGraph | null, graphStatus: GraphStatus) =>
  options.evaluate({ view, files: createFileProvider(root), graph: cg ? createGraphApi(cg) : null, graphStatus, grammarDir: options.grammarDir() });

let library: Promise<CodeGraphLibrary> | undefined;
function loadCodeGraph() {
  // CommonJS re-export of the platform bundle: Node's ESM loader exposes it only as `default`; esbuild's interop copies the names.
  return library ??= import('@colbymchenry/codegraph').then(m => ('CodeGraph' in m ? m : (m as unknown as { default: CodeGraphLibrary }).default));
}

export const ignoredDirs = new Set(['.git', '.codegraph', 'node_modules']);
const posix = (file: string) => file.replaceAll('\\', '/');
export const short = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 200);
const isLockError = (lib: CodeGraphLibrary, error: unknown) => error instanceof lib.LockUnavailableError || /locked by another process|file lock/i.test(short(error));

class Graph implements WorktreeGraph {
  private current: GraphStatus = { state: 'starting', message: null };
  private changeListeners = new Set<(change: GraphChange) => void>();
  private statusListeners = new Set<(status: GraphStatus) => void>();
  private cg: CodeGraph | null = null;
  private stoppers: (() => unknown)[] = [];
  private abort: AbortController | null = null;
  private task: Promise<void>;
  failedAt = 0; // last fallback; open() retries after a while
  // `after`: teardown of a previous graph on the same root, so two never hold its writer lock at once.
  constructor(readonly workspaceId: string, readonly root: string, private options: Settings, after: Promise<unknown> = Promise.resolve()) {
    this.task = after.then(() => {}, () => {});
  }

  get running() { return this.abort !== null; }
  status() { return this.current; }
  onChange(listener: (change: GraphChange) => void) { this.changeListeners.add(listener); return () => { this.changeListeners.delete(listener); }; }
  onStatus(listener: (status: GraphStatus) => void) { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; }
  async findSymbols(queries: SymbolQuery[]): Promise<(SymbolRef | null)[]> {
    const cg = this.cg, ready = this.current.state === 'ready' || this.current.state === 'read-only';
    const files = new Map<string, ReturnType<CodeGraph['getNodesInFile']>>();
    return queries.map(({ file, name, kinds }) => {
      if (!cg || !ready) return null;
      try {
        const nodes = files.get(file) ?? files.set(file, cg.getNodesInFile(posix(file))).get(file)!;
        const node = nodes.find(n => n.name === name && (!kinds?.length || kinds.includes(n.kind)));
        return node ? { id: node.id, name: node.name, kind: node.kind, file: node.filePath, line: node.startLine } : null;
      } catch { return null; }
    });
  }

  evaluateView(view: ResolvedView) {
    const ready = this.current.state === 'ready' || this.current.state === 'read-only';
    return evaluateView(this.options, this.root, view, ready ? this.cg : null, this.current);
  }

  start() {
    const abort = this.abort = new AbortController();
    this.setStatus('starting', null);
    this.task = this.task.then(() => this.run(abort.signal)).catch(error => { if (!abort.signal.aborted) this.fallback(error); });
  }

  stop(message: string) {
    if (this.abort) { this.abort.abort(); this.abort = null; }
    this.setStatus('unavailable', message);
    // Queued behind the run, so a later start() only begins after this teardown.
    return this.task = this.task.then(async () => {
      for (const stop of this.stoppers.splice(0)) try { await stop(); } catch { /* already stopped */ }
      try { this.cg?.close(); } catch { /* already closed */ }
      this.cg = null;
    });
  }

  private async run(signal: AbortSignal) {
    let lib: CodeGraphLibrary;
    try { lib = await this.options.load(); } catch (error) { if (!signal.aborted) this.fallback(error); return; }
    if (signal.aborted) return;
    // CodeGraph.init would recreate a removed worktree folder.
    if (!existsSync(this.root)) throw new Error('Worktree folder is missing.');
    let readOnly = false;
    if (!lib.CodeGraph.isInitialized(this.root)) {
      this.setStatus('indexing', null);
      this.cg = await lib.CodeGraph.init(this.root);
      if (signal.aborted) return;
      const result = await this.cg.indexAll({ signal });
      readOnly = !result.success && result.errors.some(e => isLockError(lib, e.message));
    } else {
      this.cg = await lib.CodeGraph.open(this.root);
      if (signal.aborted) return;
      this.setStatus('indexing', null);
      try { await this.cg.sync({ signal }); } catch (error) { if (!isLockError(lib, error)) throw error; readOnly = true; }
    }
    if (signal.aborted) return;
    if (readOnly) return this.followReadOnly(lib, signal);
    const cg = this.cg, sync = cg.sync.bind(cg);
    let syncing: Promise<unknown> = Promise.resolve();
    // watch() only reports counts, so wrap the sync it calls to learn which files (including deleted ones) changed.
    cg.sync = async (options = {}) => {
      const before = options.paths ? null : new Set(cg.getFiles().map(f => f.path));
      const running = sync(options); syncing = running.catch(() => {});
      const result = await running;
      if (result.filesAdded + result.filesModified + result.filesRemoved > 0) {
        if (before) for (const f of cg.getFiles()) before.delete(f.path);
        this.emit([...options.paths ?? [], ...result.changedFilePaths ?? [], ...before ?? []]);
      }
      return result;
    };
    cg.watch({ debounceMs: this.options.debounceMs, onSyncError: () => { /* the watcher retries on its own */ } });
    // Let an in-flight sync finish before the DB is closed under it.
    this.stoppers.push(() => { cg.unwatch(); return syncing; });
    this.setStatus('ready', null);
  }

  // Another process (e.g. a CodeGraph MCP daemon) writes this index: read it and follow its revisions.
  private async followReadOnly(lib: CodeGraphLibrary, signal: AbortSignal) {
    this.cg?.close(); this.cg = null;
    const cg = this.cg = await lib.CodeGraph.open(this.root, { readOnly: true });
    if (signal.aborted) return;
    let revision = cg.getIndexRevision();
    // The writer lock is only held while the other process syncs; once it is free (or its owner died), become the writer again.
    const lockFree = () => {
      try { const pid = Number(readFileSync(path.join(this.root, '.codegraph', 'codegraph.lock'), 'utf8').trim()); process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    };
    const timer = setInterval(() => {
      if (lockFree()) {
        clearInterval(timer);
        this.task = this.task.then(async () => {
          if (signal.aborted) return;
          try { cg.close(); } catch { /* already closed */ }
          if (this.cg === cg) this.cg = null;
          await this.run(signal);
        }).catch(error => { if (!signal.aborted) this.fallback(error); });
        return;
      }
      try {
        cg.dropReadCaches();
        const next = cg.getIndexRevision();
        if (next.lastIndexedAt === revision.lastIndexedAt && next.fileCount === revision.fileCount) return;
        const { paths } = cg.getFilesIndexedSince(revision.lastIndexedAt ?? 0, 10000);
        revision = next;
        this.emit(paths);
      } catch { /* the writer may be mid-rebuild; retry on the next tick */ }
    }, this.options.pollMs);
    this.stoppers.push(() => clearInterval(timer));
    this.setStatus('read-only', 'Another CodeGraph process is updating this index.');
  }

  // Without a usable graph, still report file changes so views can recompute.
  private fallback(error: unknown) {
    try { this.cg?.close(); } catch { /* not open */ }
    this.cg = null; this.failedAt = Date.now();
    this.setStatus('unavailable', 'Code graph unavailable: ' + short(error));
    const pending = new Set<string>(); let timer: NodeJS.Timeout | undefined;
    let watcher: FSWatcher;
    try {
      watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const file = posix(filename.toString());
        if (ignoredDirs.has(file.split('/')[0])) return;
        pending.add(file); clearTimeout(timer);
        timer = setTimeout(() => { const files = [...pending]; pending.clear(); this.emit(files); }, this.options.debounceMs);
      });
      watcher.on('error', () => watcher.close());
    } catch { return; }
    this.stoppers.push(() => { clearTimeout(timer); watcher.close(); });
  }

  private emit(files: string[]) {
    const change = { files: [...new Set(files.map(posix))] };
    if (!change.files.length) return;
    for (const listener of this.changeListeners) try { listener(change); } catch { /* a listener must not break the host */ }
  }

  private setStatus(state: GraphState, message: string | null) {
    if (this.current.state === state && this.current.message === message) return;
    this.current = { state, message };
    for (const listener of this.statusListeners) try { listener(this.current); } catch { /* a listener must not break the host */ }
  }
}

export function createCodeGraphHost(options: CodeGraphHostOptions = {}): GraphHost {
  const settings = { ...defaults, ...options };
  const graphs = new Map<string, Graph>(); // insertion order = least recently opened first
  const closing = new Map<string, Promise<unknown>>(); // root -> teardown of a graph removed from `graphs`
  const stop = (graph: Graph, message: string) => graph.stop(message).catch(() => { /* never throws */ });
  const retire = (graph: Graph, message: string) => {
    const done = stop(graph, message);
    closing.set(graph.root, done);
    void done.then(() => { if (closing.get(graph.root) === done) closing.delete(graph.root); });
    return done;
  };
  return {
    open(workspaceId, root) {
      let graph = graphs.get(workspaceId);
      if (graph && graph.root !== root) { void retire(graph, 'Worktree moved.'); graph = undefined; }
      graph ??= new Graph(workspaceId, root, settings, closing.get(root));
      graphs.delete(workspaceId); graphs.set(workspaceId, graph);
      // A graph that fell back (e.g. transient open error) is retried, at most every 30s.
      if (graph.running && graph.failedAt && Date.now() - graph.failedAt > 30_000) { graph.failedAt = 0; void stop(graph, 'Retrying.'); }
      if (!graph.running) graph.start();
      let open = [...graphs.values()].filter(g => g.running).length;
      for (const other of graphs.values()) if (open > settings.maxOpen && other !== graph && other.running) { void stop(other, 'Closed to limit open code graphs; reopens when viewed.'); open--; }
      return graph;
    },
    async close(workspaceId) {
      const graph = graphs.get(workspaceId);
      graphs.delete(workspaceId);
      if (graph) await retire(graph, 'Closed.');
    },
    async closeAll() {
      const all = [...graphs.values()]; graphs.clear();
      await Promise.all(all.map(graph => retire(graph, 'Closed.')));
    },
  };
}

/** The CodeGraph child's request handling (codegraph-worker.ts wires it to process IPC). One host serves all worktrees. */
export function serveCodeGraph(send: (event: WorkerEvent) => void, exit: () => void, options: CodeGraphHostOptions = {}) {
  const settings = { ...defaults, ...options };
  const host = createCodeGraphHost({ ...settings, maxOpen: Infinity }); // the parent owns the open/LRU policy
  const graphs = new Map<string, { graph: WorktreeGraph; unsubscribe: () => void }>();
  const detach = (workspaceId: string) => { graphs.get(workspaceId)?.unsubscribe(); graphs.delete(workspaceId); };
  return {
    handle(message: WorkerRequest) {
      switch (message.type) {
        case 'open': {
          const { workspaceId } = message, graph = host.open(workspaceId, message.root);
          if (graphs.get(workspaceId)?.graph !== graph) {
            detach(workspaceId);
            const offChange = graph.onChange(change => send({ type: 'change', workspaceId, files: change.files }));
            const offStatus = graph.onStatus(status => send({ type: 'status', workspaceId, status }));
            graphs.set(workspaceId, { graph, unsubscribe: () => { offChange(); offStatus(); } });
          }
          return send({ type: 'status', workspaceId, status: graph.status() });
        }
        case 'findSymbols': {
          const graph = graphs.get(message.workspaceId)?.graph;
          return void (graph ? graph.findSymbols(message.queries) : Promise.resolve(message.queries.map(() => null)))
            .then(result => send({ type: 'reply', id: message.id, result }));
        }
        case 'evaluateView': {
          // A graph that is not open here is not opened (or indexed) for this: the view is evaluated without it.
          const graph = graphs.get(message.workspaceId)?.graph;
          const running = graph?.root === message.root ? graph.evaluateView(message.view)
            : evaluateView(settings, message.root, message.view, null, { state: 'unavailable', message: 'Code graph is not open.' });
          return void running.then(result => send({ type: 'reply', id: message.id, result }), error => send({ type: 'reply', id: message.id, error: short(error) }));
        }
        case 'close':
          detach(message.workspaceId); // the parent reports its own status for closed graphs
          return void host.close(message.workspaceId).finally(() => send({ type: 'reply', id: message.id, result: null }));
        case 'closeAll':
          for (const id of [...graphs.keys()]) detach(id);
          return void host.closeAll().finally(() => { send({ type: 'reply', id: message.id, result: null }); exit(); });
      }
    },
    // The parent quit or crashed: close the indexes (and their writer locks) instead of lingering.
    // Bounded: an index run that ignores its abort must not keep the writer lock for long.
    disconnect() { setTimeout(exit, 3000).unref(); void host.closeAll().finally(exit); },
  };
}
