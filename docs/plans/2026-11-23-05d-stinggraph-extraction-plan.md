# 05d · Stinggraph feature extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** `electron/core/stinggraph/` holds the shared-base settings logic, the pure restart policy and the workspace
release (rule 3); the worker adapters receive their git runner, grammar dir and file provider by injection (no
cross-adapter imports); audit 5 (respawn respects backoff and crash limit) and "overlays removed on workspace removal" land.

**Architecture:** `RestartPolicy` (pure, injectable clock) decides respawns in `stinggraph-process.ts`. `releaseWorkspace(host, id)`
closes the workspace's graph and falls back to killing the worker; the removal is refused only if the kill also fails.
The process host gains `kill()` and an idempotent `close()`. `electron/app/wiring/stinggraph.ts` keeps
`createCodeGraphProcessHost(options)`, `createCodeGraphHost(options)` and `serveCodeGraph(send, exit, options)` for tests and the worker entry.

**Tech Stack:** TypeScript, `child_process.fork` (adapter), node:test.

**Spec:** [04 § Commit 5](../specs/2026-11-23-04-hexagonal-modules-design.md#commit-5--per-feature-extraction) (stinggraph row, rule 3),
[07 § 5, Small fixes "CodeGraph overlays left behind"](../specs/2026-11-23-07-audit-fixes-design.md).

**Plan-level clarification (approved):** the stinggraph port is named `GraphReleaseHost { close, kill }` (views keeps its own `GraphHost`).

**Depends on:** plan 05c committed. **Commit:** one, `refactor(stinggraph): restart policy, workspace release with kill fallback, overlay cleanup`.

---

## Files

Create: `electron/core/stinggraph/{ports,restart-policy,release}.ts`, `electron/adapters/driven/sqlite/settings-repository.ts`,
`electron/adapters/driving/ipc/stinggraph.ts`, `electron/app/wiring/stinggraph.ts`, `tests/fakes/stinggraph.ts`,
`tests/stinggraph/restart-policy.test.ts`, `tests/stinggraph/release.test.ts`.

Modify: `electron/core/stinggraph/{stinggraph-settings,index}.ts`, `electron/adapters/driven/stinggraph-worker/{stinggraph,stinggraph-process,stinggraph-overlay}.ts`,
`electron/app/stinggraph-worker.ts`, `electron/main.ts`, `tests/stinggraph/stinggraph-process.test.ts` (listed assertion replacement + new cases),
`tests/stinggraph/stinggraph-overlay.test.ts` (new case), `tests/git/workspace-lifecycle.test.ts` (rule-3 cases), test import paths.

---

### Task 1: `RestartPolicy` (TDD, fake clock)

- [ ] **Step 1: `tests/stinggraph/restart-policy.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RestartPolicy } from '../../electron/core/stinggraph';

function clock() { let now = 1_000_000; return { now: () => now, advance: (ms: number) => { now += ms; } }; }

test('backoff is 1, 2, 4 s for quick crashes; the 4th quick crash stops automatic restarts', () => {
  const c = clock(), p = new RestartPolicy({ now: c.now });
  const delays: (number | null)[] = [];
  for (let i = 0; i < 4; i++) { p.started(); c.advance(100); delays.push(p.crashed(true)); p.timerFired(); }
  assert.deepEqual(delays, [1000, 2000, 4000, null]);
});

test('no restart without active graphs', () => {
  const c = clock(), p = new RestartPolicy({ now: c.now });
  p.started(); assert.equal(p.crashed(false), null);
});

test('open() may respawn only without a pending timer and outside the 30 s crash-limit window', () => {
  const c = clock(), p = new RestartPolicy({ now: c.now });
  assert.equal(p.mayRespawnOnOpen(), true);
  p.started(); c.advance(10); p.crashed(true);
  assert.equal(p.mayRespawnOnOpen(), false, 'backoff timer pending');
  p.timerFired();
  for (let i = 0; i < 3; i++) { p.started(); c.advance(10); p.crashed(true); p.timerFired(); }
  assert.equal(p.mayRespawnOnOpen(), false, 'limit reached, last crash < 30 s ago');
  c.advance(30_001);
  assert.equal(p.mayRespawnOnOpen(), true);
});

test('a child that lived 30 s resets the crash count', () => {
  const c = clock(), p = new RestartPolicy({ now: c.now });
  for (let i = 0; i < 3; i++) { p.started(); c.advance(10); p.crashed(true); p.timerFired(); }
  p.started(); c.advance(30_000); assert.equal(p.crashed(true), 1000);
});
```

- [ ] **Step 2: Run** — FAIL (missing).

- [ ] **Step 3: `electron/core/stinggraph/restart-policy.ts`**

```ts
// When the code-graph worker may be (re)started: backoff 1 s, 2 s, 4 s after quick crashes (each within 30 s of its
// start); after more than 3 quick crashes it stays down until an open() 30 s after the last crash (audit 5).
const QUICK_MS = 30_000, MAX_QUICK = 3;
export class RestartPolicy {
  private crashes = 0; private startedAt = 0; private lastCrashAt = 0; private pending = false;
  private readonly now: () => number;
  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }
  started() { this.startedAt = this.now(); }
  /** A crash (not a deliberate kill). Returns the restart delay, or null when no automatic restart follows. */
  crashed(hasActiveGraphs: boolean): number | null {
    this.crashes = this.now() - this.startedAt < QUICK_MS ? this.crashes + 1 : 1;
    this.lastCrashAt = this.now();
    if (this.crashes > MAX_QUICK || !hasActiveGraphs) return null;
    this.pending = true;
    return 1000 * 2 ** (this.crashes - 1);
  }
  timerFired() { this.pending = false; }
  /** open() with no worker running. */
  mayRespawnOnOpen(): boolean {
    if (this.pending) return false;
    return !(this.crashes > MAX_QUICK && this.now() - this.lastCrashAt < QUICK_MS);
  }
}
```

- [ ] **Step 4: Run** — PASS.

### Task 2: `releaseWorkspace` and `GraphReleaseHost` (rule 3, TDD)

- [ ] **Step 1: `tests/fakes/stinggraph.ts`**

```ts
import type { GraphReleaseHost } from '../../electron/core/stinggraph';

export function fakeReleaseHost(o: { closeFails?: boolean; killFails?: boolean } = {}): GraphReleaseHost & { closed: string[]; kills: number } {
  const host = { closed: [] as string[], kills: 0,
    async close(id: string) { host.closed.push(id); if (o.closeFails) throw new Error('close failed'); },
    async kill() { host.kills++; if (o.killFails) throw new Error('kill failed'); } };
  return host;
}
```

- [ ] **Step 2: `tests/stinggraph/release.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAPH_RELEASE_REFUSED, releaseWorkspace } from '../../electron/core/stinggraph';
import { fakeReleaseHost } from '../fakes/stinggraph';

const quiet = () => {};
test('a successful close needs no kill', async () => {
  const host = fakeReleaseHost();
  await releaseWorkspace(host, 'w1', quiet);
  assert.deepEqual([host.closed, host.kills], [['w1'], 0]);
});
test('close fails → kill is called once and the release succeeds', async () => {
  const host = fakeReleaseHost({ closeFails: true });
  await releaseWorkspace(host, 'w1', quiet);
  assert.equal(host.kills, 1);
});
test('close and kill fail → rejects with the removal-refused message', async () => {
  const host = fakeReleaseHost({ closeFails: true, killFails: true });
  await assert.rejects(releaseWorkspace(host, 'w1', quiet), new RegExp(`^Error: ${GRAPH_RELEASE_REFUSED.replace(/\./g, '\\.')}$`));
});
```

- [ ] **Step 3: Run** — FAIL.

- [ ] **Step 4: `electron/core/stinggraph/ports.ts`**

```ts
import type { State } from '../../../shared/contracts/git';
/** The worker host as the release needs it: close one workspace's graph, or stop the whole worker. */
export interface GraphReleaseHost { close(workspaceId: string): Promise<void>; kill(): Promise<void> }
export type StateReader = () => State;
```

`SettingsRepository` is shared by two features (stinggraph now, app editor settings in plan 06), so it goes to
`electron/core/shared/ports.ts` (append; it is a plain interface, no slot):

```ts
/** Key/value rows of the app database's settings table (synchronous: read on every graph open). */
export interface SettingsRepository { get(key: string): string | undefined; set(key: string, value: string): void }
```

- [ ] **Step 5: `electron/core/stinggraph/release.ts`**

```ts
import type { GraphReleaseHost } from './ports';

export const GRAPH_RELEASE_REFUSED = 'Could not stop the code graph for this workspace. Close Stingray and try again.';

/** Blocking beforeRemove listener: the worker must not hold files in a folder being deleted. A failed close kills the
 * worker (other workspaces' graphs reopen on their next open()); only a failed kill refuses the removal. */
export async function releaseWorkspace(host: GraphReleaseHost, workspaceId: string,
  log: (message: string, error: unknown) => void = (m, e) => console.error(m, e)): Promise<void> {
  try { await host.close(workspaceId); return; } catch (error) { log('Code graph release failed; stopping the worker:', error); }
  try { await host.kill(); } catch (error) { log('Code graph worker could not be stopped:', error); throw new Error(GRAPH_RELEASE_REFUSED); }
}
```

- [ ] **Step 6: Run** — PASS.

### Task 3: Settings core + SQLite repository

- [ ] **Step 1: Rewrite `electron/core/stinggraph/stinggraph-settings.ts`** (same queries' logic, no database import)

```ts
// The codegraph.sharedBase setting (off by default) and the worktrees it applies to.
import type { SettingsRepository } from '../shared/ports';
import type { SharedBaseTarget, StateReader } from './ports';

export const SHARED_BASE_SETTING = 'codegraph.sharedBase';
export class StinggraphSettings {
  constructor(private settings: SettingsRepository, private readState: StateReader, private dataDir: string) {}
  sharedBaseEnabled(): boolean { return this.settings.get(SHARED_BASE_SETTING) === 'on'; }
  setSharedBase(enabled: boolean) { this.settings.set(SHARED_BASE_SETTING, enabled ? 'on' : 'off'); return { sharedBase: this.sharedBaseEnabled() }; }
  /** The shared base for a Stingray-managed worktree when the setting is on; null means its own full index. */
  sharedBaseTarget(workspaceId: string): SharedBaseTarget | null {
    if (!this.sharedBaseEnabled()) return null;
    const state = this.readState();
    const workspace = state.workspaces.find(w => w.id === workspaceId);
    const repo = workspace?.managed ? state.repos.find(r => r.id === workspace.repoId) : undefined;
    return repo ? { repoId: repo.id, repoPath: repo.path, dataDir: this.dataDir } : null;
  }
  /** The managed worktrees sharing `workspaceId`'s base, itself included. */
  sharedBaseWorkspaces(workspaceId: string): { target: SharedBaseTarget; workspaceIds: string[] } | null {
    const target = this.sharedBaseTarget(workspaceId);
    if (!target) return null;
    return { target, workspaceIds: this.readState().workspaces.filter(w => w.managed && w.repoId === target.repoId).map(w => w.id) };
  }
}
```
`SharedBaseTarget` is a plain type: move its declaration (`export interface SharedBaseTarget { repoId: string; repoPath: string; dataDir: string }`) from `stinggraph-overlay.ts:13` into `electron/core/stinggraph/ports.ts`, export it from the core index, and import it from there in `stinggraph-overlay.ts`, `stinggraph.ts`, `stinggraph-process.ts` and this file (`import type { SharedBaseTarget } from './ports';`). Core then imports nothing from adapters.

- [ ] **Step 2: `electron/adapters/driven/sqlite/settings-repository.ts`**

```ts
import type { SettingsRepository } from '../../../core/shared/ports';
import { database } from './database';

/** The app database's settings table (key → value). Used by stinggraph settings and, from plan 06, editor settings. */
export function sqliteSettingsRepository(directory: string): SettingsRepository {
  return {
    get: key => (database(directory).prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value,
    set: (key, value) => { database(directory).prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value); },
  };
}
```

### Task 4: Process host — policy, `kill()`, idempotent `close()`, injected exclude; worker deps injection

- [ ] **Step 1: Assertion replacement in `tests/stinggraph/stinggraph-process.test.ts:76-82`** (listed in spec 07 § 5)

Old:
```ts
    // An open() right after a crash respawns immediately.
    children[1].kill('SIGKILL');
    await state(graph, 'unavailable');
    assert.equal(host.open('w1', root), graph);
    assert.equal(children.length, 3);
    await state(graph, 'ready');
```
New:
```ts
    // An open() right after a crash does not spawn; the backoff timer respawns once and the graph reopens.
    children[1].kill('SIGKILL');
    await state(graph, 'unavailable');
    assert.equal(host.open('w1', root), graph);
    assert.equal(children.length, 2, 'open() during the backoff does not spawn');
    await state(graph, 'ready');
    assert.equal(children.length, 3, 'the backoff timer respawned exactly once');
```
Ledger row: `| 05d | tests/stinggraph/stinggraph-process.test.ts:76-82 | "An open() right after a crash respawns immediately": open() → children.length === 3 | open() → children.length === 2; after ready → children.length === 3 | Same fake and events plus a spawn-count assertion before and after the timer: stricter (spec 07 § 5). |`

- [ ] **Step 2: New cases at the end of `tests/stinggraph/stinggraph-process.test.ts`** (fake spawn, short backoff)

```ts
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
```
(Add `import { EventEmitter } from 'node:events';` to the test's imports. `createCodeGraphProcessHost` is imported from `../../electron/app/wiring/stinggraph` — Step 6.)

- [ ] **Step 3: Run** — `npx tsx --test tests/stinggraph/stinggraph-process.test.ts` → FAIL (new options / `kill`).

- [ ] **Step 4: Edit `electron/adapters/driven/stinggraph-worker/stinggraph-process.ts`**

1. Header comment lines 4-5 become: `// Crashes: open graphs turn 'unavailable' and the child is respawned after 1s, 2s, 4s; after more than 3 quick crashes (each`
   `// within 30s of its start) it stays down until an open() 30 s after the last crash (RestartPolicy). A deliberate kill() is not a crash.`
2. Delete `import { excludeCodeGraphCache } from '../git/git-exclude';`; add `import { RestartPolicy, type SharedBaseTarget } from '../../../core/stinggraph';`.
3. Options: add
```ts
  /** Adds .codegraph/ to the repository's info/exclude (driven/git, injected by electron/app). */
  exclude: (root: string) => Promise<void>;
  now?: () => number;      // RestartPolicy clock (tests)
  restartBaseMs?: number;  // backoff unit, default 1000 (tests)
```
and `CodeGraphProcessHost` gains `/** Stop the worker now (rule 3 fallback); not counted as a crash. */ kill(): Promise<void>;`.
4. Replace `let child … crashes = 0, startedAt = 0, restart` with `let child: ChildProcess | null = null, nextId = 0, restart: ReturnType<typeof setTimeout> | undefined; const policy = new RestartPolicy({ now }); const closing = new Map<string, Promise<void>>();` (destructure `exclude, now, restartBaseMs = 1000` from options).
5. `exited()`:
```ts
  const exited = (c: ChildProcess, why: string) => {
    if (child !== c) return; // closeAll, kill() or an earlier error already handled it
    child = null; settleAll();
    try { c.kill('SIGKILL'); } catch { /* already gone */ }
    const delay = policy.crashed(active().length > 0);
    const message = `Code graph process stopped (${why}); ${delay !== null ? 'restarting' : 'reopen the view to retry'}.`;
    for (const graph of active()) graph.setStatus('unavailable', message);
    if (delay !== null) restart = setTimeout(() => { restart = undefined; policy.timerFired(); if (!child) respawn(); }, delay / 1000 * restartBaseMs);
  };
```
6. `respawn()`: replace `child = c; startedAt = Date.now();` with `child = c; policy.started();`.
7. `open()`: `excludeCodeGraphCache(root)` → `exclude(root)`; `if (child) post(openRequest(workspaceId, root)); else respawn();` → `if (child) post(openRequest(workspaceId, root)); else if (policy.mayRespawnOnOpen()) respawn();`.
8. `close()` becomes idempotent (a second close of the same workspace waits for the first):
```ts
    close(workspaceId) {
      const inFlight = closing.get(workspaceId);
      if (inFlight) return inFlight;
      const job = (async () => {
        const graph = graphs.get(workspaceId);
        graphs.delete(workspaceId);
        if (graph?.active) await evict(graph, 'Closed.');
        if (graph) await excluding.get(graph.root);
      })().finally(() => closing.delete(workspaceId));
      closing.set(workspaceId, job);
      return job;
    },
```
9. New `kill()`:
```ts
    async kill() {
      const c = child;
      clearTimeout(restart); restart = undefined;
      if (!c) return;
      child = null; settleAll();
      for (const graph of active()) graph.stop('Code graph process stopped; reopen the view to retry.');
      const gone = new Promise(resolve => { if (c.exitCode !== null || c.signalCode !== null) resolve(null); else c.once('exit', resolve); });
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
      await within(gone, timeoutMs);
      if (c.exitCode === null && c.signalCode === null) throw new Error('Code graph process did not stop.');
    },
```

- [ ] **Step 5: Worker deps injection in `stinggraph.ts` and `stinggraph-overlay.ts`** (removes the cross-adapter imports)

- `stinggraph-overlay.ts`: delete `gitOut` and the temporary runner import. Add `export type OverlayGit = (cwd: string, args: string[], env?: Record<string, string>) => Promise<string>;` and append a `git: OverlayGit` last parameter to `lsTree`, `ensureBase`, `updateBase`, `changedFiles`, `buildOverlay` (pass it through every internal call; each `gitOut(` call becomes `git(`). Add:
```ts
/** Deletes a removed workspace's overlay (db, -wal, -shm); missing files are fine. Runs whether or not shared base is on. */
export async function removeOverlay(dataDir: string, repoId: string, workspaceId: string): Promise<void> {
  const file = overlayPath({ repoId, repoPath: '', dataDir }, workspaceId);
  await Promise.all(['', '-wal', '-shm'].map(suffix => rm(file + suffix, { force: true })));
}
```
(`import { rm } from 'node:fs/promises';`).
- `stinggraph.ts`: delete the imports of `codegraphGrammarDir` and `createFileProvider` and of `gitOut`. `CodeGraphHostOptions` gains
```ts
  files?: (root: string) => FileProvider;   // driven/fs (injected by electron/app)
  gitOut?: OverlayGit;                       // driven/git runner (injected by electron/app)
```
`defaults` loses `grammarDir`; `evaluateView` uses `options.files(root)`; every `gitOut(…)` call becomes `options.gitOut(…)` (thread `options`/`settings` to the `ProxyGraph`/class that calls it — it already receives the settings object); `ensureBase(lib, shared)` → `ensureBase(lib, shared, settings.gitOut)`, `buildOverlay(…, base)` → `buildOverlay(…, base, settings.gitOut)`. `FileProvider` type comes from `../../../core/views` (index; add `export type { FileProvider } from './rules/types'` there if missing).

- [ ] **Step 6: `electron/app/wiring/stinggraph.ts`** and the worker entry

```ts
import { runGit } from '../../adapters/driven/git/runner';
import { excludeCodeGraphCache } from '../../adapters/driven/git/git-exclude';
import { createFileProvider } from '../../adapters/driven/fs/files';
import { codegraphGrammarDir } from '../../adapters/driven/tree-sitter/grammars';
import { createCodeGraphHost as createHost, serveCodeGraph as serve, type CodeGraphHostOptions } from '../../adapters/driven/stinggraph-worker/stinggraph';
import { createCodeGraphProcessHost as createProcessHost, type CodeGraphProcessHostOptions, type WorkerEvent } from '../../adapters/driven/stinggraph-worker/stinggraph-process';

const workerDeps: Required<Pick<CodeGraphHostOptions, 'grammarDir' | 'files' | 'gitOut'>> = {
  grammarDir: codegraphGrammarDir,
  files: createFileProvider,
  gitOut: (cwd, args, env = {}) => runGit(cwd, args, { timeout: 0, maxBuffer: 1 << 28, env }),
};
export const createCodeGraphHost = (options: CodeGraphHostOptions = {}) => createHost({ ...workerDeps, ...options });
export const serveCodeGraph = (send: (event: WorkerEvent) => void, exit: () => void, options: CodeGraphHostOptions = {}) => serve(send, exit, { ...workerDeps, ...options });
export const createCodeGraphProcessHost = (options: Partial<CodeGraphProcessHostOptions> = {}) => createProcessHost({ exclude: excludeCodeGraphCache, ...options });
export { removeOverlay, baseRoot, overlayPath } from '../../adapters/driven/stinggraph-worker/stinggraph-overlay';
```
(`createCodeGraphHost`/`serveCodeGraph` inside the adapter now merge `options` over the remaining `defaults` and require `grammarDir`, `files`, `gitOut` at runtime — throw `new Error('stinggraph worker deps missing')` if absent.)
`electron/app/stinggraph-worker.ts`: `import { serveCodeGraph } from './wiring/stinggraph';` (rest unchanged).
Tests: `tests/stinggraph/*.test.ts` and `tests/views/stinggraph-api.test.ts` import `createCodeGraphHost`, `serveCodeGraph`, `createCodeGraphProcessHost` from `../../electron/app/wiring/stinggraph` (import edits).

- [ ] **Step 7: Run** — `npx tsx --test tests/stinggraph/*.test.ts tests/views/stinggraph-api.test.ts` → PASS.

### Task 5: Overlay cleanup test

- [ ] **Step 1: Append to `tests/stinggraph/stinggraph-overlay.test.ts`**

```ts
test('removeOverlay deletes a workspace overlay with its -wal/-shm files and tolerates missing ones', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'stingray-overlay-rm-'));
  try {
    const target = { repoId: 'r1', repoPath: '/unused', dataDir };
    const file = overlayPath(target, 'w1');
    await mkdir(path.dirname(file), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) await writeFile(file + suffix, 'x');
    await writeFile(overlayPath(target, 'w2'), 'keep');
    await removeOverlay(dataDir, 'r1', 'w1');
    for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(file + suffix), false);
    assert.equal(existsSync(overlayPath(target, 'w2')), true);
    await removeOverlay(dataDir, 'r1', 'missing');
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
```
(Import `removeOverlay` next to `overlayPath` from `../../electron/app/wiring/stinggraph`; add `mkdtemp`, `mkdir`, `writeFile`, `rm`, `existsSync`, `tmpdir` imports only if the file lacks them.)

### Task 6: Lifecycle rule-3 cases, IPC handlers, main

- [ ] **Step 1: Append to `tests/git/workspace-lifecycle.test.ts`**

```ts
import { GitService, Store } from '../../electron/core/git';
import { provideHasher, resetCorePorts } from '../../electron/core/shared/ports';
import { releaseWorkspace, GRAPH_RELEASE_REFUSED } from '../../electron/core/stinggraph';
import type { State } from '../../shared/contracts/git';
import { fakeHasher, memoryState, pathOnlyFiles, scriptedGit } from '../fakes/git';
import { fakeReleaseHost } from '../fakes/stinggraph';

const repoId = '00000000-0000-4000-8000-000000000001', wid = '00000000-0000-4000-8000-000000000002';
const wpath = `/data/worktrees/${repoId}/${wid}`;
const state: State = { version: 1, repos: [{ id: repoId, name: 'repo', path: '/repo' }], workspaces: [
  { id: '00000000-0000-4000-8000-000000000003', repoId, name: 'main', branch: 'main', path: '/repo', managed: false, previewUrl: '' },
  { id: wid, repoId, name: 'feature', branch: 'feature', path: wpath, managed: true, previewUrl: '' }] };
/** Listeners as electron/main.ts (plan 06: compose.ts) registers them, with a fake graph host. */
function removal(host: ReturnType<typeof fakeReleaseHost>, opts: { viewsFail?: boolean; terminalsFail?: boolean; viewStateFails?: boolean } = {}) {
  const runner = scriptedGit((cwd, args) => {
    const a = args.join(' ');
    if (a === 'worktree list --porcelain -z') return `worktree /repo\0branch refs/heads/main\0\0worktree ${wpath}\0branch refs/heads/feature\0\0`;
    if (a === 'branch --show-current') return cwd === wpath ? 'feature\n' : 'main\n';
    if (a.startsWith('status --porcelain=v1')) return '';
    if (a.startsWith('for-each-ref')) return '\n';
    if (a.startsWith('worktree remove')) return '';
    return undefined;
  });
  const lifecycle = new WorkspaceLifecycle(() => {});
  const ran: string[] = [];
  lifecycle.onBeforeRemove('terminals', () => { if (opts.terminalsFail) throw new Error('Terminals could not be closed.'); }, { blocking: true });
  lifecycle.onBeforeRemove('views', async () => { if (opts.viewsFail) throw new Error('views release failed'); });
  lifecycle.onBeforeRemove('stinggraph', id => releaseWorkspace(host, id, () => {}), { blocking: true });
  lifecycle.onRemoveFailed('views', () => { ran.push('removeFailed'); });
  lifecycle.onAfterRemove('git-state', () => { ran.push('git-state'); });
  lifecycle.onAfterRemove('view state', async () => { if (opts.viewStateFails) throw new Error('db locked'); ran.push('view state'); });
  lifecycle.onAfterRemove('activity', () => { ran.push('activity'); });
  const git = new GitService({ store: new Store('/data', memoryState(state)), runner, files: pathOnlyFiles, cloner: async () => {}, lifecycle });
  const remove = async () => git.removeWorkspace(wid, { discard: false, deleteBranch: false, fingerprint: (await git.reviewRemoval(wid)).fingerprint });
  const removedFolder = () => runner.calls.some(c => c.args[0] === 'worktree' && c.args[1] === 'remove');
  return { remove, ran, removedFolder };
}

test('rule 3: view-state afterRemove rejects → activity and git-state still run, removal succeeds', async () => {
  provideHasher(fakeHasher);
  try {
    const r = removal(fakeReleaseHost(), { viewStateFails: true });
    const result = await r.remove();
    assert.ok('state' in result);
    assert.ok(r.ran.includes('git-state') && r.ran.includes('activity'));
  } finally { resetCorePorts(); }
});

test('rule 3: a views release failure never blocks; a stinggraph close failure falls back to kill', async () => {
  provideHasher(fakeHasher);
  try {
    assert.ok('state' in await removal(fakeReleaseHost(), { viewsFail: true }).remove());
    const host = fakeReleaseHost({ closeFails: true });
    const r = removal(host);
    assert.ok('state' in await r.remove());
    assert.equal(host.kills, 1);
    assert.equal(r.removedFolder(), true);
  } finally { resetCorePorts(); }
});

test('rule 3: stinggraph close and kill fail → removal refused, nothing deleted, removeFailed runs', async () => {
  provideHasher(fakeHasher);
  try {
    const r = removal(fakeReleaseHost({ closeFails: true, killFails: true }));
    await assert.rejects(r.remove(), new RegExp(GRAPH_RELEASE_REFUSED.replace(/\./g, '\\.')));
    assert.equal(r.removedFolder(), false);
    assert.deepEqual(r.ran, ['removeFailed']);
  } finally { resetCorePorts(); }
});

test('rule 3: terminals beforeRemove rejects → removal aborted, nothing deleted, removeFailed runs', async () => {
  provideHasher(fakeHasher);
  try {
    const r = removal(fakeReleaseHost(), { terminalsFail: true });
    await assert.rejects(r.remove(), /Terminals could not be closed/);
    assert.equal(r.removedFolder(), false);
    assert.deepEqual(r.ran, ['removeFailed']);
  } finally { resetCorePorts(); }
});
```

- [ ] **Step 2: `electron/adapters/driving/ipc/stinggraph.ts`** — first add the conflicts port to `electron/core/stinggraph/ports.ts`
(driving adapters must not import driven adapters, not even types):

```ts
import type { OverlayConflicts } from '@colbymchenry/codegraph';
/** Overlay conflicts between managed worktrees (implemented by the worker process host). */
export interface ConflictsSource { conflicts(shared: SharedBaseTarget, workspaceIds: string[]): Promise<OverlayConflicts | null> }
```
then:
```ts
import type { Handlers } from '../../../../shared/contracts/define';
import type { stinggraphContract } from '../../../../shared/contracts/stinggraph';
import type { ConflictsSource, StinggraphSettings } from '../../../core/stinggraph';

export function stinggraphHandlers(d: { settings: StinggraphSettings; host: ConflictsSource }): Handlers<typeof stinggraphContract> {
  return {
    codegraphSettings: () => ({ sharedBase: d.settings.sharedBaseEnabled() }),
    setCodegraphSharedBase: enabled => d.settings.setSharedBase(enabled),
    codegraphConflicts: id => { const shared = d.settings.sharedBaseWorkspaces(id); return shared ? d.host.conflicts(shared.target, shared.workspaceIds) : null; },
  };
}
```

- [ ] **Step 3: `electron/main.ts`**

```ts
const stinggraphSettings = new StinggraphSettings(sqliteSettingsRepository(app.getPath('userData')), () => readState(database(app.getPath('userData'))), app.getPath('userData'));
const codegraph = createCodeGraphProcessHost({ sharedBase: id => stinggraphSettings.sharedBaseTarget(id) });
```
(imports: `StinggraphSettings, releaseWorkspace` from `./core/stinggraph`; `sqliteSettingsRepository` from `./adapters/driven/sqlite/settings-repository`; `database`, `readState` from `./adapters/driven/sqlite/database`; `createCodeGraphProcessHost`, `removeOverlay` from `./app/wiring/stinggraph`; `stinggraphHandlers` from `./adapters/driving/ipc/stinggraph`). Replace the removal listeners with:
```ts
lifecycle.onBeforeRemove('terminals', id => terminals.closeWorkspace(id), { blocking: true });
lifecycle.onBeforeRemove('views', id => views.release(id)); // never blocks (logged)
lifecycle.onBeforeRemove('stinggraph', id => releaseWorkspace(codegraph, id), { blocking: true });
const overlayRepos = new Map<string, string>(); // workspaceId -> repoId, captured before the registration is gone
lifecycle.onBeforeRemove('stinggraph overlay', async id => { const w = (await store.load()).workspaces.find(x => x.id === id); if (w) overlayRepos.set(id, w.repoId); });
lifecycle.onRemoveFailed('views', id => views.reopen(id));
lifecycle.onRemoveFailed('stinggraph overlay', id => { overlayRepos.delete(id); });
lifecycle.onAfterRemove('git-state', id => gitState.forget(id));
lifecycle.onAfterRemove('view state', id => viewState.forget(id));
lifecycle.onAfterRemove('activity', id => activity.forgetWorkspace(id));
lifecycle.onAfterRemove('stinggraph overlay', async id => { const repoId = overlayRepos.get(id); overlayRepos.delete(id); if (repoId) await removeOverlay(app.getPath('userData'), repoId, id); });
```
and `registerContract(ipc, stinggraphContract, stinggraphHandlers({ settings: stinggraphSettings, host: codegraph }))`.

### Task 7: Verify and commit

- [ ] **Step 1**

```bash
grep -rn "from 'node:\|from 'electron'" electron/core/stinggraph                          # no output
grep -rn "from '\.\./git/\|from '\.\./fs/\|from '\.\./tree-sitter/" electron/adapters/driven/stinggraph-worker   # no output
npm run check 2>&1 | tail -n 12
npm run test:e2e -- views-tab worktree-removal desktop
```
Expected: no grep output; `# fail 0`; 3 suites PASS.

- [ ] **Step 2: Commit**

```bash
git add -A electron tests docs/plans/2026-11-23-test-edit-ledger.md
git commit -m "refactor(stinggraph): restart policy, workspace release with kill fallback, overlay cleanup"
```

## Self-review

- Spec coverage (04 stinggraph row): `stinggraph-settings.ts`, `restart-policy.ts`, `release.ts`; ports `SettingsRepository`, `GraphReleaseHost` (+ `ConflictsSource`, `StateReader`); adapters `stinggraph-worker/*`, `sqlite/settings-repository.ts`; driving `ipc/stinggraph.ts`; `restart-policy.test.ts`, `release.test.ts`; rule-3 lifecycle cases (views non-blocking, close→kill, close+kill fail, terminals fail, view state); audit 5 incl. the listed replacement; overlays removed on removal (afterRemove, repoId captured in beforeRemove).
- Kill does not count as a crash (policy untouched by `kill()`); `close()` is idempotent so the views release and the stinggraph release share one close.
