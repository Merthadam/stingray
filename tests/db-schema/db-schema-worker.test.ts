import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCodeGraphProcessHost } from '../../electron/app/wiring/stinggraph';
import { ViewService } from '../../electron/app/wiring/views';
import { GitService, Store, WorkspaceLifecycle } from '../../electron/core/git';
import { memoryState, pathOnlyFiles, scriptedGit } from '../fakes/git';

const worker = path.join(import.meta.dirname, '../../electron/app/stinggraph-worker.ts');
const grammarPath = path.join(import.meta.dirname, '../../electron/adapters/driven/tree-sitter/tree-sitter-python.wasm');
const model = 'from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column\nclass Base(DeclarativeBase):\n    pass\nclass User(Base):\n    __tablename__ = "users"\n    id: Mapped[int] = mapped_column(primary_key=True)\n';

test('rule 4: schema parsing runs in the worker; a killed worker gives a warning, main keeps answering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-db-worker-'));
  const children: ChildProcess[] = [];
  const host = createCodeGraphProcessHost({ timeoutMs: 3000, evaluateTimeoutMs: 20_000, spawn: () => {
    const child = fork(worker, [], { execArgv: ['--import', 'tsx', '--liftoff-only', '--disable-warning=ExperimentalWarning'],
      env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1' } });
    children.push(child); return child;
  } });
  const views = new ViewService({ host, grammarPath, emit: () => {}, dbSchema: { dbSchema: (id, r) => host.dbSchema(id, r, grammarPath), sqlSchema: (id, r) => host.sqlSchema(id, r) } });
  try {
    await mkdir(path.join(root, 'app'));
    await writeFile(path.join(root, 'app/models.py'), model);
    await writeFile(path.join(root, 'schema.sql'), 'CREATE TABLE orders (id INTEGER PRIMARY KEY);\n');
    await views.listViews('w1', root); // opens the graph: the worker starts
    const database = await views.computeView('w1', root, 'database');
    const labels = database.nodes.map(n => n.label);
    assert.ok(labels.includes('users') && labels.includes('orders'), labels.join(','));

    const pending = host.dbSchema('w1', root, grammarPath);
    children.at(-1)!.kill('SIGKILL');
    const degraded = await pending;
    assert.deepEqual(degraded.groups, []);
    assert.ok(degraded.warnings.length > 0);

    const git = new GitService({ store: new Store('/data', memoryState({ version: 1, repos: [], workspaces: [] })), runner: scriptedGit(() => ''), files: pathOnlyFiles, cloner: async () => {}, lifecycle: new WorkspaceLifecycle(() => {}) });
    assert.deepEqual((await git.store.load()).repos, [], 'main-process services keep answering');
  } finally { await views.dispose(); await rm(root, { recursive: true, force: true }); }
});
