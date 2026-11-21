import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../electron/git';
import { EventEmitter } from 'node:events';
import { createCodeGraphProcessHost, type WorkerRequest } from '../electron/codegraph-process';
import { serveCodeGraph } from '../electron/codegraph';
import type { EvaluateInput, EvaluateOutput, ResolvedView } from '../electron/views/rules/types';
import type { GraphChange, WorktreeGraph } from '../electron/views/graph';
import type { GraphState, ViewsChangedEvent } from '../src/views';
import { ViewService } from '../electron/views/service';

const worker = path.join(import.meta.dirname, '../electron/codegraph-worker.ts');
async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-codegraph-process-'));
  await git(root, ['init', '-b', 'main']);
  await mkdir(path.join(root, 'app'));
  await writeFile(path.join(root, 'app/models.py'), 'class User:\n    name: str\n');
  return root;
}
const until = <T>(what: string, check: () => T | undefined | false, ms = 30000) => new Promise<T>((resolve, reject) => {
  const started = Date.now();
  const tick = () => { const value = check(); if (value) return resolve(value);
    if (Date.now() - started > ms) return reject(new Error('Timed out waiting for ' + what)); setTimeout(tick, 50); };
  tick();
});
const state = (graph: WorktreeGraph, wanted: GraphState) => until(wanted, () => graph.status().state === wanted || undefined);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const find = async (graph: WorktreeGraph, name: string) => (await graph.findSymbols([{ file: 'app/models.py', name, kinds: ['class'] }]))[0];

