# 05f · Views feature extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** everything under `electron/core/views/` is pure: `node:path` → `posix-path`, globs → `GlobMatcher`, sha256 →
`Hasher`, tree-sitter runtime → `SyntaxParser`, view files and saves → `ViewFiles`, view state → `ViewStateRepository`.
The one file walker `driven/fs/walk.ts` is created (audit 16, views part); the engine no longer lists files when no rule
needs them (audit 11); the CLI process entry moves to `electron/app/views-cli.ts` with a rule-1 error boundary; a
failing graph host degrades views instead of failing them (rule 2).

**Architecture:** `GlobMatcher` and `SyntaxParser` join `Hasher` as module-level slots in `electron/core/shared/ports.ts`,
filled by `electron/app/wiring/core-ports.ts` (approved clarifications 1 and 7). Functions that need `ViewFiles` take it
as an explicit first argument in core; `electron/app/wiring/views.ts` re-exports every name existing tests import, with
the old signatures (approved clarification 1: tests switch to it by import path only).

**Tech Stack:** TypeScript, web-tree-sitter (adapter only), yaml, zod, node:test.

**Spec:** [04 § Commit 5](../specs/2026-11-23-04-hexagonal-modules-design.md#commit-5--per-feature-extraction) (views row, rules 1-2),
[07 § 11, § 16](../specs/2026-11-23-07-audit-fixes-design.md).

**Depends on:** plan 05e committed. **Commit:** one, `refactor(views): pure views core behind ports; one file walker; engine listing guard`.

---

## Files

Create:
- `electron/core/shared/grammar-files.ts`; `electron/core/views/ports.ts`
- `electron/adapters/driven/fs/{glob,walk,view-files}.ts`, `electron/adapters/driven/tree-sitter/syntax-parser.ts`, `electron/adapters/driven/sqlite/view-state-repository.ts`
- `electron/adapters/driving/ipc/views.ts`, `electron/app/views-cli.ts`, `electron/app/wiring/views.ts`
- `tests/fakes/views.ts`, `tests/views/walk.test.ts`, `tests/views/view-service.core.test.ts`, `tests/views/views-cli.core.test.ts`

Modify: `electron/core/shared/ports.ts`, `electron/app/wiring/core-ports.ts`, every file under `electron/core/views/`,
`electron/adapters/driven/fs/files.ts`, `electron/adapters/driven/tree-sitter/grammars.ts`, `electron/adapters/driving/cli/views-cli.ts`,
`scripts/build-electron.mjs` (views-cli entry), `electron/main.ts`, existing tests under `tests/views/` and `tests/stinggraph/` (import paths), `tests/views/rules-engine.test.ts` (one new case).

---

### Task 1: `GlobMatcher` and `SyntaxParser` slots, adapters, core-ports

- [ ] **Step 1: Extend `electron/core/shared/ports.ts`**

```ts
import type { Language, Parser, Query } from 'web-tree-sitter';

export interface GlobMatcher { /** POSIX glob match of a worktree-relative path (path.posix.matchesGlob semantics). */ matches(file: string, glob: string): boolean }
export interface SyntaxParser {
  /** Load the grammar wasm at an absolute path (initializing the runtime once per process). */
  loadLanguage(file: string): Promise<Language>;
  /** A parser set to `language`; the caller deletes it. */
  parser(language: Language): Parser;
  /** Compile a query; throws on invalid query source. */
  query(language: Language, source: string): Query;
}
let glob: GlobMatcher | undefined, syntax: SyntaxParser | undefined;
export function provideGlobMatcher(value: GlobMatcher) { glob = value; }
export function provideSyntaxParser(value: SyntaxParser) { syntax = value; }
export function matchesGlob(file: string, pattern: string): boolean { if (!glob) throw missing('GlobMatcher'); return glob.matches(file, pattern); }
export function syntaxParser(): SyntaxParser { if (!syntax) throw missing('SyntaxParser'); return syntax; }
```
and extend `resetCorePorts()` with `glob = undefined; syntax = undefined;`. (`import type` from `web-tree-sitter` is erased at build: allowed in core.)

- [ ] **Step 2: Adapters**

`electron/adapters/driven/fs/glob.ts`:
```ts
import path from 'node:path';
import type { GlobMatcher } from '../../../core/shared/ports';
export const nodeGlobMatcher: GlobMatcher = { matches: (file, glob) => path.posix.matchesGlob(file, glob) };
```
`electron/adapters/driven/tree-sitter/syntax-parser.ts`:
```ts
import { Language, Parser, Query } from 'web-tree-sitter';
import type { SyntaxParser } from '../../../core/shared/ports';
import { initTreeSitter } from './grammars';
export const webTreeSitter: SyntaxParser = {
  loadLanguage: file => initTreeSitter().then(() => Language.load(file)),
  parser: language => { const parser = new Parser(); parser.setLanguage(language); return parser; },
  query: (language, source) => new Query(language, source),
};
```
`electron/app/wiring/core-ports.ts` becomes:
```ts
// Imported for its side effect by every electron/app/wiring module and process entry.
import { nodeGlobMatcher } from '../../adapters/driven/fs/glob';
import { nodeHasher } from '../../adapters/driven/fs/hash';
import { webTreeSitter } from '../../adapters/driven/tree-sitter/syntax-parser';
import { provideGlobMatcher, provideHasher, provideSyntaxParser } from '../../core/shared/ports';

provideHasher(nodeHasher);
provideGlobMatcher(nodeGlobMatcher);
provideSyntaxParser(webTreeSitter);
```
Add `import './core-ports';` to `electron/app/wiring/stinggraph.ts` and `electron/app/stinggraph-worker.ts` (the worker evaluates rules).

- [ ] **Step 3: Grammar file names become pure data** — move `GRAMMAR_FILES` and `LANGUAGES` from `electron/adapters/driven/tree-sitter/grammars.ts:6-17` verbatim into `electron/core/shared/grammar-files.ts`; `grammars.ts` keeps `codegraphGrammarDir` and `initTreeSitter` and adds `export { GRAMMAR_FILES, LANGUAGES } from '../../../core/shared/grammar-files';` (existing tests import them from `grammars`).

### Task 2: Pure core views — mechanical substitutions (per file)

For every file below: replace `import path from 'node:path';` with `import * as path from '../../shared/posix-path';` (adjust `../` depth: `core/views/*.ts` → `'../shared/posix-path'`, `core/views/<sub>/*.ts` → `'../../shared/posix-path'`); `path.posix.X(` → `path.X(`; every `path.posix.matchesGlob(a, b)` / `path.matchesGlob(a, b)` → `matchesGlob(a, b)` with `import { matchesGlob } from '<…>/shared/ports';`. No other change unless listed.

| File | Additional change |
|---|---|
| `core/views/flowchart/index.ts`, `flowchart/build.ts` | — |
| `core/views/sets/langgraph-routers.ts` | — |
| `core/views/rules/schema.ts` | `import { GRAMMAR_FILES } from '../../shared/grammar-files';` replaces the `./grammars` import |
| `core/views/rules/layers.ts`, `rules/graph-steps.ts` | — |
| `core/views/sequence/{walk,event-links,links,index,auth-links}.ts` | — |
| `core/views/sequence/langgraph-links.ts` | `import { Query, type Language, … } from 'web-tree-sitter'` → `import type { Language, Node, Query, Tree } from 'web-tree-sitter'`; `new Query(language, r.query)` → `syntaxParser().query(language, r.query)` (`import { syntaxParser } from '../../shared/ports'`) |
| `core/views/explain.ts` | delete `import { createHash } from 'node:crypto'`; line 15 `const hash = (text: string) => sha256(text).slice(0, 12);` with `import { sha256 } from '../shared/ports'` |
| `core/views/rules/engine.ts` | Step 1 below |

- [ ] **Step 1: `core/views/rules/engine.ts`**

- Imports: `import { Language, Parser, Query, type Node, type QueryMatch } from 'web-tree-sitter';` → `import type { Language, Node, Parser, Query, QueryMatch } from 'web-tree-sitter';`; `import { GRAMMAR_FILES, initTreeSitter } from './grammars';` → `import { GRAMMAR_FILES } from '../../shared/grammar-files'; import { matchesGlob, syntaxParser } from '../../shared/ports';`.
- `loadLanguage` (line 32): `lang = initTreeSitter().then(() => Language.load(file));` → `lang = syntaxParser().loadLanguage(file);` (the per-file cache stays).
- Line 120: `query = new Query(lang, rule.query)` → `query = syntaxParser().query(lang, rule.query)`.
- Lines 226 and 318: `parser = new Parser(); parser.setLanguage(lang);` → `parser = syntaxParser().parser(lang);`.
- Audit 11 — line 206: `const listed = await files.list(f => inScope(f, view.scope));` →
```ts
    // Listing walks the whole scope (up to 200 000 entries): only when a rule will read files.
    const listed = byLanguage.size ? await files.list(f => inScope(f, view.scope)) : { files: [], truncated: false };
```

- [ ] **Step 2: Audit 11 test** — append to `tests/views/rules-engine.test.ts`:

```ts
test('the engine does not list files when no rule needs them', async () => {
  let listed = 0;
  const files = { list: async () => { listed++; throw new Error('must not list'); }, read: async () => null };
  const out = await evaluate({
    view: { id: 'g', kind: 'graph', scope: { include: ['**/*'], exclude: [] }, rules: [], graph: null, flowchart: null, builtins: [], include: [], exclude: [] },
    files, graph: null, graphStatus: { state: 'unavailable', message: null }, grammarDir: codegraphGrammarDir(),
  } as Parameters<typeof evaluate>[0]);
  assert.equal(listed, 0);
  assert.ok(Array.isArray(out.nodes));
});
```
(`evaluate` and `codegraphGrammarDir` are already imported by that file.)

### Task 3: `ViewFiles`, view-state and `ViewService` ports

- [ ] **Step 1: `electron/core/views/ports.ts`**

```ts
import type { ViewLocalState, ViewsChangedEvent } from '../../../shared/contracts/views';
import type { FileProvider } from './rules/types';

/** Worktree files the views core reads and writes; paths are worktree-relative POSIX. Errors keep their fs `code`. */
export interface ViewFiles {
  /** lstat kind; rejects (code ENOENT/ENOTDIR) when missing. */
  kind(root: string, rel: string): Promise<'directory' | 'file' | 'other'>;
  /** Text of a regular file ≤ 64 KiB, or the reason it cannot be used (symlinks never followed); rejects (ENOENT) when missing. */
  readBounded(root: string, rel: string, label: string): Promise<{ text: string } | { error: string }>;
  /** Entries of a directory; rejects when missing. */
  list(root: string, relDir: string): Promise<{ name: string; directory: boolean }[]>;
  mkdir(root: string, relDir: string): Promise<void>;
  /** Exclusive create (O_EXCL | O_NOFOLLOW, 0644) and write; a partial file is removed; rejects with code EEXIST when present. */
  createExclusive(root: string, rel: string, text: string): Promise<void>;
  /** `relFile` resolved against `root`, as a POSIX path relative to `root` ('..'-prefixed or absolute when outside). */
  relative(root: string, relFile: string): string;
}
export interface ViewStateRepository {
  get(workspaceId: string, viewId: string): Promise<ViewLocalState | null>;
  set(workspaceId: string, viewId: string, state: ViewLocalState): Promise<void>;
  forget(workspaceId: string): Promise<void>;
}
export type ViewsPublisher = (event: ViewsChangedEvent) => void;
export type FileProviderFactory = (root: string) => FileProvider;
```

- [ ] **Step 2: `core/views/view-file.ts`** — delete the three node imports; `isMissing` reads `(error as { code?: string })?.code`; `readBounded` moves to the adapter (Task 4). Give the I/O functions a `files: ViewFiles` first parameter:
  - `realDir(files, root, dir)`: `(await lstat(path.join(root, …))).isDirectory()` → `(await files.kind(root, parts.slice(0, i).join('/'))) === 'directory'`.
  - rule-file read (line 88) and view read (line 109): `readBounded(path.join(root, rel), label)` → `files.readBounded(root, rel, label)`.
  - `listViewFiles(files, root, sets?)`: `readdir(…, { withFileTypes: true })` → `files.list(root, VIEWS_DIR)` with `.filter(d => d.name.endsWith('.yaml') && !d.directory)`.
  - `readViewFile(files, root, slug, sets?)`: `lstat(path.join(root, VIEWS_DIR, …))` → `files.kind(root, `${VIEWS_DIR}/${slug}.yaml`)`.
  - `loadViewPath(files, root, relFile, sets?)`: line 149 → `const file = files.relative(root, relFile);`, `path.isAbsolute(file)` → `path.isAbsolute(file)` (posix).
  - every internal caller (`safeLoad`, `loadView`, …) passes `files` through. `tablesView` and `inScope` stay pure (no new parameter).
- [ ] **Step 3: `core/views/save-view.ts`** — delete node imports; `saveViewAs(files, root, input)`; `viewsDir(files, root)`: `lstat(dir)` → `files.kind(root, parts.slice(0, i).join('/'))`, `mkdir(dir)` → `files.mkdir(root, parts.slice(0, i).join('/'))`; `baseDocument(files, root, basedOn)` uses `files.readBounded(root, file, 'View file')`; `Buffer.byteLength(text)` → `new TextEncoder().encode(text).length`; `readdir(path.join(root, VIEWS_DIR))` → `(await files.list(root, VIEWS_DIR)).map(e => e.name)`; the open/write/unlink block becomes
```ts
  try { await files.createExclusive(root, file, text); } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') throw new Error(`${file} already exists; choose another name.`);
    throw error;
  }
```
- [ ] **Step 4: `core/views/view-state.ts`** — keep the header comment and `MAX_VIEW_STATES, MAX_VIEW_STATE_BYTES`; the `ViewStateStore` class moves to `electron/adapters/driven/sqlite/view-state-repository.ts` as `SqliteViewStateStore implements ViewStateRepository` (body verbatim; imports `MAX_VIEW_STATES`, `MAX_VIEW_STATE_BYTES` from `../../../core/views`, `viewLocalStateSchema` from shared contracts, `database`, `transaction` from `./database`).
- [ ] **Step 5: `core/views/graph.ts`** — add a degraded graph for rule 2:

```ts
/** Stand-in when the graph host failed: no symbols, graph status unavailable, evaluation rejects like a down worker. */
export function unavailableGraph(workspaceId: string, root: string, message: string): WorktreeGraph {
  const status = { state: 'unavailable' as const, message };
  return { workspaceId, root, status: () => status, onChange: () => () => {}, onStatus: () => () => {},
    findSymbols: async queries => queries.map(() => null), callees: async () => null, fileSymbols: async () => null,
    evaluateView: async () => { throw new Error('Code graph process unavailable'); } };
}
```
- [ ] **Step 6: `core/views/service.ts`** — constructor options become
```ts
  constructor(options: { host: GraphHost; grammarPath: string; emit: ViewsPublisher; debounceMs?: number;
    viewFiles: ViewFiles; fileProvider: FileProviderFactory; log?: (message: string, error: unknown) => void })
```
store `viewFiles`, `fileProvider`, `log` (default `console.error`); `listViewFiles(root)` → `listViewFiles(this.viewFiles, root)` (3 sites), `readViewFile(root, viewId)` → `readViewFile(this.viewFiles, root, viewId)`, `createFileProvider(root).read` → `this.fileProvider(root).read`; delete the `./rules/files` import. Rule 2 in `worktree()`:
```ts
    let graph: WorktreeGraph;
    try { graph = this.host.open(workspaceId, root); } catch (error) {
      this.log('Code graph unavailable for views:', error);
      graph = unavailableGraph(workspaceId, root, 'Code graph unavailable; views without the graph still work.');
    }
```
(the reopen path `this.host.open(workspaceId, root)` for an existing worktree is wrapped the same way, ignoring the error). `timer: NodeJS.Timeout` → `ReturnType<typeof setTimeout>`.
- [ ] **Step 7: `core/views/index.ts`** — export `ViewService`, the port types, `unavailableGraph`, `MAX_VIEW_STATES`, `MAX_VIEW_STATE_BYTES`, `type FileProvider`, `type GraphHost`, `type WorktreeGraph`, `type GraphChange`, `type SymbolQuery`, `inScope`, `listViewFiles`, `readViewFile`, `loadViewPath`, `tablesView`, `saveViewAs`, `viewSlug`, `computeView`, `evaluate`, `createEvaluate`, `LIMITS`, `calleesOf`, `BUILTIN_SETS`, `TS_EXTRACTORS`, `EXTRACTOR_DESCRIPTIONS`, `explainPair`, and every other name Task 6's wiring re-exports.

### Task 4: Driven adapters — walker, file provider, view files (TDD for the walker)

- [ ] **Step 1: `tests/views/walk.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SKIPPED_DIRS, walkFiles } from '../../electron/adapters/driven/fs/walk';

async function tree(files: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-walk-'));
  for (const f of files) { await mkdir(path.join(root, path.dirname(f)), { recursive: true }); await writeFile(path.join(root, f), 'x'); }
  return root;
}

test('symlinks are skipped; every skip-set name is skipped at any depth; output is sorted', async () => {
  const skipped = [...SKIPPED_DIRS].flatMap(d => [`${d}/a.ts`, `deep/${d}/b.ts`]);
  const root = await tree(['z.ts', 'a/b.ts', 'a-c.ts', ...skipped]);
  try {
    await symlink(path.join(root, 'z.ts'), path.join(root, 'link.ts'));
    await symlink(path.join(root, 'a'), path.join(root, 'linkdir'));
    const { files, truncated } = await walkFiles(root, { keep: () => true });
    assert.deepEqual(files, ['a-c.ts', 'a/b.ts', 'z.ts']);
    assert.equal(truncated, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dot-dirs outside the skip set are walked by default and skipped with skipDotDirs', async () => {
  const root = await tree(['.stingray/views/v.yaml', 'src/a.py', '.hidden/x.py']);
  try {
    assert.deepEqual((await walkFiles(root, { keep: () => true })).files, ['.hidden/x.py', '.stingray/views/v.yaml', 'src/a.py']);
    assert.deepEqual((await walkFiles(root, { keep: () => true, skipDotDirs: true })).files, ['src/a.py']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('entry cap, caller entry cap and the 5000 kept-file cap each set truncated', async () => {
  const root = await tree(Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`));
  try {
    assert.equal((await walkFiles(root, { keep: () => true, maxEntries: 20 })).truncated, true);
    assert.equal((await walkFiles(root, { keep: () => true, maxFiles: 10 })).files.length, 10);
    assert.equal((await walkFiles(root, { keep: () => true, maxFiles: 10 })).truncated, true);
    assert.equal((await walkFiles(root, { keep: () => true })).truncated, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unreadable subdirectory is reported through onDirError; an unreadable root throws', async () => {
  const root = await tree(['ok/a.ts', 'locked/b.ts']);
  try {
    await chmod(path.join(root, 'locked'), 0o000);
    const errors: string[] = [];
    const { files } = await walkFiles(root, { keep: () => true, onDirError: dir => errors.push(dir) });
    assert.deepEqual(files, ['ok/a.ts']);
    assert.deepEqual(errors, ['locked']);
    await assert.rejects(walkFiles(path.join(root, 'missing'), { keep: () => true }));
  } finally { await chmod(path.join(root, 'locked'), 0o755); await rm(root, { recursive: true, force: true }); }
});
```
(The default caps — 200 000 entries, 5 000 kept files — are the defaults of `walkFiles`; the test drives them through the same option code path with small values.)

- [ ] **Step 2: Run** — FAIL (module missing).

- [ ] **Step 3: `electron/adapters/driven/fs/walk.ts`**

```ts
// The one worktree walker (audit 16): never follows symlinks, skips generated/vendored dirs, bounded, sorted output.
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** Union of the skip lists of the former views, db-schema and sql-schema walkers. */
export const SKIPPED_DIRS = new Set(['.git', '.codegraph', 'node_modules', 'dist', 'dist-electron', 'build', '.venv', 'venv', '__pycache__', '.next', 'target', 'site-packages']);
export const MAX_WALKED = 200_000, MAX_FILES = 5000;

