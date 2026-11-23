import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../../electron/app/wiring/git';
import { createCodeGraphHost } from '../../electron/app/wiring/stinggraph';
import { runGraphStep } from '../../electron/core/views/rules/graph-steps';
import { docstringSummary } from '../../electron/core/views/explanation';
import type { EvaluateInput, EvaluateOutput, ResolvedView } from '../../electron/core/views/rules/types';
import type { WorktreeGraph } from '../../electron/core/views/graph';
import type { GraphState } from '../../shared/contracts/views';

process.env.CODEGRAPH_TELEMETRY = '0'; process.env.CODEGRAPH_NO_UPDATE_CHECK = '1';

async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-codegraph-api-'));
  await git(root, ['init', '-b', 'main']);
  await mkdir(path.join(root, 'app'));
  await writeFile(path.join(root, 'app/flow.py'),
    'def slug(x):\n    return x\n\n\ndef a():\n    return slug(1)\n\n\ndef b():\n    return slug(2)\n\n\ndef main():\n    a()\n    b()\n');
  await writeFile(path.join(root, 'app/doc.py'), 'def documented():\n    """Accept a token.\n\n    More.\n    """\n    return 1\n\n\nclass Store:\n    def get(self):\n        return 1\n');
  await writeFile(path.join(root, 'app/doc.ts'), '/**\n * Reconcile the email.\n * @param x the x\n */\nexport function reconcile(x: number) { return x }\n');
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
    assert.deepEqual({ ...main, id: undefined }, { id: undefined, name: 'main', kind: 'function', file: 'app/flow.py', line: 13, endLine: 15, qualifiedName: 'main' });
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
    // docstrings (Python and JSDoc) are carried through for node explanations; symbols without one have no field
    assert.equal(docstringSummary(api.findSymbols('documented')[0].docstring), 'Accept a token.');
    assert.equal(docstringSummary(api.findSymbols('reconcile')[0].docstring), 'Reconcile the email.');
    assert.ok(!('docstring' in main));
    assert.equal(api.findSymbols('get', 'app/doc.py')[0].qualifiedName, 'Store::get'); // the explain fingerprint key

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

test('GraphApi exposes stinggraph layers, file nodes and a roll-up to any units', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-codegraph-layers-'));
  await git(root, ['init', '-b', 'main']);
  await mkdir(path.join(root, 'services/api'), { recursive: true }); await mkdir(path.join(root, 'services/store'), { recursive: true });
  await mkdir(path.join(root, '.stinggraph'));
  await writeFile(path.join(root, '.stinggraph/layers.yaml'), 'version: 1\nservices:\n  - id: api\n    label: API service\n    include: ["services/api/**"]\n'
    + '  - id: store\n    label: Store\n    include: ["services/store/**"]\n');
  await writeFile(path.join(root, 'services/__init__.py'), '');
  await writeFile(path.join(root, 'services/store/db.py'), 'def save(x):\n    return x\n');
  await writeFile(path.join(root, 'services/api/main.py'), 'from services.store.db import save\n\n\ndef handle():\n    return save(1)\n');
  const inputs: EvaluateInput[] = [];
  const host = createCodeGraphHost({ debounceMs: 100, grammarDir: () => '/g', evaluate: async input => { inputs.push(input); return output(); } });
  try {
    const graph = host.open('w1', root);
    await state(graph, 'ready');
    await graph.evaluateView(view);
    const api = inputs[0].graph!;
    const layers = api.layers()!;
    assert.equal(layers.config, '.stinggraph/layers.yaml');
    assert.deepEqual(layers.services.filter(s => s.origin === 'declared').map(s => [s.id, s.label]), [['api', 'API service'], ['store', 'Store']]);
    assert.deepEqual(layers.assignments['services/api/main.py'].service, 'api');
    assert.deepEqual(api.fileSymbols('services/api/main.py').map(s => s.kind).sort(), ['file', 'function', 'import']);
    const [edge] = api.rollup({ 'services/api/main.py': 'service:api', 'services/store/db.py': 'service:store' });
    assert.deepEqual([edge.from, edge.to, edge.byKind.calls], ['service:api', 'service:store', 1]);
    assert.ok(edge.total >= 2); // the call and the import
    assert.deepEqual(api.rollup({ 'services/api/main.py': 'service:api' }), []); // files without a unit are left out
  } finally { await host.closeAll(); await rm(root, { recursive: true, force: true }); }
});
