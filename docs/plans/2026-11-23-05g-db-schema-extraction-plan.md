# 05g · Db-schema feature extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** `electron/core/db-schema/` extracts SQLAlchemy and SQL schemas from syntax trees (`SyntaxParser`) and file
lists (the one walker, via a `SchemaFiles` port) without doing I/O itself; in the app, parsing runs in the stinggraph
worker process (audit 10, failure-isolation rule 4); the db/sql scanners use the walker (audit 16, second half);
a failing schema source degrades the Database view instead of failing it (rule 2).

**Architecture:** two new worker calls (`dbSchema`, `sqlSchema`) on the process host; `ViewService` gets a
`DbSchemaSource` port implemented in main by the worker host. `electron/app/wiring/db-schema.ts` keeps
`extractDbSchema(id, root, grammarPath)` and `extractSqlSchema(id, root, grammarDir?)` in-process for the CLI, the worker
itself and the existing tests.

**Tech Stack:** TypeScript, web-tree-sitter (adapter), `child_process.fork` (worker), node:test.

**Spec:** [04 § Commit 5](../specs/2026-11-23-04-hexagonal-modules-design.md#commit-5--per-feature-extraction) (db-schema row, rules 2 and 4),
[07 § 10, § 16](../specs/2026-11-23-07-audit-fixes-design.md).

**Depends on:** plan 05f committed. **Commit:** one, `refactor(db-schema): schema extraction on syntax trees; parsing in the worker process`.

---

## Files

Create: `electron/core/db-schema/ports.ts`, `electron/adapters/driven/fs/schema-files.ts`, `electron/app/wiring/db-schema.ts`,
`tests/fakes/db-schema.ts`, `tests/db-schema/db-schema.core.test.ts`, `tests/db-schema/db-schema-worker.test.ts`.

Modify: `electron/core/db-schema/{db-schema,sql-schema,index}.ts`, `electron/core/views/{service,ports,index}.ts`,
`electron/adapters/driven/stinggraph-worker/{stinggraph-process,stinggraph}.ts`, `electron/app/wiring/{views,stinggraph}.ts`,
`electron/app/views-cli.ts`, `electron/main.ts`, `tests/views/view-service.core.test.ts` (constructor + one case),
`tests/db-schema/{db-schema,sql-schema}.test.ts` (import paths).

---

### Task 1: Port and fakes

- [ ] **Step 1: `electron/core/db-schema/ports.ts`**

```ts
/** Worktree files for the schema scanners: the one walker with dot-dirs skipped and the 20 000 entry cap. */
export interface SchemaFiles {
  /** Sorted kept files (≤ 5 000); rejects when the root is unreadable; unreadable subdirectories go to onDirError. */
  list(root: string, keep: (rel: string) => boolean, onDirError: (rel: string, error: Error) => void): Promise<{ files: string[]; truncated: boolean }>;
  /** Text of a regular file ≤ 1 MiB, opened without following symlinks; rejects with the fs error. */
  read(root: string, rel: string): Promise<{ text: string } | { skipped: 'notFile' | 'tooLarge' }>;
}
```

- [ ] **Step 2: `tests/fakes/db-schema.ts`**

```ts
import type { SchemaFiles } from '../../electron/core/db-schema';

export function memorySchemaFiles(files: Record<string, string | 'tooLarge'>, unreadableDirs: string[] = []): SchemaFiles {
  return {
    async list(_root, keep, onDirError) {
      for (const dir of unreadableDirs) onDirError(dir, new Error('EACCES: permission denied'));
      const kept = Object.keys(files).filter(f => !unreadableDirs.some(d => f.startsWith(d + '/')) && keep(f)).sort();
      return { files: kept, truncated: false };
    },
    async read(_root, rel) { const v = files[rel]; return v === 'tooLarge' ? { skipped: 'tooLarge' } : { text: v }; },
  };
}
```

### Task 2: Pure extractors (TDD)

- [ ] **Step 1: `tests/db-schema/db-schema.core.test.ts`** (real tree-sitter through the `SyntaxParser` adapter, in-memory files)

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { extractDbSchema } from '../../electron/core/db-schema';
import { provideSyntaxParser, resetCorePorts } from '../../electron/core/shared/ports';
import { webTreeSitter } from '../../electron/adapters/driven/tree-sitter/syntax-parser';
import { memorySchemaFiles } from '../fakes/db-schema';

const grammarPath = path.join(import.meta.dirname, '../../electron/adapters/driven/tree-sitter/tree-sitter-python.wasm');
const model = 'from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column\nclass Base(DeclarativeBase):\n    pass\nclass User(Base):\n    __tablename__ = "users"\n    id: Mapped[int] = mapped_column(primary_key=True)\n';
before(() => provideSyntaxParser(webTreeSitter));
after(() => resetCorePorts());

test('extracts tables from in-memory files; skips large files and unreadable dirs with warnings', async () => {
  const files = memorySchemaFiles({ 'app/models.py': model, 'big.py': 'tooLarge', 'locked/x.py': model, 'notes.txt': 'x' }, ['locked']);
  const result = await extractDbSchema('w1', '/repo', grammarPath, files);
  assert.deepEqual(result.groups.flatMap(g => g.tables.map(t => t.name)), ['users']);
  assert.ok(result.warnings.some(w => w.file === 'big.py' && /1 MiB/.test(w.message)));
  assert.ok(result.warnings.some(w => w.file === 'locked' && /Could not read directory/.test(w.message)));
  assert.equal(result.filesScanned, 1);
});
```

- [ ] **Step 2: Run** — FAIL (signature).

- [ ] **Step 3: `electron/core/db-schema/db-schema.ts`**

- Imports: delete `node:fs/promises`, `node:fs`, `node:path`, the runtime `web-tree-sitter` import (keep `import type { Node } from 'web-tree-sitter'`) and `initTreeSitter`; add `import { syntaxParser } from '../shared/ports'; import type { SchemaFiles } from './ports';`. Delete `SKIP_DIRS` and `MAX_ENTRIES`/`MAX_PY_FILES` (the walker owns them); keep `MAX_FILE_BYTES`, `MAX_WARNINGS`, `PREFILTER`.
- `loadParser(grammarPath)`: body becomes `parserPromise ??= syntaxParser().loadLanguage(grammarPath).then(language => syntaxParser().parser(language)).catch(error => { parserPromise = undefined; throw error; });` (type `Promise<Parser>` with `import type { Parser }`).
- `extractDbSchema(workspaceId, root, grammarPath, files: SchemaFiles)`: replace the walk loop (today's lines 184-210) with
```ts
  // The one walker (driven/fs/walk.ts): no symlinks, dot-dirs skipped, 20 000 entries, 5 000 Python files, sorted.
  const listed = await files.list(root, rel => rel.endsWith('.py'), (dir, error) => warn(dir, null, `Could not read directory: ${error.message}`));
  truncated = listed.truncated;
  for (const rel of listed.files) {
    let source: string;
    try {
      const read = await files.read(root, rel);
      if ('skipped' in read) { if (read.skipped === 'tooLarge') warn(rel, null, 'Skipped: file is larger than 1 MiB.'); continue; }
      source = read.text;
    } catch (error) { warn(rel, null, `Could not read file: ${(error as Error).message}`); continue; }
    filesScanned++;
    if (!PREFILTER.test(source) && rel.split('/').at(-1) !== '__init__.py') continue;
    filesParsed++;
    await new Promise(resolve => setTimeout(resolve, 0)); // yield between files
    const tree = parser.parse(source);
    // … the rest of the old loop body from `if (!tree) { warn(…) }` on, unchanged …
  }
```
Delete the `shortcut:` comment. `entries`/`pyFiles` counters go.
- `sql-schema.ts`: same treatment — delete node and runtime tree-sitter imports, `SKIP_DIRS`, `MAX_ENTRIES`; `GRAMMAR_FILES` from `../shared/grammar-files`; parsers via `syntaxParser().loadLanguage(path.join(grammarDir, file))` (`import * as path from '../shared/posix-path'`) and `syntaxParser().parser(language)`; signature `extractSqlSchema(workspaceId, root, grammarDir: string, files: SchemaFiles)`; the walk loop (lines 44-59) becomes `const listed = await files.list(root, isSqlSource, (dir, error) => warn(dir, null, `Could not read directory: ${error.message}`)); truncated = listed.truncated; files.push(...listed.files)` (rename the local `files` array to `paths` to avoid the clash); file reads use `files.read` with the same warnings as before.
- `index.ts` exports `extractDbSchema`, `extractSqlSchema`, `isSqlSource`, `applySqlConstraints`, `parseSqlDdl`, `sameSqlName`, `type SchemaFiles`.

- [ ] **Step 4: `electron/adapters/driven/fs/schema-files.ts`**

```ts
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { SchemaFiles } from '../../../core/db-schema';
import { walkFiles } from './walk';

const MAX_FILE_BYTES = 1024 * 1024;
export const nodeSchemaFiles: SchemaFiles = {
  list: (root, keep, onDirError) => walkFiles(root, { keep, skipDotDirs: true, maxEntries: 20_000, onDirError }),
  async read(root, rel) {
    // O_NONBLOCK keeps a FIFO swapped in after readdir from blocking a libuv thread.
    const handle = await open(path.join(root, rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { skipped: 'notFile' };
      if (stat.size > MAX_FILE_BYTES) return { skipped: 'tooLarge' };
      return { text: (await handle.readFile()).toString('utf8') };
    } finally { await handle.close(); }
  },
};
```

- [ ] **Step 5: `electron/app/wiring/db-schema.ts`**

```ts
import './core-ports';
import { nodeSchemaFiles } from '../../adapters/driven/fs/schema-files';
import { codegraphGrammarDir } from '../../adapters/driven/tree-sitter/grammars';
import { extractDbSchema as coreDb, extractSqlSchema as coreSql } from '../../core/db-schema';

export const extractDbSchema = (workspaceId: string, root: string, grammarPath: string) => coreDb(workspaceId, root, grammarPath, nodeSchemaFiles);
export const extractSqlSchema = (workspaceId: string, root: string, grammarDir = codegraphGrammarDir()) => coreSql(workspaceId, root, grammarDir, nodeSchemaFiles);
export { applySqlConstraints, parseSqlDdl } from '../../core/db-schema';
```
Existing tests: `tests/db-schema/db-schema.test.ts`, `sql-schema.test.ts` (and `sql-ddl.test.ts` if it imports from the same module) import from `../../electron/app/wiring/db-schema` (import edits). `electron/app/views-cli.ts` `main()` imports the extractors from `./wiring/db-schema`.

- [ ] **Step 6: Run** — `npx tsx --test tests/db-schema/*.test.ts` → PASS (existing db-schema/sql-schema tests unchanged).

### Task 3: `DbSchemaSource` in views (rule 2)

- [ ] **Step 1: `electron/core/views/ports.ts`** — add

```ts
import type { DbSchemaResult } from '../../../shared/contracts/db-schema';
/** SQLAlchemy and SQL schema of a worktree (the worker process in the app, in-process in tests and the CLI). */
export interface DbSchemaSource {
  dbSchema(workspaceId: string, root: string): Promise<DbSchemaResult>;
  sqlSchema(workspaceId: string, root: string): Promise<DbSchemaResult>;
}
```

- [ ] **Step 2: `electron/core/views/service.ts`** — delete the `../db-schema` / `../sql-schema` extractor imports (keep `isSqlSource` from `../db-schema` index); options gain `dbSchema: DbSchemaSource` (stored as `this.schemas`); `grammarPath` stays in the options type for the wiring but is no longer read here. Rename today's `schema()`/`sqlSchema()` to `rawSchema()`/`rawSqlSchema()` (caching unchanged, `extractDbSchema(workspaceId, w.root, this.grammarPath)` → `this.schemas.dbSchema(workspaceId, w.root)`, `extractSqlSchema(workspaceId, w.root)` → `this.schemas.sqlSchema(workspaceId, w.root)`) and add the degraded wrappers used by `compute()`:

```ts
  // Rule 2: a failing schema source gives the Database view a warning instead of failing it (cache logic unchanged).
  private schema(w: Worktree, id: string) { return this.rawSchema(w, id).catch(error => degradedSchema(id, error)); }
  private sqlSchema(w: Worktree, id: string) { return this.rawSqlSchema(w, id).catch(error => degradedSchema(id, error)); }
```
with, at module level:
```ts
const degradedSchema = (workspaceId: string, error: unknown): DbSchemaResult => ({ workspaceId, scannedAt: Date.now(), filesScanned: 0, filesParsed: 0,
  truncated: false, groups: [], warnings: [{ file: '', line: null, message: `Schema scan unavailable: ${error instanceof Error ? error.message : String(error)}` }] });
```
(Check `DbSchemaResult`'s required fields in `shared/contracts/db-schema.ts` and fill every one.)

- [ ] **Step 3: `electron/app/wiring/views.ts`** — the wiring `ViewService` accepts an optional `dbSchema` and defaults to the in-process extractors:

```ts
export class ViewService extends core.ViewService {
  constructor(options: { host: core.GraphHost; grammarPath: string; emit: (event: ViewsChangedEvent) => void; debounceMs?: number; dbSchema?: core.DbSchemaSource }) {
    super({ ...options, viewFiles: nodeViewFiles, fileProvider: createFileProvider,
      dbSchema: options.dbSchema ?? { dbSchema: (id, root) => extractDbSchema(id, root, options.grammarPath), sqlSchema: (id, root) => extractSqlSchema(id, root) } });
  }
}
```
(import `extractDbSchema`, `extractSqlSchema` from `./db-schema`.)

- [ ] **Step 4: `tests/views/view-service.core.test.ts`** — add `dbSchema: okSchemas` to the existing constructor call and append:

```ts
const empty = (workspaceId: string) => ({ workspaceId, scannedAt: 0, filesScanned: 0, filesParsed: 0, truncated: false, groups: [], warnings: [] });
const okSchemas = { dbSchema: async (id: string) => empty(id), sqlSchema: async (id: string) => empty(id) };

test('rule 2: a rejecting schema source gives the Database view a warning; other views are unaffected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-views-core-'));
  try {
    const service = new ViewService({ host: throwingHost(), grammarPath, emit: () => {}, viewFiles: memoryViewFiles({}),
      fileProvider: () => ({ list: async () => ({ files: [], truncated: false }), read: async () => null }), log: () => {},
      dbSchema: { dbSchema: async () => { throw new Error('worker gone'); }, sqlSchema: async id => empty(id) } });
    const database = await service.computeView('w1', root, 'database');
    assert.ok(database.warnings.some(w => /Schema scan unavailable: worker gone/.test(w.message)));
    assert.ok((await service.listViews('w1', root)).length >= 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
```
(`okSchemas`/`empty` are declared above the first test.)

### Task 4: Worker calls and the rule-4 test (TDD)

- [ ] **Step 1: `tests/db-schema/db-schema-worker.test.ts`**

```ts
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
```

- [ ] **Step 2: Run** — FAIL (`host.dbSchema` missing).

- [ ] **Step 3: `stinggraph-process.ts`** — `Call` gains `| { type: 'dbSchema'; workspaceId: string; root: string; grammarPath: string } | { type: 'sqlSchema'; workspaceId: string; root: string }`; `Reply.result` union gains `DbSchemaResult`; `CodeGraphProcessHost` gains
```ts
  /** Schema extraction in the worker (crash-prone tree-sitter parsing stays out of main, rule 4); never rejects. */
  dbSchema(workspaceId: string, root: string, grammarPath: string): Promise<DbSchemaResult>;
  sqlSchema(workspaceId: string, root: string): Promise<DbSchemaResult>;
```
implemented as
```ts
  const schemaCall = async (message: Call, workspaceId: string): Promise<DbSchemaResult> => {
    const reply = await call(message, evaluateTimeoutMs);
    if (typeof reply === 'object' && 'result' in reply && reply.result) return reply.result as DbSchemaResult;
    const why = reply === 'timeout' ? 'timed out' : reply === 'down' ? 'the code graph process is not running' : reply.error;
    return { workspaceId, scannedAt: Date.now(), filesScanned: 0, filesParsed: 0, truncated: false, groups: [],
      warnings: [{ file: '', line: null, message: `Schema scan unavailable: ${why}.` }] };
  };
  // in the returned object:
    dbSchema: (workspaceId, root, grammarPath) => schemaCall({ type: 'dbSchema', workspaceId, root, grammarPath }, workspaceId),
    sqlSchema: (workspaceId, root) => schemaCall({ type: 'sqlSchema', workspaceId, root }, workspaceId),
```
(The "drop cache when graph unavailable" logic of `ViewService` retries after such a result.)

- [ ] **Step 4: `stinggraph.ts`** — `CodeGraphHostOptions` gains `dbSchema?: (workspaceId: string, root: string, grammarPath: string) => Promise<DbSchemaResult>; sqlSchema?: (workspaceId: string, root: string) => Promise<DbSchemaResult>;`; in `serveCodeGraph().handle` add cases that reply with the result or the error message, like the existing `evaluateView` case:
```ts
        case 'dbSchema': void settings.dbSchema!(message.workspaceId, message.root, message.grammarPath).then(result => reply(message.id, result), error => replyError(message.id, error)); break;
        case 'sqlSchema': void settings.sqlSchema!(message.workspaceId, message.root).then(result => reply(message.id, result), error => replyError(message.id, error)); break;
```
(use the file's existing reply helpers; name them as they are named there).
`electron/app/wiring/stinggraph.ts` `workerDeps` gains `dbSchema: extractDbSchema, sqlSchema: (id, root) => extractSqlSchema(id, root)` from `./db-schema`.

- [ ] **Step 5: `electron/main.ts`**

```ts
const grammarPath = path.join(__dirname, 'tree-sitter-python.wasm');
const views = new ViewService({ host: codegraph, grammarPath, emit: event => viewsEvents.onViewsChanged(event),
  dbSchema: { dbSchema: (id, root) => codegraph.dbSchema(id, root, grammarPath), sqlSchema: (id, root) => codegraph.sqlSchema(id, root) } });
```

- [ ] **Step 6: Run** — `npx tsx --test tests/db-schema/db-schema-worker.test.ts tests/views/view-service.core.test.ts` → PASS.

### Task 5: Verify and commit

- [ ] **Step 1**

```bash
grep -rn "from 'node:\|from 'electron'" electron/core/db-schema; grep -rn "from 'web-tree-sitter'" electron/core | grep -v "import type"   # no output
grep -rn "readdir" electron/core electron/adapters/driven/fs | grep -v "walk.ts\|view-files.ts"                                          # no output (one walker)
npm run check 2>&1 | tail -n 12
npm run test:e2e -- views-tab desktop
```

- [ ] **Step 2: Commit**

```bash
git add -A electron tests docs/plans/2026-11-23-test-edit-ledger.md
git commit -m "refactor(db-schema): schema extraction on syntax trees; parsing in the worker process"
```

## Self-review

- Spec coverage (04 db-schema row): core `db-schema.ts`, `sql-schema.ts`, `sql-ddl.ts`; ports `SyntaxParser` (core/shared, approved clarification 7) and the walker port (named `SchemaFiles`: it carries the scanners' read rules; views keep their own `FileProvider`); worker calls in `stinggraph-worker/`; `db-schema.core.test.ts`, `db-schema-worker.test.ts` (rule 4); rule-2 `DbSchemaSource` case; audit 10 and audit 16 (db/sql on the walker; old loops deleted; `shortcut:` comment removed).
- The core test uses the real `SyntaxParser` adapter with in-memory files instead of a hand-built fake syntax tree (a fake tree-sitter tree would re-implement the grammar); it still runs without git, PTYs, SQLite, Docker or Electron.