export interface WalkOptions {
  keep(rel: string): boolean;
  /** Also skip every directory whose name starts with '.' (db-schema and sql-schema scanners). */
  skipDotDirs?: boolean;
  /** Directory entries visited before stopping (default 200 000; schema scanners pass 20 000). */
  maxEntries?: number;
  /** Kept files before stopping (default 5 000). */
  maxFiles?: number;
  onDirError?: (rel: string, error: Error) => void;
}

/** Throws when the root itself is unreadable. */
export async function walkFiles(root: string, options: WalkOptions): Promise<{ files: string[]; truncated: boolean }> {
  const { keep, skipDotDirs = false, maxEntries = MAX_WALKED, maxFiles = MAX_FILES, onDirError } = options;
  const files: string[] = [];
  let walked = 0;
  const walk = async (dir: string): Promise<boolean> => {
    let entries;
    try { entries = await readdir(path.join(root, dir), { withFileTypes: true }); } catch (error) {
      if (!dir) throw error;
      onDirError?.(dir, error as Error); return true;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (++walked > maxEntries) return false;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      // Dirent types come from lstat semantics: symlinks are neither files nor directories here.
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || (skipDotDirs && entry.name.startsWith('.'))) continue;
        if (!(await walk(rel))) return false;
      } else if (entry.isFile() && keep(rel)) {
        if (files.length >= maxFiles) return false;
        files.push(rel);
      }
    }
    return true;
  };
  const complete = await walk('');
  return { files: files.sort(), truncated: !complete };
}
```

- [ ] **Step 4: `electron/adapters/driven/fs/files.ts`** — `list(keep)` becomes:

```ts
    async list(keep = () => true) {
      // Views stay silent on unreadable directories and an unreadable root, as before.
      try { return await walkFiles(root, { keep }); } catch { return { files: [], truncated: false }; }
    },
