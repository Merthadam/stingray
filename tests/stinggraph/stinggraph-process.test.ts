import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../../electron/app/wiring/git';
import { EventEmitter } from 'node:events';
import { createCodeGraphProcessHost, serveCodeGraph, type WorkerRequest } from '../../electron/app/wiring/stinggraph';
import type { EvaluateInput, EvaluateOutput, ResolvedView } from '../../electron/core/views/rules/types';
import type { GraphChange, WorktreeGraph } from '../../electron/core/views/graph';
import type { GraphState, ViewsChangedEvent } from '../../shared/contracts/views';
import { ViewService } from '../../electron/app/wiring/views';
import { releaseWorkspace } from '../../electron/core/stinggraph';

const worker = path.join(import.meta.dirname, '../../electron/app/stinggraph-worker.ts');
async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-codegraph-process-'));
  await git(root, ['init', '-b', 'main']);
  await mkdir(path.join(root, 'app'));
  await writeFile(path.join(root, 'app/models.py'), 'class User:\n    name: str\n\n\ndef helper():\n    return 1\n\n\ndef run():\n    return helper()\n');
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
    assert.equal(await graph.callees(['x']), null); // unknown, not "calls nothing"
    assert.equal(await graph.fileSymbols('app/models.py'), null);
    const seen: GraphChange[] = []; graph.onChange(change => seen.push(change));
    await state(graph, 'ready');
    assert.equal(children.length, 1);
    assert.match(execFileSync('ps', ['-o', 'args=', '-p', String(children[0].pid)], { encoding: 'utf8' }), /--liftoff-only/);
    assert.deepEqual({ ...await find(graph, 'User'), id: undefined }, { id: undefined, name: 'User', kind: 'class', file: 'app/models.py', line: 1, endLine: 2, qualifiedName: 'User' });
    // callees and fileSymbols round-trip through the child (the Map travels as entries)
    const [run, helper] = await graph.findSymbols([{ file: 'app/models.py', name: 'run' }, { file: 'app/models.py', name: 'helper' }]);
    const callees = (await graph.callees([run!.id, helper!.id, 'missing']))!;
    assert.deepEqual([...callees].map(([id, list]) => [id, list.map(s => s.name)]), [[run!.id, ['helper']], [helper!.id, []], ['missing', []]]);
    assert.deepEqual((await graph.fileSymbols('app/models.py'))!.filter(s => s.kind === 'function').map(s => s.name).sort(), ['helper', 'run']);

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
    // An open() right after a crash does not spawn; the backoff timer respawns once and the graph reopens.
    children[1].kill('SIGKILL');
    await state(graph, 'unavailable');
    assert.equal(host.open('w1', root), graph);
    assert.equal(children.length, 2, 'open() during the backoff does not spawn');
    await state(graph, 'ready');
    assert.equal(children.length, 3, 'the backoff timer respawned exactly once');

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
    // close waits for open()'s info/exclude write, so the caller may delete the folder right after.
    assert.match(await readFile(path.join(root, '.git/info/exclude'), 'utf8'), /^\/\.codegraph\/$/m);
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

test('callees and fileSymbols are null (unknown) when the child times out or is down; malformed callee entries are dropped', async () => {
  let reply: ((message: WorkerRequest & { id: number }) => unknown) | null = null; // null: never answer
  const spawn = () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: null; signalCode: null; send: ChildProcess['send']; kill: () => boolean };
    child.exitCode = null; child.signalCode = null; child.kill = () => true;
    child.send = ((message: WorkerRequest) => {
      setImmediate(() => {
        if (message.type === 'open') child.emit('message', { type: 'status', workspaceId: message.workspaceId, status: { state: 'ready', message: null } });
        else if (reply) child.emit('message', { type: 'reply', id: message.id, result: reply(message) });
      });
      return true;
    }) as ChildProcess['send'];
    return child as unknown as ChildProcess;
  };
  const host = createCodeGraphProcessHost({ timeoutMs: 50, spawn });
  try {
    const graph = host.open('w1', '/repo');
    await state(graph, 'ready');
    assert.equal(await graph.callees(['a']), null);
    assert.equal(await graph.fileSymbols('a.py'), null);
    reply = () => [['a'], 'x', ['a', [{ id: 'b', name: 'b', kind: 'function', file: 'b.py', line: 1 }]]];
    assert.deepEqual([...(await graph.callees(['a', 'c']))!].map(([id, list]) => [id, list.map(s => s.id)]), [['a', ['b']], ['c', []]]);
  } finally { await host.closeAll(); }
  const down = createCodeGraphProcessHost({ spawn: () => { throw new Error('spawn EACCES'); } });
  assert.equal(await down.open('w1', '/repo').callees(['a']), null);
  assert.equal(await down.open('w1', '/repo').fileSymbols('a.py'), null);
  await down.closeAll();
});

