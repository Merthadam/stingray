// Main-process proxy for CodeGraph, which runs in a child (codegraph-worker.ts). V8 must compile tree-sitter's grammar wasm
// with --liftoff-only or it may abort the whole process ("Fatal process out of memory: Zone"); the flag only works on the
// command line, so it cannot be applied to Electron's main process.
// Crashes: open graphs turn 'unavailable' and the child is respawned after 1s, 2s, 4s; after more than 3 quick crashes (each
// within 30s of its start) it stays down until an open() 30 s after the last crash (RestartPolicy). A deliberate kill() is
// not a crash. While the child is down, the .stingray watcher reports all files.
import { fork, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ignoredDirs, short } from './stinggraph';
import type { GraphChange, GraphHost, SymbolQuery, WorktreeGraph } from '../../../core/views/graph';
import type { GraphState, GraphStatus } from '../../../../shared/contracts/views';
import type { EvaluateOutput, GraphSymbol, ResolvedView } from '../../../core/views/rules/types';
import { RestartPolicy, type SharedBaseTarget } from '../../../core/stinggraph';
import type { OverlayConflicts } from '@colbymchenry/codegraph';

type Call = { type: 'close'; workspaceId: string } | { type: 'closeAll' } | { type: 'findSymbols'; workspaceId: string; queries: SymbolQuery[] }
  | { type: 'callees'; workspaceId: string; ids: string[] } | { type: 'fileSymbols'; workspaceId: string; file: string }
  | { type: 'evaluateView'; workspaceId: string; root: string; view: ResolvedView }
  | { type: 'conflicts'; shared: SharedBaseTarget; workspaceIds: string[] };
export type WorkerRequest = { type: 'open'; workspaceId: string; root: string; shared?: SharedBaseTarget | null } | (Call & { id: number });
type Reply = { type: 'reply'; id: number; result: (GraphSymbol | null)[] | [string, GraphSymbol[]][] | GraphSymbol[] | EvaluateOutput | OverlayConflicts | null } | { type: 'reply'; id: number; error: string };
export type WorkerEvent =
  | { type: 'status'; workspaceId: string; status: GraphStatus }
  | { type: 'change'; workspaceId: string; files: string[] }
  | Reply;

export interface CodeGraphProcessHostOptions {
  spawn?: () => ChildProcess;
  maxOpen?: number;    // graphs kept open at once; the least recently opened is closed beyond this
  debounceMs?: number; // .stingray watcher
  timeoutMs?: number;  // bound on each request, and on closeAll before the child is killed
  evaluateTimeoutMs?: number; // bound on evaluateView
  /** Shared-base mode for a worktree (codegraph.sharedBase), or null for its full index; asked on every open. */
  sharedBase?: (workspaceId: string) => SharedBaseTarget | null;
  /** Adds .codegraph/ to the repository's info/exclude (driven/git, injected by electron/app). */
  exclude: (root: string) => Promise<void>;
  now?: () => number;      // RestartPolicy clock (tests)
  restartBaseMs?: number;  // backoff unit, default 1000 (tests)
}

export interface CodeGraphProcessHost extends GraphHost {
  /** Conflicts between these worktrees' overlays over the repo's base; null when there is none or the child is down. */
  conflicts(shared: SharedBaseTarget, workspaceIds: string[]): Promise<OverlayConflicts | null>;
  /** Stop the worker now (rule 3 fallback); not counted as a crash. */
  kill(): Promise<void>;
}

const forkWorker = () => fork(path.join(__dirname, 'codegraph-worker.cjs'), [], {
  execPath: process.execPath, execArgv: ['--liftoff-only', '--disable-warning=ExperimentalWarning'],
  // CodeGraph's own opt-outs (telemetry/index.js, upgrade/update-check.js), for the child only so they never reach user terminals.
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1' },
});
const within = (promise: Promise<unknown>, ms: number) => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
};