test('runs CodeGraph in a --liftoff-only child, forwards changes, recovers from crashes, and kills the child on closeAll', async () => {
  const root = await repo(), children: ChildProcess[] = [];
  // The app forks the built worker with Electron as node; here node runs the TypeScript entry through tsx.
  const host = createCodeGraphProcessHost({ debounceMs: 100, timeoutMs: 3000, spawn: () => {
    const child = fork(worker, [], { execArgv: ['--import', 'tsx', '--liftoff-only', '--disable-warning=ExperimentalWarning'],
      env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1' } });
    children.push(child); return child;
  } });
  try {
    const graph = host.open('w1', root);
    assert.deepEqual(await graph.findSymbols([{ file: 'app/models.py', name: 'User' }]), [null]); // not ready yet
    const seen: GraphChange[] = []; graph.onChange(change => seen.push(change));
    await state(graph, 'ready');
    assert.equal(children.length, 1);
    assert.match(execFileSync('ps', ['-o', 'args=', '-p', String(children[0].pid)], { encoding: 'utf8' }), /--liftoff-only/);
    assert.deepEqual({ ...await find(graph, 'User'), id: undefined }, { id: undefined, name: 'User', kind: 'class', file: 'app/models.py', line: 1, endLine: 2, qualifiedName: 'User' });

    await appendFile(path.join(root, 'app/models.py'), '\nclass Invoice:\n    pass\n');
    await until('models.py change', () => seen.some(c => c.files.includes('app/models.py')));
    assert.ok(await find(graph, 'Invoice'));
    // CodeGraph ignores non-source files; the host's own watcher reports view files.
    await mkdir(path.join(root, '.stingray/views'), { recursive: true });
    await writeFile(path.join(root, '.stingray/views/x.json'), '{}');
    await until('view file change', () => seen.some(c => c.files.includes('.stingray/views/x.json')));

    await writeFile(path.join(root, 'schema.sql'), 'CREATE TABLE watched (id INT);');
    await until('SQL file change with live child', () => seen.some(c => c.files.includes('schema.sql')));

    // A crash turns the graph unavailable, then the host respawns the child on its own.
    children[0].kill('SIGKILL');
    await state(graph, 'unavailable');
    assert.match(graph.status().message ?? '', /Code graph process stopped \(signal SIGKILL\); restarting\./);
    await state(graph, 'ready');
    assert.equal(children.length, 2);
    assert.ok(await find(graph, 'Invoice'));
    // An open() right after a crash respawns immediately.
    children[1].kill('SIGKILL');
    await state(graph, 'unavailable');
    assert.equal(host.open('w1', root), graph);
    assert.equal(children.length, 3);
    await state(graph, 'ready');

    const started = Date.now();
    await host.closeAll();
    assert.ok(Date.now() - started < 4500);
    assert.equal(alive(children[2].pid!), false);
    assert.equal(graph.status().state, 'unavailable');
    assert.deepEqual(await graph.findSymbols([{ file: 'app/models.py', name: 'User' }]), [null]);
    await host.closeAll(); await host.close('w1');
  } finally {
    await host.closeAll();
    for (const child of children) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('a child that cannot start leaves graphs unavailable without throwing', async () => {
  const root = await repo();
  const host = createCodeGraphProcessHost({ spawn: () => { throw new Error('spawn EACCES\nstack'); } });
  try {
    const graph = host.open('w1', root);
    assert.deepEqual(graph.status(), { state: 'unavailable', message: 'Code graph process failed to start: spawn EACCES' });
    assert.deepEqual(await graph.findSymbols([{ file: 'a.py', name: 'A' }]), [null]);
    await host.close('w1'); await host.close('w1');
  } finally { await host.closeAll(); await rm(root, { recursive: true, force: true }); }
});

// The worker's request handling (serveCodeGraph) wired to the proxy through an in-process fake child.
function fakeChild(options: Parameters<typeof serveCodeGraph>[2]) {
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null; signalCode: string | null; send: ChildProcess['send']; kill: () => boolean };
  child.exitCode = null; child.signalCode = null;
  const exit = (signal: string | null) => { if (child.exitCode !== null || child.signalCode !== null) return; child.signalCode = signal; child.exitCode = signal ? null : 0; child.emit('exit', child.exitCode, signal); };
  const worker = serveCodeGraph(event => setImmediate(() => child.emit('message', event)), () => exit(null), options);
  child.send = ((message: WorkerRequest) => { setImmediate(() => worker.handle(message)); return true; }) as ChildProcess['send'];
  child.kill = () => { exit('SIGKILL'); worker.disconnect(); return true; }; // a real dead child takes its watchers with it
  return child as unknown as ChildProcess;
}
const view: ResolvedView = { id: 'v', kind: 'flow', scope: { include: ['**/*'], exclude: [] }, rules: [], graph: null, flowchart: null, builtins: [], include: [], exclude: [] };
const output = (stats: Record<string, number>): EvaluateOutput => ({ groups: [], nodes: [], edges: [], warnings: [], truncated: false, stats,
  diagnostics: { rules: [], graph: null, unresolved: [], limits: { filesScanned: 0, matches: 0, truncated: false }, ms: 0 } });

test('evaluateView round-trips through the worker: result, engine error, timeout, crash mid-request, child down', async () => {
  const root = await repo(), inputs: EvaluateInput[] = [], children: ChildProcess[] = [];
  let behaviour: 'ok' | 'error' | 'hang' = 'ok';
  const evaluate = async (input: EvaluateInput) => {
    inputs.push(input);
    if (behaviour === 'error') throw new Error('query error at line 3\nstack');
    if (behaviour === 'hang') return new Promise<EvaluateOutput>(() => {});
    return output({ files: (await input.files.list()).files.length });
  };
  const host = createCodeGraphProcessHost({ debounceMs: 50, evaluateTimeoutMs: 200, spawn: () => {
    const child = fakeChild({ evaluate, grammarDir: () => '/g', load: () => Promise.reject(new Error('no CodeGraph here')) });
    children.push(child); return child;
  } });
  try {
    const graph = host.open('w1', root);
    await state(graph, 'unavailable');
    assert.deepEqual(await graph.evaluateView(view), output({ files: 1 }));
    assert.deepEqual([inputs[0].view, inputs[0].graph, inputs[0].grammarDir, inputs[0].graphStatus.state], [view, null, '/g', 'unavailable']);

    behaviour = 'error';
    await assert.rejects(graph.evaluateView(view), { message: 'query error at line 3' });
    behaviour = 'hang';
    await assert.rejects(graph.evaluateView(view), { message: 'View evaluation timed out' });
    const crashed = graph.evaluateView(view);
    await new Promise(resolve => setTimeout(resolve, 20));
    children[0].kill('SIGKILL');
    await assert.rejects(crashed, { message: 'Code graph process unavailable' });
    // Down until the backoff respawns it.
    await assert.rejects(graph.evaluateView(view), { message: 'Code graph process unavailable' });
    await until('respawn', () => children.length === 2);

    // A worktree the child has not opened is evaluated without a graph (and not opened for it).
    behaviour = 'ok';
    await host.close('w1');
    const before = inputs.length;
    assert.deepEqual(await graph.evaluateView(view), output({ files: 1 }));
    assert.deepEqual(inputs[before].graphStatus, { state: 'unavailable', message: 'Code graph is not open.' });
  } finally { await host.closeAll(); await rm(root, { recursive: true, force: true }); }
  const down = createCodeGraphProcessHost({ spawn: () => { throw new Error('spawn EACCES'); } });
  await assert.rejects(down.open('w1', root).evaluateView(view), { message: 'Code graph process unavailable' });
  await down.closeAll();
});

test('ViewService computes a rule + graph-step view in the real CodeGraph child', async () => {
  const root = await repo(), children: ChildProcess[] = [];
  await writeFile(path.join(root, 'app/flow.py'), 'def helper():\n    pass\n\ndef run():\n    helper()\n    register("plan")\n\ndef main():\n    run()\n');
  await mkdir(path.join(root, '.stingray/views'), { recursive: true });
  await writeFile(path.join(root, '.stingray/views/flow.yaml'), [
    'version: 1', 'name: Flow', 'kind: flow', 'scope: { include: ["app/**"] }', 'rules:',
    '  - id: step', '    language: python',
    '    query: \'(call function: (identifier) @f (#eq? @f "register") arguments: (argument_list (string (string_content) @name)))\'',
    '    emit: { node: { id: "@name", detail: "in @function", symbol: "@function" } }',
    'graph: { start: [{ symbol: main, file: app/flow.py }], follow: [calls], helpers: show }', ''].join('\n'));
  const host = createCodeGraphProcessHost({ debounceMs: 100, spawn: () => {
    const child = fork(worker, [], { execArgv: ['--import', 'tsx', '--liftoff-only', '--disable-warning=ExperimentalWarning'],
      env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1' } });
    children.push(child); return child;
  } });
  const events: ViewsChangedEvent[] = [];
  const service = new ViewService({ host, grammarPath: path.join(import.meta.dirname, '../electron/tree-sitter-python.wasm'), emit: e => events.push(e), debounceMs: 50 });
  try {
    await service.listViews('w1', root);
    await state(host.open('w1', root), 'ready');
    const result = await service.computeView('w1', root, 'flow');
    assert.equal(result.graph.state, 'ready');
    assert.deepEqual(result.nodes.map(n => [n.id.startsWith('sym:') ? n.label : n.id, n.detail, n.symbol?.name ?? null]).sort(),
      [['helper', null, 'helper'], ['main', null, 'main'], ['plan', 'in run', 'run']]);
    const label = (id: string) => result.nodes.find(n => n.id === id)!.label;
    assert.deepEqual(result.edges.map(e => `${label(e.from)}->${label(e.to)}`).sort(), ['main->plan', 'plan->helper']);
    assert.deepEqual(result.diagnostics!.rules.map(r => [r.rule, r.matches, r.errors.length]), [['view#step', 1, 0]]);
    assert.equal(result.diagnostics!.graph!.error, null);

    await appendFile(path.join(root, 'app/flow.py'), '\ndef other():\n    register("act")\n');
    await until('flow re-queued', () => events.some(e => e.viewIds.includes('flow')));
    assert.ok((await service.computeView('w1', root, 'flow')).nodes.some(n => n.id === 'act'));
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});
