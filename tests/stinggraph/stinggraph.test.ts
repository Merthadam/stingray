import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { git } from '../../electron/app/wiring/git';
import { createCodeGraphHost } from '../../electron/adapters/driven/stinggraph-worker/stinggraph';
import type { GraphChange, WorktreeGraph } from '../../electron/core/views/graph';
import type { GraphState } from '../../shared/contracts/views';

// The app sets CodeGraph's opt-outs on its child process (codegraph-process.ts); this file runs the host in-process.
process.env.CODEGRAPH_TELEMETRY = '0'; process.env.CODEGRAPH_NO_UPDATE_CHECK = '1';

async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-codegraph-'));
  await git(root, ['init', '-b', 'main']);
  await mkdir(path.join(root, 'app'));
  await writeFile(path.join(root, 'app/models.py'), 'class User:\n    name: str\n\n\nclass Order:\n    def total(self):\n        return 0\n');
  await writeFile(path.join(root, 'app/views.py'), 'from app.models import User\n\ndef show(user: User):\n    return user.name\n');
  return root;
}

const until = <T>(what: string, check: () => T | undefined | false, ms = 15000) => new Promise<T>((resolve, reject) => {
  const started = Date.now();
  const tick = () => { const value = check(); if (value) return resolve(value);
    if (Date.now() - started > ms) return reject(new Error('Timed out waiting for ' + what)); setTimeout(tick, 50); };
  tick();
});
const find = async (graph: WorktreeGraph, file: string, name: string, kinds?: string[]) => (await graph.findSymbols([{ file, name, kinds }]))[0];
const state = (graph: WorktreeGraph, wanted: GraphState) => until(wanted, () => graph.status().state === wanted || undefined, 30000);
const changes = (graph: WorktreeGraph) => { const seen: GraphChange[] = []; graph.onChange(change => seen.push(change)); return seen; };
const changed = (seen: GraphChange[], file: string) => until(file, () => seen.some(c => c.files.includes(file)));
async function snapshot(dir: string, skip: string[] = []): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const file = path.relative(dir, path.join(entry.parentPath, entry.name));
    if (entry.isFile() && !skip.some(s => file === s || file.startsWith(s + '/'))) out[file] = await readFile(path.join(dir, file), 'utf8');
  }
  return out;
}