```
delete `SKIPPED_DIRS`, `MAX_WALKED` and the old walk; keep `export const MAX_SOURCE_BYTES = 1024 * 1024, MAX_FILES = 5000, MAX_WALKED = 200_000;` (tests import `MAX_FILES`, `MAX_SOURCE_BYTES`); `read()` unchanged. `FileProvider` type import from `../../../core/views`.

- [ ] **Step 5: `electron/adapters/driven/fs/view-files.ts`**

```ts
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MAX_VIEW_FILE_BYTES, type ViewFiles } from '../../../core/views';

export const nodeViewFiles: ViewFiles = {
  async kind(root, rel) { const s = await lstat(path.join(root, rel)); return s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other'; },
  readBounded: (root, rel, label) => readBounded(path.join(root, rel), label),
  list: async (root, relDir) => (await readdir(path.join(root, relDir), { withFileTypes: true })).map(d => ({ name: d.name, directory: d.isDirectory() })),
  mkdir: async (root, relDir) => { await mkdir(path.join(root, relDir)); },
  async createExclusive(root, rel, text) {
    const file = path.join(root, rel);
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(text); } catch (error) {
      await handle.close(); await unlink(file).catch(() => {}); // a partial file would block every retry
      throw error;
    }
    await handle.close();
  },
  relative: (root, relFile) => path.relative(root, path.resolve(root, relFile)).split(path.sep).join('/'),
};
```
followed by `readBounded(file, label)` moved verbatim from `core/views/view-file.ts:51-70` (not exported).

### Task 5: Rule 2 and rule 1 tests (TDD)

- [ ] **Step 1: `tests/fakes/views.ts`**

```ts
import type { GraphHost, ViewFiles, WorktreeGraph } from '../../electron/core/views';