export function createCodeGraphProcessHost(options: CodeGraphProcessHostOptions): CodeGraphProcessHost {
  const { spawn = forkWorker, maxOpen = 4, debounceMs = 300, timeoutMs = 3000, evaluateTimeoutMs = 30_000, sharedBase = () => null,
    exclude, now, restartBaseMs = 1000 } = options;
  const openRequest = (workspaceId: string, root: string): WorkerRequest => {
    let shared: SharedBaseTarget | null = null;
    try { shared = sharedBase(workspaceId); } catch (error) { console.warn('Code graph shared base setting unreadable:', short(error)); }
    return { type: 'open', workspaceId, root, shared };
  };
  const graphs = new Map<string, ProxyGraph>(); // insertion order = least recently opened first
  const pending = new Map<number, (reply: Reply | 'down') => void>();
  // In-flight info/exclude writes by root: close awaits them so the caller can delete the folder (worktree removal).
  const excluding = new Map<string, Promise<void>>();
  let child: ChildProcess | null = null, nextId = 0, restart: NodeJS.Timeout | undefined;
  const policy = new RestartPolicy({ now });
  const closing = new Map<string, Promise<void>>(); // workspaceId -> in-flight close (views and stinggraph release share it)

  const post = (message: WorkerRequest, to = child) => { try { to?.send(message, () => { /* exit is handled below */ }); } catch { /* channel closed */ } };
  // 'down': no child, or it exited before replying.
  const call = (message: Call, ms: number) => new Promise<Reply | 'down' | 'timeout'>(resolve => {
    if (!child) return resolve('down');
    const id = ++nextId, timer = setTimeout(() => done('timeout'), ms);
    const done = (reply: Reply | 'down' | 'timeout') => { clearTimeout(timer); pending.delete(id); resolve(reply); };
    pending.set(id, done);
    post({ ...message, id });
  });
  const request = async (message: Call) => { const reply = await call(message, timeoutMs); return typeof reply === 'object' && 'result' in reply ? reply.result : undefined; };
  const settleAll = () => { for (const done of [...pending.values()]) done('down'); };

  class ProxyGraph implements WorktreeGraph {
    active = false;
    private current: GraphStatus = { state: 'starting', message: null };
    private changeListeners = new Set<(change: GraphChange) => void>();
    private statusListeners = new Set<(status: GraphStatus) => void>();
    private watcher: FSWatcher | null = null;
    private changed = new Set<string>();
    private timer: NodeJS.Timeout | undefined;
    constructor(readonly workspaceId: string, readonly root: string) {}

    status() { return this.current; }
    onChange(listener: (change: GraphChange) => void) { this.changeListeners.add(listener); return () => { this.changeListeners.delete(listener); }; }
    onStatus(listener: (status: GraphStatus) => void) { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; }
    private ready() { return this.active && (this.current.state === 'ready' || this.current.state === 'read-only'); }
    async findSymbols(queries: SymbolQuery[]) {
      const result = this.ready() && queries.length ? await request({ type: 'findSymbols', workspaceId: this.workspaceId, queries }) : null;
      return Array.isArray(result) && result.length === queries.length ? result as (GraphSymbol | null)[] : queries.map(() => null);
    }
    // A Map does not survive IPC: the child sends [id, callees] entries. No valid reply (timeout, child down) is null: unknown.
    async callees(ids: string[]) {
      if (!ids.length) return new Map<string, GraphSymbol[]>();
      const result = this.ready() ? await request({ type: 'callees', workspaceId: this.workspaceId, ids }) : null;
      if (!Array.isArray(result)) return null;
      const entries = (result as unknown[]).filter((e): e is [string, GraphSymbol[]] => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && Array.isArray(e[1]));
      return new Map(ids.map(id => [id, []] as [string, GraphSymbol[]]).concat(entries));
    }
    async fileSymbols(file: string) {
      const result = this.ready() ? await request({ type: 'fileSymbols', workspaceId: this.workspaceId, file }) : null;
      return Array.isArray(result) ? result as GraphSymbol[] : null;
    }
    async evaluateView(view: ResolvedView) {
      const reply = await call({ type: 'evaluateView', workspaceId: this.workspaceId, root: this.root, view }, evaluateTimeoutMs);
      if (reply === 'timeout') throw new Error('View evaluation timed out');
      if (reply === 'down') throw new Error('Code graph process unavailable');
      if ('error' in reply) throw new Error(reply.error);
      return reply.result as EvaluateOutput;
    }

    start() {
      this.active = true;
      this.setStatus('starting', null);
      // CodeGraph only reports indexed sources; view files and SQL DDL need this watcher too.
      try {
        const watcher = this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
          const file = filename?.toString().replaceAll('\\', '/');
          if (!file || !(file.startsWith('.stingray/') || (/\.sql$/i.test(file) && !file.split('/').some(dir => ignoredDirs.has(dir))) || (!child && !ignoredDirs.has(file.split('/')[0])))) return;
          this.changed.add(file); clearTimeout(this.timer);
          this.timer = setTimeout(() => { const files = [...this.changed]; this.changed.clear(); this.emit(files); }, debounceMs);
        });
        watcher.on('error', () => watcher.close());
      } catch { /* missing root: CodeGraph reports it */ }
    }

    stop(message: string) {
      this.active = false;
      clearTimeout(this.timer); this.changed.clear();
      this.watcher?.close(); this.watcher = null;
      this.setStatus('unavailable', message);
    }

    emit(files: string[]) {
      if (!this.active || !files.length) return;
      for (const listener of this.changeListeners) try { listener({ files }); } catch { /* a listener must not break the host */ }
    }

    setStatus(state: GraphState, message: string | null) {
      if (this.current.state === state && this.current.message === message) return;
      this.current = { state, message };
      for (const listener of this.statusListeners) try { listener(this.current); } catch { /* a listener must not break the host */ }
    }
  }

  const active = () => [...graphs.values()].filter(g => g.active);
  const onEvent = (event: WorkerEvent) => {
    if (event.type === 'reply') return pending.get(event.id)?.(event);
    const graph = graphs.get(event.workspaceId);
    if (!graph?.active) return;
    if (event.type === 'status') graph.setStatus(event.status.state, event.status.message);
    else graph.emit(event.files);
  };

  const exited = (c: ChildProcess, why: string) => {
    if (child !== c) return; // closeAll, kill() or an earlier error already handled it
    child = null; settleAll();
    try { c.kill('SIGKILL'); } catch { /* already gone */ }
    const delay = policy.crashed(active().length > 0);
    const message = `Code graph process stopped (${why}); ${delay !== null ? 'restarting' : 'reopen the view to retry'}.`;
    for (const graph of active()) graph.setStatus('unavailable', message);
    if (delay !== null) restart = setTimeout(() => { restart = undefined; policy.timerFired(); if (!child) respawn(); }, delay / 1000 * restartBaseMs);
  };

  // Start a child and reopen every active graph in it.
  const respawn = () => {
    clearTimeout(restart); restart = undefined;
    let c: ChildProcess;
    try { c = spawn(); } catch (error) {
      for (const graph of active()) graph.setStatus('unavailable', 'Code graph process failed to start: ' + short(error));
      return;
    }
    child = c; policy.started();
    try { if (c.pid) os.setPriority(c.pid, 10); } catch { /* best effort */ }
    c.on('message', onEvent);
    c.on('error', error => exited(c, short(error)));
    c.once('exit', (code, signal) => exited(c, signal ? `signal ${signal}` : `exit code ${code}`));
    for (const graph of active()) post(openRequest(graph.workspaceId, graph.root));
  };

  const evict = (graph: ProxyGraph, message: string) => {
    graph.stop(message);
    return call({ type: 'close', workspaceId: graph.workspaceId }, timeoutMs);
  };

  return {
    open(workspaceId, root) {
      if (!excluding.has(root)) {
        const work = exclude(root).catch(error => console.warn('Could not add .codegraph/ to info/exclude:', short(error)))
          .finally(() => excluding.delete(root));
        excluding.set(root, work);
      }
      let graph = graphs.get(workspaceId);
      if (graph && graph.root !== root) { void evict(graph, 'Worktree moved.'); graph = undefined; }
      graph ??= new ProxyGraph(workspaceId, root);
      graphs.delete(workspaceId); graphs.set(workspaceId, graph);
      if (!graph.active) graph.start();
      if (child) post(openRequest(workspaceId, root)); else if (policy.mayRespawnOnOpen()) respawn();
      let open = active().length;
      for (const other of graphs.values()) if (open > maxOpen && other !== graph && other.active) { void evict(other, 'Closed to limit open code graphs; reopens when viewed.'); open--; }
      return graph;
    },
    // Idempotent: a second close of the same workspace waits for the first. Rejects when a running child does not
    // confirm in time (it may still hold the worktree's files); 'down' means nothing holds them.
    close(workspaceId) {
      const inFlight = closing.get(workspaceId);
      if (inFlight) return inFlight;
      const job = (async () => {
        const graph = graphs.get(workspaceId);
        graphs.delete(workspaceId);
        const reply = graph?.active ? await evict(graph, 'Closed.') : undefined;
        if (graph) await excluding.get(graph.root);
        if (reply === 'timeout') throw new Error(`Code graph did not confirm closing ${workspaceId}.`);
      })().finally(() => closing.delete(workspaceId));
      closing.set(workspaceId, job);
      return job;
    },
    async kill() {
      const c = child;
      if (restart) policy.timerFired(); // a cancelled backoff must not block the next open()
      clearTimeout(restart); restart = undefined;
      if (!c) return;
      child = null; settleAll();
      for (const graph of active()) graph.stop('Code graph process stopped; reopen the view to retry.');
      const gone = new Promise(resolve => { if (c.exitCode !== null || c.signalCode !== null) resolve(null); else c.once('exit', resolve); });
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
      await within(gone, timeoutMs);
      if (c.exitCode === null && c.signalCode === null) throw new Error('Code graph process did not stop.');
    },
    async conflicts(shared, workspaceIds) {
      const reply = await call({ type: 'conflicts', shared, workspaceIds }, evaluateTimeoutMs);
      return typeof reply === 'object' && 'result' in reply ? reply.result as OverlayConflicts | null : null;
    },
    async closeAll() {
      clearTimeout(restart); restart = undefined;
      for (const graph of graphs.values()) graph.stop('Closed.');
      graphs.clear();
      const excluded = within(Promise.all(excluding.values()), timeoutMs); // bounded like the child, so quitting never waits long
      const c = child;
      if (!c) { await excluded; return; }
      child = null; settleAll();
      const gone = new Promise(resolve => { if (c.exitCode !== null || c.signalCode !== null) resolve(null); else c.once('exit', resolve); });
      post({ type: 'closeAll', id: ++nextId }, c); // the worker closes its indexes and exits
      await within(gone, timeoutMs);
      if (c.exitCode === null && c.signalCode === null) { try { c.kill('SIGKILL'); } catch { /* already gone */ } await within(gone, 1000); }
      await excluded;
    },
  };
}
