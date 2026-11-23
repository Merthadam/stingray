import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { git } from '../../electron/core/git/git';
import { createCodeGraphHost } from '../../electron/adapters/driven/stinggraph-worker/stinggraph';
import { baseRoot, overlayPath, type SharedBaseTarget } from '../../electron/adapters/driven/stinggraph-worker/stinggraph-overlay';
import { createGraphApi } from '../../electron/adapters/driven/stinggraph-worker/stinggraph-api';
import type { GraphApi, ResolvedView } from '../../electron/core/views/rules/types';
import type { WorktreeGraph } from '../../electron/core/views/graph';

process.env.CODEGRAPH_TELEMETRY = '0'; process.env.CODEGRAPH_NO_UPDATE_CHECK = '1';
const { CodeGraph } = createRequire(import.meta.url)('@colbymchenry/codegraph') as typeof import('@colbymchenry/codegraph');

const until = <T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, ms = 60000) => new Promise<T>((resolve, reject) => {
  const started = Date.now();
  const tick = async () => { const value = await check(); if (value) return resolve(value);
    if (Date.now() - started > ms) return reject(new Error('Timed out waiting for ' + what)); setTimeout(tick, 100); };
  void tick();
});
const commit = async (dir: string, message: string) => { await git(dir, ['add', '-A']); await git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message]); };

/** A repo whose origin/main is its main, with two worktrees (a, b) that both edit app/models.py. */
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'stingray-overlay-'));
  const repo = path.join(dir, 'repo');
  await mkdir(path.join(repo, 'app'), { recursive: true });
  await git(repo, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(repo, 'app/models.py'), 'class User:\n    name: str\n\n\nclass Order:\n    def total(self):\n        return 0\n');
  await writeFile(path.join(repo, 'app/views.py'), 'from app.models import User, Order\n\ndef show(user: User):\n    return user.name\n\ndef bill(order: Order):\n    return order.total()\n');
  await writeFile(path.join(repo, 'README.md'), '# demo\n');
  await commit(repo, 'base');
  await git(repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  await git(repo, ['worktree', 'add', '-q', '-b', 'a', a, 'main']);
  await git(repo, ['worktree', 'add', '-q', '-b', 'b', b, 'main']);
  // a: a line shift above Order, a new method and a new caller in a new file.
  await writeFile(path.join(a, 'app/models.py'), '# moved\nclass User:\n    name: str\n\n    def rename(self, name):\n        self.name = name\n\n\nclass Order:\n    def total(self):\n        return 1\n');
  await writeFile(path.join(a, 'app/admin.py'), 'from app.models import User\nfrom app.views import show\n\ndef reset(user: User):\n    user.rename("x")\n    return show(user)\n');
  await commit(a, 'a');
  await appendFile(path.join(b, 'app/models.py'), '\n\nclass Invoice:\n    pass\n');
  await commit(b, 'b');
  return { dir, repo, a, b, target: { repoId: 'r1', repoPath: repo, dataDir: path.join(dir, 'data') } satisfies SharedBaseTarget };
}

/** Opens graphs whose evaluateView hands back the GraphApi the views would get. */
function host() {
  let captured: GraphApi | null = null;
  const h = createCodeGraphHost({ debounceMs: 100, evaluate: async ({ graph }) => { captured = graph; return {} as never; } });
  const api = async (graph: WorktreeGraph) => { captured = null; await graph.evaluateView({} as ResolvedView); return captured; };
  return { h, api };
}
const ready = (graph: WorktreeGraph) => until(`ready (${graph.workspaceId}: ${JSON.stringify(graph.status())})`, () => graph.status().state === 'ready', 60000).catch(e => { throw new Error(e.message + JSON.stringify(graph.status())); });

/** Everything GraphApi answers about the symbols of `files`, normalized for comparison. */
function answers(api: GraphApi, files: string[], names: string[]) {
  const out: Record<string, unknown> = {};
  for (const file of files) for (const name of names) {
    const found = api.findSymbols(name, file).sort((x, y) => x.id.localeCompare(y.id));
    if (!found.length) continue;
    const ids = found.map(s => s.id);
    const sort = (rs: ReturnType<GraphApi['outgoing']>) => rs.map(r => `${r.from}>${r.to}:${r.kind}:${r.line}:${r.certain}`).sort();
    out[`${file}#${name}`] = { found, symbols: [...api.symbols(ids).entries()].sort(), outgoing: sort(api.outgoing(ids, [])), incoming: sort(api.incoming(ids, [])) };
  }
  return out;
}