export function throwingHost(): GraphHost & { opened: number } {
  const host = { opened: 0, open(): WorktreeGraph { host.opened++; throw new Error('graph host crashed'); }, async close() {}, async closeAll() {} };
  return host;
}
/** In-memory worktree: paths → text; directories are implied by paths. */
export function memoryViewFiles(files: Record<string, string>): ViewFiles {
  const isDir = (rel: string) => Object.keys(files).some(f => f.startsWith(rel + '/'));
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    kind: async (_root, rel) => { if (rel in files) return 'file'; if (isDir(rel)) return 'directory'; throw missing(); },
    readBounded: async (_root, rel) => { if (!(rel in files)) throw missing(); return { text: files[rel] }; },
    list: async (_root, dir) => { if (!isDir(dir)) throw missing(); return [...new Set(Object.keys(files).filter(f => f.startsWith(dir + '/')).map(f => f.slice(dir.length + 1).split('/')[0]))].map(name => ({ name, directory: isDir(`${dir}/${name}`) })); },
    mkdir: async () => {}, createExclusive: async (_root, rel, text) => { files[rel] = text; },
    relative: (_root, rel) => rel,
  };
}
```

- [ ] **Step 2: `tests/views/view-service.core.test.ts`**

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ViewService } from '../../electron/core/views';
import { provideGlobMatcher, provideHasher, resetCorePorts } from '../../electron/core/shared/ports';
import { fakeHasher } from '../fakes/git';
import { memoryViewFiles, throwingHost } from '../fakes/views';

const grammarPath = path.join(import.meta.dirname, '../../electron/adapters/driven/tree-sitter/tree-sitter-python.wasm');
beforeEach(() => { provideHasher(fakeHasher); provideGlobMatcher({ matches: (file, glob) => glob === '**/*' || file === glob }); });
afterEach(() => resetCorePorts());

test('rule 2: a crashing graph host leaves the view list and the Database view working, graph unavailable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-views-core-'));
  try {
    const service = new ViewService({ host: throwingHost(), grammarPath, emit: () => {}, viewFiles: memoryViewFiles({}),
      fileProvider: () => ({ list: async () => ({ files: [], truncated: false }), read: async () => null }), log: () => {} });
    const views = await service.listViews('w1', root);
    assert.ok(views.some(v => v.id === 'database'));
    const database = await service.computeView('w1', root, 'database');
    assert.equal(database.graph.state, 'unavailable');
  } finally { await rm(root, { recursive: true, force: true }); }
});
```
(Plan 05g adds a required `dbSchema` option to `ViewService`: it updates this test's constructor call with a fake source and adds the `DbSchemaSource` rejection case.)

- [ ] **Step 3: `tests/views/views-cli.core.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCliSafely, type CliDeps } from '../../electron/adapters/driving/cli/views-cli';

test('rule 1: a failing core call ends the CLI with exit code 1 and a message, never a throw', async () => {
  const err: string[] = [];
  const deps = { cwd: '/', out: () => {}, err: (t: string) => { err.push(t); }, listViews: async () => { throw new Error('core exploded\nstack'); },
    loadViewPath: async () => { throw new Error('unused'); }, evaluate: async () => { throw new Error('unused'); }, createFileProvider: () => { throw new Error('unused'); },
    openGraph: async () => ({ api: null, status: { state: 'unavailable', message: null } }), grammarDir: () => '/g', dbSchema: async () => { throw new Error('unused'); },
    sqlSchema: async () => { throw new Error('unused'); }, skillFile: '/none', version: '0', worktreeRoot: async () => '/' } as unknown as CliDeps;
  assert.equal(await runCliSafely(['list'], deps), 1);
  assert.deepEqual(err, ['stingray-views: core exploded']);
});
```
Check `list()` in `views-cli.ts` (line 104): if it already catches `listViews` errors and prints them, use the `check` command with a `loadViewPath` that throws instead and assert the same; the point is a rejection escaping `runCli` becomes exit 1 + one message.

- [ ] **Step 4: Run** — FAIL (`runCliSafely` missing; `ViewService` options).

- [ ] **Step 5: `electron/adapters/driving/cli/views-cli.ts`**

- `CliDeps` gains `worktreeRoot(dir: string): Promise<string | null>;`; delete the exported `worktreeRoot` function (it moves to `electron/app/wiring/views.ts`, Task 6), `exec`, `realpath`/`stat` imports if now unused, and the runner import; line 119 `await worktreeRoot(path.dirname(file))` → `await deps.worktreeRoot(path.dirname(file))`.
- Delete `openGraph`, `main()` and the `require.main` line (they move to `electron/app/views-cli.ts`). Keep `short`.
- Add the error boundary:
```ts
/** Rule 1: one error boundary per CLI run — exit code 1 and a one-line message instead of a throw. */
export async function runCliSafely(argv: string[], deps: CliDeps): Promise<number> {
  try { return await runCli(argv, deps); } catch (error) { deps.err(`stingray-views: ${short(error)}`); return 1; }
}
```
- Every `./views/...` import → `../../../core/views` (index); `loadViewPath`/`listViewFiles` are reached only through `deps`.

- [ ] **Step 6: `electron/app/views-cli.ts`** (process entry: `main()` and `openGraph()` moved verbatim from the driving adapter; `worktreeRoot` now lives in `electron/app/wiring/views.ts`, Task 6)

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCliSafely, type CliDeps, type OpenedGraph } from '../adapters/driving/cli/views-cli';
import { createGraphApi } from '../adapters/driven/stinggraph-worker/stinggraph-api';
import { listViewFiles, loadViewPath, worktreeRoot } from './wiring/views';