test('indexes a worktree, finds symbols, reports edits, and touches nothing outside .codegraph', async () => {
  const root = await repo(); const host = createCodeGraphHost({ debounceMs: 100 });
  try {
    const before = await snapshot(root, ['.git/objects']);
    const graph = host.open('w1', root);
    assert.equal(host.open('w1', root), graph);
    const statuses: GraphState[] = []; graph.onStatus(s => statuses.push(s.state));
    graph.onChange(() => { throw new Error('listener failure must not break the host'); });
    const seen = changes(graph);
    await state(graph, 'ready');
    assert.ok(statuses.includes('indexing'));
    const user = await find(graph, 'app/models.py', 'User', ['class']);
    assert.deepEqual({ ...user, id: undefined }, { id: undefined, name: 'User', kind: 'class', file: 'app/models.py', line: 1, endLine: 2, qualifiedName: 'User' });
    assert.equal(await find(graph, 'app/models.py', 'User', ['function']), null);
    assert.equal(await find(graph, 'missing.py', 'User'), null);
    assert.deepEqual((await graph.findSymbols([{ file: 'app/models.py', name: 'Order' }, { file: 'app/models.py', name: 'Nope' }, { file: 'app/views.py', name: 'show' }]))
      .map(s => s?.name ?? null), ['Order', null, 'show']);

    // Nothing but .codegraph/ appears: no hooks, git config, or other worktree files.
    assert.deepEqual(await snapshot(root, ['.git/objects', '.codegraph']), before);
    assert.equal(await readFile(path.join(root, '.codegraph/.gitignore'), 'utf8').then(t => t.includes('*\n!.gitignore')), true);
    assert.equal((await git(root, ['status', '--porcelain', '--untracked-files=all'])).split('\n').filter(l => l.includes('.codegraph')).join(), '?? .codegraph/.gitignore');

    await appendFile(path.join(root, 'app/models.py'), '\n\nclass Invoice:\n    pass\n');
    await changed(seen, 'app/models.py');
    assert.equal((await find(graph, 'app/models.py', 'Invoice'))?.line, 10);
    await rm(path.join(root, 'app/views.py'));
    await changed(seen, 'app/views.py');

    await host.close('w1');
    assert.equal(graph.status().state, 'unavailable');
    assert.equal(await find(graph, 'app/models.py', 'User'), null);
    await host.close('w1');

    // Reopening an existing index takes the open + catch-up path.
    const reopened = host.open('w1', root);
    assert.notEqual(reopened, graph);
    await state(reopened, 'ready');
    assert.ok(await find(reopened, 'app/models.py', 'Invoice'));
  } finally { await host.closeAll(); await host.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test('follows an index written by another process read-only, and becomes the writer once the lock is free', async () => {
  const root = await repo(); const host = createCodeGraphHost({ debounceMs: 100, pollMs: 200 });
  const { CodeGraph } = createRequire(import.meta.url)('@colbymchenry/codegraph') as typeof import('@colbymchenry/codegraph');
  try {
    (await CodeGraph.init(root, { index: true })).close();
    // A live foreign PID holds the writer lock, as a CodeGraph MCP daemon would mid-sync.
    await writeFile(path.join(root, '.codegraph/codegraph.lock'), String(process.ppid));
    const graph = host.open('w1', root); const seen = changes(graph);
    await state(graph, 'read-only');
    assert.ok(await find(graph, 'app/models.py', 'Order', ['class']));
    // Once the lock is free this graph becomes the writer and catches up on changes made meanwhile.
    await appendFile(path.join(root, 'app/views.py'), '\ndef audit():\n    pass\n');
    await rm(path.join(root, '.codegraph/codegraph.lock'));
    await state(graph, 'ready');
    assert.ok(await find(graph, 'app/views.py', 'audit'));
    await appendFile(path.join(root, 'app/models.py'), '\nclass Invoice:\n    pass\n');
    await changed(seen, 'app/models.py');
    assert.ok(await find(graph, 'app/models.py', 'Invoice', ['class']));
  } finally { await host.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test('closes the least recently opened graph beyond the cap and reopens it on demand', async () => {
  const roots = await Promise.all([repo(), repo(), repo()]);
  const host = createCodeGraphHost({ maxOpen: 2, debounceMs: 100 });
  try {
    const [a, b] = [host.open('a', roots[0]), host.open('b', roots[1])];
    await Promise.all([state(a, 'ready'), state(b, 'ready')]);
    host.open('a', roots[0]); // a is now more recent than b
    const c = host.open('c', roots[2]);
    await state(c, 'ready');
    assert.equal(b.status().state, 'unavailable'); assert.match(b.status().message ?? '', /limit/);
    assert.equal(a.status().state, 'ready');
    assert.equal(host.open('b', roots[1]), b);
    await state(b, 'ready');
    assert.equal(a.status().state, 'unavailable');
    assert.ok(await find(b, 'app/models.py', 'User'));
  } finally { await host.closeAll(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); }
});

test('without the library, reports unavailable and still watches files', async () => {
  const root = await repo(); const host = createCodeGraphHost({ debounceMs: 100, load: () => Promise.reject(new Error('native module mismatch\nstack')) });
  try {
    const graph = host.open('w1', root); const seen = changes(graph);
    await state(graph, 'unavailable');
    assert.equal(graph.status().message, 'Code graph unavailable: native module mismatch');
    assert.equal(await find(graph, 'app/models.py', 'User'), null);
    await new Promise(resolve => setTimeout(resolve, 200)); // let FSEvents arm
    await writeFile(path.join(root, '.git/ignored-by-host'), 'x');
    await appendFile(path.join(root, 'app/models.py'), '\nclass Late:\n    pass\n');
    await changed(seen, 'app/models.py');
    assert.ok(seen.every(c => c.files.every(f => !f.startsWith('.git/'))));
  } finally { await host.closeAll(); await rm(root, { recursive: true, force: true }); }
});