test('shared base: overlays answer GraphApi like a full index, follow commits, and report conflicts and main moving', async () => {
  const { repo, a, b, target, dir } = await fixture();
  const { h, api } = host();
  try {
    const ga = h.open('a', a, target), gb = h.open('b', b, target);
    await ready(ga); await ready(gb);
    // Shared mode: one base in the data dir, an overlay per worktree, and no index inside the worktrees.
    assert.ok(existsSync(path.join(baseRoot(target), '.codegraph/codegraph.db')));
    assert.ok(existsSync(overlayPath(target, 'a')) && existsSync(overlayPath(target, 'b')));
    assert.equal(existsSync(path.join(a, '.codegraph')), false);
    assert.equal((await git(repo, ['worktree', 'list'])).split('\n').filter(Boolean).length, 3, 'the base is not a git worktree');

    // The merged view equals a full index of a's HEAD for the changed files (and the unchanged caller of them).
    const ref = path.join(dir, 'ref');
    await git(repo, ['worktree', 'add', '-q', '--detach', ref, 'a']);
    const cg = await CodeGraph.init(ref); await cg.indexAll();
    try {
      const files = ['app/models.py', 'app/admin.py', 'app/views.py'], names = ['User', 'Order', 'rename', 'total', 'reset', 'show', 'bill', 'name'];
      const mergedApi = (await api(ga)) as unknown as GraphApi, fullApi = createGraphApi(cg);
      const merged = answers(mergedApi, files, names), full = answers(fullApi, files, names);
      assert.ok(Object.keys(full).length >= 7);
      assert.deepEqual(merged, full);
      // The Services view's reads (layers, file symbols, roll-up) work over the merged view too.
      const byId = (xs: { id: string }[]) => xs.map(x => x.id).sort();
      for (const file of files) assert.deepEqual(byId(mergedApi.fileSymbols(file)), byId(fullApi.fileSymbols(file)));
      const layers = mergedApi.layers();
      assert.ok(layers, 'layers over the merged view');
      assert.deepEqual(Object.keys(layers.assignments).sort(), Object.keys(fullApi.layers()!.assignments).sort());
      const units = Object.fromEntries(files.map(f => [f, f]));
      const roll = (r: ReturnType<GraphApi['rollup']>) => r.map(e => `${e.from}>${e.to}:${e.total}`).sort();
      assert.deepEqual(roll(mergedApi.rollup(units)), roll(fullApi.rollup(units)));
      assert.ok(mergedApi.rollup(units).length > 0);
    } finally { cg.close(); }
    assert.equal((await gb.findSymbols([{ file: 'app/models.py', name: 'Invoice' }]))[0]?.line, 10);
    assert.equal((await ga.findSymbols([{ file: 'app/models.py', name: 'Invoice' }]))[0], null);

    // Both worktrees changed app/models.py; README.md is a's only and never indexed.
    const conflicts = (await h.conflicts(target, ['a', 'b']))!;
    assert.deepEqual(conflicts.fileConflicts.map(c => [c.path, c.owners.map(o => o.worktreeId).sort()]), [['app/models.py', ['a', 'b']]]);
    assert.deepEqual(conflicts.mainMoved, []);

    // A new commit in a reaches its merged view.
    await appendFile(path.join(a, 'app/admin.py'), '\n\ndef audit():\n    pass\n');
    await commit(a, 'a2');
    await until('overlay follows the commit', async () => (await ga.findSymbols([{ file: 'app/admin.py', name: 'audit' }]))[0]);

    // main moves under both branches in a file they changed: the base follows origin/main and both are reported.
    const seen: string[] = []; ga.onChange(change => seen.push(...change.files));
    await writeFile(path.join(repo, 'app/models.py'), 'class User:\n    pass\n');
    await appendFile(path.join(repo, 'app/views.py'), '\n\ndef extra():\n    pass\n');
    await commit(repo, 'main moved');
    await git(repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
    await until('merged view over the new base', async () => (await ga.findSymbols([{ file: 'app/views.py', name: 'extra' }]))[0]);
    await until('a rebuilt over the new base and reported what main changed', () => seen.includes('app/views.py'));
    const moved = await until('main moved', async () => {
      const c = await h.conflicts(target, ['a', 'b']);
      return c && c.mainMoved.length === 2 ? c : undefined;
    });
    assert.deepEqual(moved.mainMoved.map(m => [m.path, m.owner.worktreeId]).sort(), [['app/models.py', 'a'], ['app/models.py', 'b']]);
    assert.ok((await ga.findSymbols([{ file: 'app/models.py', name: 'rename' }]))[0], 'a keeps its own models.py over the new base');
  } finally { await h.closeAll(); }
});

test('shared base: without origin/main the worktree falls back to its full index and says why', async () => {
  const { repo, a, target } = await fixture();
  await git(repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
  const { h } = host();
  const warnings: string[] = [], warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    const graph = h.open('a', a, target);
    await ready(graph);
    assert.ok(existsSync(path.join(a, '.codegraph/codegraph.db')), 'full per-worktree index');
    assert.ok((await graph.findSymbols([{ file: 'app/admin.py', name: 'reset' }]))[0]);
    assert.ok(warnings.some(w => w.includes('falling back to the full index') && w.includes('origin/main not found')), warnings.join('\n'));
    assert.equal(await h.conflicts(target, ['a']), null);
  } finally { console.warn = warn; await h.closeAll(); }
});