// openGraph(): today's adapters/driving/cli/views-cli.ts lines 254-267 verbatim, with `await import('./views/rules/codegraph-api')` replaced by the static `createGraphApi` import.
// main(): today's lines 269-288 verbatim, with: the dynamic imports pointing at '../core/views' (evaluate), '../adapters/driven/tree-sitter/grammars',
// '../adapters/driven/fs/files', './wiring/db-schema' (extractDbSchema, extractSqlSchema — plan 05g; until then '../core/db-schema/db-schema' and
// '../core/db-schema/sql-schema'); `worktreeRoot` added to `deps`; `runCli(...)` + its try/catch replaced by `const code = await runCliSafely(process.argv.slice(2), deps);`.
if (typeof require !== 'undefined' && require.main === module) void main();
```
`scripts/build-electron.mjs`: entry `'views-cli': 'electron/app/views-cli.ts'`.

- [ ] **Step 7: Run** — `npx tsx --test tests/views/view-service.core.test.ts tests/views/views-cli.core.test.ts tests/views/walk.test.ts` → PASS.

### Task 6: Wiring, IPC handlers, main, existing tests

- [ ] **Step 1: `electron/app/wiring/views.ts`**

```ts
// Views core + real adapters under the names and signatures the app and the existing tests use.
import './core-ports';
import type { ViewsChangedEvent, SaveViewInput } from '../../../shared/contracts/views';
import { createFileProvider } from '../../adapters/driven/fs/files';
import { nodeViewFiles } from '../../adapters/driven/fs/view-files';
import { SqliteViewStateStore } from '../../adapters/driven/sqlite/view-state-repository';
import * as core from '../../core/views';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../../adapters/driven/git/runner';
import { runCli as runCliCore, type CliDeps as DrivingCliDeps } from '../../adapters/driving/cli/views-cli';

