import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../electron/git';
import { createCodeGraphHost } from '../electron/codegraph';
import { runGraphStep } from '../electron/views/rules/graph-steps';
import type { EvaluateInput, EvaluateOutput, ResolvedView } from '../electron/views/rules/types';
import type { WorktreeGraph } from '../electron/views/graph';
import type { GraphState } from '../src/views';

process.env.CODEGRAPH_TELEMETRY = '0'; process.env.CODEGRAPH_NO_UPDATE_CHECK = '1';

async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-codegraph-api-'));
  await git(root, ['init', '-b', 'main']);
  await mkdir(path.join(root, 'app'));
  await writeFile(path.join(root, 'app/flow.py'),
    'def slug(x):\n    return x\n\n\ndef a():\n    return slug(1)\n\n\ndef b():\n    return slug(2)\n\n\ndef main():\n    a()\n    b()\n');
  return root;
}
const until = (what: string, check: () => boolean, ms = 30000) => new Promise<void>((resolve, reject) => {
  const started = Date.now();
  const tick = () => { if (check()) return resolve();
    if (Date.now() - started > ms) return reject(new Error('Timed out waiting for ' + what)); setTimeout(tick, 50); };
  tick();
});
const state = (graph: WorktreeGraph, wanted: GraphState) => until(wanted, () => graph.status().state === wanted);
const view: ResolvedView = { id: 'v', kind: 'flow', scope: { include: ['**/*'], exclude: [] }, rules: [], graph: null, flowchart: null, builtins: [], include: [], exclude: [] };
const output = (stats: Record<string, number> = {}): EvaluateOutput => ({ groups: [], nodes: [], edges: [], warnings: [], truncated: false, stats,
  diagnostics: { rules: [], graph: null, unresolved: [], limits: { filesScanned: 0, matches: 0, truncated: false }, ms: 0 } });

test('evaluateView hands the engine a CodeGraph-backed GraphApi and the worktree files once the graph is ready', async () => {
  const root = await repo(), inputs: EvaluateInput[] = [];
  const host = createCodeGraphHost({ debounceMs: 100, grammarDir: () => '/grammars', evaluate: async input => { inputs.push(input); return output({ n: inputs.length }); } });
  try {
    const graph = host.open('w1', root);
    await state(graph, 'ready');
    assert.deepEqual(await graph.evaluateView(view), output({ n: 1 }));
    const [input] = inputs;
    assert.equal(input.view, view);
    assert.equal(input.grammarDir, '/grammars');
    assert.deepEqual(input.graphStatus, { state: 'ready', message: null });
    assert.ok((await input.files.list()).files.includes('app/flow.py'));
    assert.match((await input.files.read('app/flow.py'))!, /def main/);

    const api = input.graph!;
    const [main] = api.findSymbols('main', 'app/flow.py');
    assert.deepEqual({ ...main, id: undefined }, { id: undefined, name: 'main', kind: 'function', file: 'app/flow.py', line: 13 });
    assert.deepEqual(api.findSymbols('main').map(s => s.id), [main.id]);
    assert.deepEqual(api.findSymbols('main', 'other.py'), []);
    const calls = api.outgoing([main.id], ['calls']);
    const names = (ids: string[]) => [...api.symbols(ids).values()].map(s => s.name).sort();
    assert.deepEqual(names(calls.map(r => r.to)), ['a', 'b']);
    assert.ok(calls.every(r => r.kind === 'calls' && r.certain && r.line !== null && r.from === main.id));
    const [slug] = api.findSymbols('slug');
    assert.deepEqual(names(api.incoming([slug.id], ['calls']).map(r => r.from)), ['a', 'b']);
    assert.deepEqual(api.outgoing([], ['calls']), []);
    assert.deepEqual(api.symbols(['missing']).size, 0);

    // End to end: main -> a, b; slug has fan-in 2 and no callees, so it collapses into a and b.
    const out = runGraphStep({ start: [{ symbol: 'main' }], follow: ['calls'], direction: 'out', depth: 3, helpers: 'collapse' }, api, () => true);
    assert.deepEqual(out.nodes.map(n => [n.label, n.fields.map(f => f.label)]), [['main', []], ['a', ['slug']], ['b', ['slug']]]);
    assert.equal(out.edges.length, 2);
  } finally { await host.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test('evaluateView runs without a graph (null) when CodeGraph is unavailable, and surfaces engine errors', async () => {
  const root = await repo(), inputs: EvaluateInput[] = [];
  let fail = false;
  const host = createCodeGraphHost({ debounceMs: 100, load: () => Promise.reject(new Error('no native module')), grammarDir: () => '/g',
    evaluate: async input => { if (fail) throw new Error('bad rule'); inputs.push(input); return output(); } });
  try {
    const graph = host.open('w1', root);
    await state(graph, 'unavailable');
    await graph.evaluateView(view);
    assert.equal(inputs[0].graph, null);
    assert.equal(inputs[0].graphStatus.state, 'unavailable');
    fail = true;
    await assert.rejects(graph.evaluateView(view), /bad rule/);
  } finally { await host.closeAll(); await rm(root, { recursive: true, force: true }); }
});