test('ViewService computes a rule + graph-step view in the real CodeGraph child', async () => {
  const root = await repo(), children: ChildProcess[] = [];
  await writeFile(path.join(root, 'app/models.py'), 'def helper():\n    pass\n\ndef run():\n    helper()\n    register("plan")\n\ndef main():\n    run()\n');
  await mkdir(path.join(root, '.stingray/views'), { recursive: true });
  await writeFile(path.join(root, '.stingray/views/flow.yaml'), [
    'version: 1', 'name: Flow', 'kind: flow', 'scope: { include: ["app/**"] }', 'rules:',
    '  - id: step', '    language: python',
    '    query: \'(call function: (identifier) @f (#eq? @f "register") arguments: (argument_list (string (string_content) @name)))\'',
    '    emit: { node: { id: "@name", detail: "in @function", symbol: "@function" } }',
    'graph: { start: [{ symbol: main, file: app/models.py }], follow: [calls], helpers: show }', ''].join('\n'));
  const host = createCodeGraphProcessHost({ debounceMs: 100, spawn: () => {
    const child = fork(worker, [], { execArgv: ['--import', 'tsx', '--liftoff-only', '--disable-warning=ExperimentalWarning'],
      env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1' } });
    children.push(child); return child;
  } });
  const events: ViewsChangedEvent[] = [];
  const service = new ViewService({ host, grammarPath: path.join(import.meta.dirname, '../../electron/adapters/driven/tree-sitter/tree-sitter-python.wasm'), emit: e => events.push(e), debounceMs: 50 });
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

    await appendFile(path.join(root, 'app/models.py'), '\ndef other():\n    register("act")\n');
    await until('flow re-queued', () => events.some(e => e.viewIds.includes('flow')));
    assert.ok((await service.computeView('w1', root, 'flow')).nodes.some(n => n.id === 'act'));
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('crash limit: after more than 3 quick crashes open() does not spawn until 30 s after the last crash', async () => {
  let now = 1_000_000;
  const children: (EventEmitter & { pid: number; send(): boolean; kill(): boolean; exitCode: null; signalCode: null })[] = [];
  const spawn = () => {
    const child = Object.assign(new EventEmitter(), { pid: 0, exitCode: null, signalCode: null, send: () => true, kill: () => true });
    children.push(child); return child as never;
  };
  const host = createCodeGraphProcessHost({ spawn, now: () => now, restartBaseMs: 5, timeoutMs: 50, exclude: async () => {} });
  try {
    host.open('w1', '/tmp/does-not-matter');
    for (let i = 0; i < 4; i++) { children.at(-1)!.emit('exit', null, 'SIGKILL'); await new Promise(r => setTimeout(r, 60)); }
    const count = children.length;
    host.open('w1', '/tmp/does-not-matter');
    assert.equal(children.length, count, 'limit reached: no spawn within 30 s');
    now += 30_001;
    host.open('w1', '/tmp/does-not-matter');
    assert.equal(children.length, count + 1);
  } finally { await host.closeAll(); }
});

test('kill() stops the worker without counting a crash; the next open() respawns', async () => {
  const children: (EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null; send(): boolean; kill(): boolean })[] = [];
  const spawn = () => {
    const child: any = Object.assign(new EventEmitter(), { pid: 0, exitCode: null, signalCode: null, send: () => true });
    child.kill = () => { child.signalCode = 'SIGKILL'; setImmediate(() => child.emit('exit', null, 'SIGKILL')); return true; };
    children.push(child); return child;
  };
  const host = createCodeGraphProcessHost({ spawn, timeoutMs: 50, exclude: async () => {} });
  try {
    const graph = host.open('w1', '/tmp/does-not-matter');
    await host.kill();
    assert.equal(graph.status().state, 'unavailable');
    host.open('w1', '/tmp/does-not-matter');
    assert.equal(children.length, 2);
  } finally { await host.closeAll(); }
});

test('a running child that never confirms close: close() rejects, kill() succeeds, the stinggraph release lets removal proceed', async () => {
  const children: (EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null; send(): boolean; kill(): boolean })[] = [];
  const spawn = () => {
    const child: any = Object.assign(new EventEmitter(), { pid: 0, exitCode: null, signalCode: null, send: () => true });
    child.kill = () => { child.signalCode = 'SIGKILL'; setImmediate(() => child.emit('exit', null, 'SIGKILL')); return true; };
    children.push(child); return child;
  };
  const host = createCodeGraphProcessHost({ spawn, timeoutMs: 50, exclude: async () => {} });
  try {
    host.open('w1', '/tmp/does-not-matter');
    await assert.rejects(host.close('w1'), /did not confirm closing w1/);
    host.open('w1', '/tmp/does-not-matter');
    const logged: string[] = [];
    await releaseWorkspace(host, 'w1', message => { logged.push(message); });
    assert.equal(children[0].signalCode, 'SIGKILL', 'the worker was killed');
    assert.deepEqual(logged, ['Code graph release failed; stopping the worker:']);
  } finally { await host.closeAll(); }
});

test('kill() never counts toward the crash limit: open() still spawns after repeated kills', async () => {
  const children: EventEmitter[] = [];
  const spawn = () => {
    const child: any = Object.assign(new EventEmitter(), { pid: 0, exitCode: null, signalCode: null, send: () => true });
    child.kill = () => { child.signalCode = 'SIGKILL'; setImmediate(() => child.emit('exit', null, 'SIGKILL')); return true; };
    children.push(child); return child;
  };
  const host = createCodeGraphProcessHost({ spawn, timeoutMs: 50, exclude: async () => {} });
  try {
    host.open('w1', '/tmp/does-not-matter');
    for (let i = 0; i < 4; i++) { await host.kill(); host.open('w1', '/tmp/does-not-matter'); }
    assert.equal(children.length, 5);
  } finally { await host.closeAll(); }
});

test('a child that survives kill() stays tracked and is SIGKILLed again by closeAll', async () => {
  const kills: number[] = [];
  const children: EventEmitter[] = [];
  const spawn = () => {
    const index = children.length;
    const child: any = Object.assign(new EventEmitter(), { pid: 0, exitCode: null, signalCode: null, send: () => true });
    child.kill = () => { kills.push(index); return true; }; // ignores the signal
    children.push(child); return child;
  };
  const host = createCodeGraphProcessHost({ spawn, timeoutMs: 20, exclude: async () => {} });
  host.open('w1', '/tmp/does-not-matter');
  await assert.rejects(host.kill(), /did not stop/);
  host.open('w1', '/tmp/does-not-matter');
  assert.equal(children.length, 2, 'the next open() spawns a new worker');
  kills.length = 0;
  await host.closeAll();
  assert.ok(kills.includes(0), 'the stuck worker is killed again at quit');
});

test('closeAll during a restart backoff does not block the next open()', async () => {
  const children: EventEmitter[] = [];
  const spawn = () => {
    const child: any = Object.assign(new EventEmitter(), { pid: 0, exitCode: null, signalCode: null, send: () => true });
    child.kill = () => { child.signalCode = 'SIGKILL'; setImmediate(() => child.emit('exit', null, 'SIGKILL')); return true; };
    children.push(child); return child;
  };
  const host = createCodeGraphProcessHost({ spawn, timeoutMs: 20, restartBaseMs: 60_000, exclude: async () => {} });
  try {
    host.open('w1', '/tmp/does-not-matter');
    children[0].emit('exit', null, 'SIGKILL'); // crash: restart pending for a minute
    await host.closeAll();
    host.open('w1', '/tmp/does-not-matter');
    assert.equal(children.length, 2);
  } finally { await host.closeAll(); }
});

test('close() after a reopen during an in-flight close closes the new graph', async () => {
  const spawn = () => {
    const child: any = Object.assign(new EventEmitter(), { pid: 0, exitCode: null, signalCode: null });
    child.send = (message: WorkerRequest) => {
      if (message.type === 'close') setTimeout(() => child.emit('message', { type: 'reply', id: message.id, result: null }), 20);
      return true;
    };
    child.kill = () => { child.signalCode = 'SIGKILL'; setImmediate(() => child.emit('exit', null, 'SIGKILL')); return true; };
    return child;
  };
  const host = createCodeGraphProcessHost({ spawn, timeoutMs: 500, exclude: async () => {} });
  try {
    host.open('w1', '/tmp/does-not-matter');
    const first = host.close('w1');
    const reopened = host.open('w1', '/tmp/does-not-matter');
    assert.equal(reopened.status().state, 'starting');
    const second = host.close('w1');
    assert.notEqual(second, first);
    await Promise.all([first, second]);
    assert.deepEqual(reopened.status(), { state: 'unavailable', message: 'Closed.' });
    assert.notEqual(host.close('w1'), second, 'a settled close is not reused');
  } finally { await host.closeAll(); }
});