export class ViewService extends core.ViewService {
  constructor(options: { host: core.GraphHost; grammarPath: string; emit: (event: ViewsChangedEvent) => void; debounceMs?: number }) {
    super({ ...options, viewFiles: nodeViewFiles, fileProvider: createFileProvider });
  }
}
export { SqliteViewStateStore as ViewStateStore };
/** Worktree of `dir`: git toplevel, else the nearest ancestor containing .stingray; null when neither. (Moved from the CLI adapter.) */
export async function worktreeRoot(dir: string): Promise<string | null> {
  try { return await realpath((await runGit(dir, ['rev-parse', '--show-toplevel'], { timeout: 10_000 })).trim()); } catch { /* not a git worktree (or no git) */ }
  for (let d = await realpath(dir); ; d = path.dirname(d)) {
    if (await stat(path.join(d, '.stingray')).then(s => s.isDirectory(), () => false)) return d;
    if (path.dirname(d) === d) return null;
  }
}
export const listViewFiles = (root: string, sets?: Parameters<typeof core.listViewFiles>[2]) => core.listViewFiles(nodeViewFiles, root, sets);
export const readViewFile = (root: string, slug: string, sets?: Parameters<typeof core.readViewFile>[3]) => core.readViewFile(nodeViewFiles, root, slug, sets);
export const loadViewPath = (root: string, relFile: string, sets?: Parameters<typeof core.loadViewPath>[3]) => core.loadViewPath(nodeViewFiles, root, relFile, sets);
export const saveViewAs = (root: string, input: SaveViewInput) => core.saveViewAs(nodeViewFiles, root, input);
export type CliDeps = Omit<DrivingCliDeps, 'worktreeRoot'> & Partial<Pick<DrivingCliDeps, 'worktreeRoot'>>;
export const runCli = (argv: string[], deps: CliDeps) => runCliCore(argv, { worktreeRoot, ...deps });
export { createFileProvider, MAX_FILES, MAX_SOURCE_BYTES } from '../../adapters/driven/fs/files';
export { codegraphGrammarDir, initTreeSitter, GRAMMAR_FILES } from '../../adapters/driven/tree-sitter/grammars';
export {
  MAX_VIEW_STATES, computeView, databaseView, applyExplain, bodyFingerprint, collectPieces, compareFingerprint, describeChanges, drawnFingerprint,
  explainTargets, MAX_EXPLANATION, docstringSummary, explanationOf, MAX_FLOWCHART_NODES, callLabel, caseLabel, decisionLabel, endLabel,
  errorLabel, loopLabel, splitWords, words, withInfraServices, calleesOf, LIMITS, createEvaluate, evaluate, MAX_GRAPH_NODES, runGraphStep,
  runLayers, YamlError, parseRuleFileYaml, parseViewYaml, renderTemplate, templateCaptures, LINK_SETS, viewSlug, SEQUENCE_LIMITS,
  BUILTIN_SETS, TS_EXTRACTORS, EXTRACTOR_DESCRIPTIONS, MAX_VIEW_FILES, inScope, tablesView, fileImports, externalCall,
} from '../../core/views';
```
Make sure every name in the last `export { … }` is exported by `electron/core/views/index.ts` (Task 3 Step 7; add the missing ones — they are the runtime names the existing tests import, list from `grep -rhoE "import \{[^}]*\} from '[^']*core/views[^']*'" tests`).

- [ ] **Step 2: Existing tests (import paths only)** — in `tests/views/*.ts` and `tests/stinggraph/*.ts`, point every **runtime** import from `electron/core/views/**`, from `adapters/driven/fs/{files,launcher}`, `adapters/driven/tree-sitter/grammars`, `adapters/driving/cli/views-cli` (`runCli`, `worktreeRoot`, `CliDeps`), `core/views/view-state` (`ViewStateStore`, `MAX_VIEW_STATES`) and `core/views/save-view` at `../../electron/app/wiring/views` (`installLauncher` and `createGraphApi` stay on their adapter paths). Type-only imports may stay. Dynamic imports in `tests/views/sequence.test.ts:318-319` → `../../electron/app/wiring/views`. Run `npm run typecheck` until clean.

- [ ] **Step 3: `electron/adapters/driving/ipc/views.ts`**

```ts
import type { Handlers } from '../../../../shared/contracts/define';
import type { viewsContract } from '../../../../shared/contracts/views';
import { infraServiceById } from '../../../../shared/views/infra/catalog';
import type { GitService } from '../../../core/git';
import type { ViewService, ViewStateRepository } from '../../../core/views';

export function viewsHandlers(d: { views: ViewService; viewState: ViewStateRepository; git: Pick<GitService, 'workspace'>;
  saveViewAs(root: string, input: Parameters<Handlers<typeof viewsContract>['saveViewAs']>[1]): Promise<{ id: string; file: string }>;
  openExternal(url: string): Promise<void> }): Handlers<typeof viewsContract> {
  return {
    views: async id => d.views.listViews(id, (await d.git.workspace(id)).path),
    // ViewService shares concurrent computations of the same view.
    view: async (id, viewId, options) => d.views.computeView(id, (await d.git.workspace(id)).path, viewId, options),
    viewState: (id, viewId) => d.viewState.get(id, viewId),
    saveViewState: (id, viewId, state) => d.viewState.set(id, viewId, state),
    saveViewAs: async (id, input) => d.saveViewAs((await d.git.workspace(id)).path, input),
    // Only catalog ids are accepted, so the renderer can open nothing but the catalog's fixed documentation URLs.
    openServiceDocs: serviceId => {
      const service = infraServiceById(serviceId);
      if (!service) throw new Error('Unknown cloud service.');
      return d.openExternal(service.docUrl);
    },
  };
}
```
`electron/main.ts`: `ViewService`, `ViewStateStore`, `saveViewAs` from `./app/wiring/views`; `registerContract(ipc, viewsContract, viewsHandlers({ views, viewState, git, saveViewAs, openExternal: url => electronShell.openExternal(url) }))`.

- [ ] **Step 4: Ledger** — rows: "new test case in `tests/views/rules-engine.test.ts` (audit 11)"; "views/stinggraph tests: runtime imports now from `electron/app/wiring/views` (path only)".

### Task 7: Verify and commit

- [ ] **Step 1**

```bash
grep -rn "from 'node:\|from 'electron'\|from 'web-tree-sitter'\|from '@colbymchenry" electron/core/views | grep -v "import type"   # no output
grep -rn "provideGlobMatcher\|provideHasher\|provideSyntaxParser" electron | grep -v "electron/app/\|core/shared/ports.ts"           # no output
npm run check 2>&1 | tail -n 12
npm run test:e2e -- views-tab desktop
node dist-electron/views-cli.cjs --version
```
Expected: no grep output; `# fail 0`; 2 suites PASS; `stingray-views 0.1.0`.

- [ ] **Step 2: Commit**

```bash
git add -A electron scripts tests docs/plans/2026-11-23-test-edit-ledger.md
git commit -m "refactor(views): pure views core behind ports; one file walker; engine listing guard"
```

## Self-review

- Spec coverage (04 views row): ports `ViewFiles`, `FileProvider`, `SyntaxParser`, `GraphHost`, `ViewStateRepository`, `GlobMatcher`, `Hasher`, `ViewsPublisher`; adapters `fs/{walk,files,view-files,launcher,glob,hash}`, `tree-sitter/*`, `sqlite/view-state-repository`; driving `ipc/views.ts`, `cli/views-cli.ts` + `app/views-cli.ts`; tests `view-service.core.test.ts` (rule 2, graph part), `views-cli.core.test.ts` (rule 1), `posix-path.test.ts` (plan 05a), `walk.test.ts`; audit 11 and 16 (walker created).
- Walker deviation recorded: views' file provider keeps returning an empty list for an unreadable root (as today); the walker itself throws, as the db/sql scanners need (plan 05g).
