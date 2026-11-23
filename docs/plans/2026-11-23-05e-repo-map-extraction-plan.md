# 05e · Repo-map feature extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** `electron/core/repo-map/` (snapshot assembly, sizes, inspection) is pure behind `RepoInventory` and
`WorkingFiles`; `GitService.repoSnapshot`/`inspectFile` move to a new core `RepoMapService`, removing the
`git ↔ repo-map` and `repo-map ↔ repo-map-size` cycles. No behaviour change (repo-map behaviour changes are plan 07).

**Architecture:** `RepoMapService` uses git's `workspace`/`status` through the git feature's `index.ts` (edge
`repo-map → git`). Git commands with the inventory limits live in `electron/adapters/driven/git/inventory.ts`; the
symlink-safe bounded file read moves to `electron/adapters/driven/fs/working-files.ts`. The wiring `GitService` keeps
`repoSnapshot(id)`/`inspectFile(id, path)` for existing tests by delegating to its `repoMap` instance.

**Tech Stack:** TypeScript, node:test.

**Spec:** [04 § Commit 5](../specs/2026-11-23-04-hexagonal-modules-design.md#commit-5--per-feature-extraction) (repo-map row; "GitService.repoSnapshot / inspectFile move to core/repo-map").

**Depends on:** plan 05d committed. **Commit:** one, `refactor(repo-map): RepoMapService in core behind inventory and working-file ports`.

---

## Files

Create: `electron/app/wiring/core-ports.ts`, `electron/core/repo-map/ports.ts`, `electron/core/repo-map/repo-map-service.ts`, `electron/adapters/driven/git/inventory.ts`,
`electron/adapters/driven/fs/working-files.ts`, `electron/adapters/driving/ipc/repo-map.ts`, `electron/app/wiring/repo-map.ts`,
`tests/fakes/repo-map.ts`, `tests/repo-map/repo-map.core.test.ts`.

Modify: `electron/core/repo-map/{repo-map,repo-map-size,index}.ts`, `electron/core/git/git.ts` (remove snapshot methods),
`electron/app/wiring/git.ts`, `electron/main.ts`, `tests/repo-map/repo-map.test.ts` (import paths).

---

### Task 1: Ports and fakes

- [ ] **Step 1: `electron/core/repo-map/ports.ts`**

```ts
/** Git with the repository-inventory limits. */
export interface RepoInventory {
  /** 15 s / 16 MiB; `grep` exit 1 without output is ''; other failures reject with the inventory-limit message. */
  run(root: string, args: string[]): Promise<string>;
  /** 10 s / 512 KiB raw bytes (show/diff of one file); rejects on error or limit. */
  bytes(root: string, args: string[]): Promise<Uint8Array>;
  /** 'born' when HEAD^{commit} resolves; 'unborn' when HEAD's branch ref does not exist yet; rejects when HEAD is unavailable. */
  head(root: string): Promise<'born' | 'unborn'>;
}
export interface WorkingFiles {
  realpath(path: string): Promise<string>;
  /** Symlink-safe bounded read (≤ 512 KiB) of a working-tree file; null when it does not exist; rejects with a user-facing reason. */
  read(root: string, relative: string): Promise<Uint8Array | null>;
  /** lstat of a working-tree entry, never rejects. */
  probe(root: string, relative: string): Promise<'missing' | 'emptyFile' | 'other'>;
}
```

- [ ] **Step 2: `tests/fakes/repo-map.ts`**

```ts
import type { RepoInventory, WorkingFiles } from '../../electron/core/repo-map';

/** Scripted inventory: answers by the first git argument; records every call. */
export function scriptedInventory(answers: { lsFiles?: string; numstat?: string; grep?: string | Error; head?: 'born' | 'unborn' }) {
  const calls: string[][] = [];
  const inventory: RepoInventory = {
    async run(_root, args) {
      calls.push(args);
      if (args[0] === 'ls-files') return answers.lsFiles ?? '';
      if (args[0] === 'diff') return answers.numstat ?? '';
      if (args[0] === 'grep') { if (answers.grep instanceof Error) throw answers.grep; return answers.grep ?? ''; }
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
    async bytes(_root, args) { calls.push(args); return new Uint8Array(); },
    async head() { calls.push(['head']); return answers.head ?? 'born'; },
  };
  return { inventory, calls };
}
export function memoryFiles(contents: Record<string, string>): WorkingFiles {
  return {
    realpath: async p => p,
    read: async (_root, rel) => (rel in contents ? new TextEncoder().encode(contents[rel]) : null),
    probe: async (_root, rel) => (!(rel in contents) ? 'missing' : contents[rel] === '' ? 'emptyFile' : 'other'),
  };
}
```

### Task 2: Pure snapshot assembly (TDD)

- [ ] **Step 1: `tests/repo-map/repo-map.core.test.ts`**

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RepoMapService, repoSnapshot } from '../../electron/core/repo-map';
import { provideHasher, resetCorePorts } from '../../electron/core/shared/ports';
import type { GitStatus } from '../../shared/contracts/git';
import { fakeHasher } from '../fakes/git';
import { memoryFiles, scriptedInventory } from '../fakes/repo-map';

const status = (changes: GitStatus['changes']): GitStatus => ({ branch: 'main', changes, lines: { kind: 'available', added: 0, deleted: 0, binaryFiles: 0 }, uncommitted: { kind: 'available', added: 0, deleted: 0, binaryFiles: 0 }, base: 'HEAD' });
beforeEach(() => provideHasher(fakeHasher));
afterEach(() => resetCorePorts());

test('snapshot assembly: inventory + staged-deletion ghosts, net counts, sizes from grep', async () => {
  const { inventory } = scriptedInventory({ lsFiles: 'a.ts\0b.ts\0', numstat: '3\t1\ta.ts\0', grep: 'a.ts\x0010\nb.ts\x005\n' });
  const map = await repoSnapshot('/repo', status([{ path: 'a.ts', status: ' M' }, { path: 'gone.ts', status: 'D ' }]), true, { inventory, files: memoryFiles({ 'a.ts': 'x', 'b.ts': 'y' }) });
  assert.deepEqual(map.files.map(f => f.path), ['a.ts', 'b.ts', 'gone.ts']);
  assert.deepEqual(map.files[0].lines, { added: 3, removed: 1 });
  assert.deepEqual(map.files[1].lines, { added: 0, removed: 0 });
  assert.deepEqual(map.files[0].size, { state: 'known', source: 'working tree', textLines: 10 });
  assert.equal(map.statsNotice, '1 changed file(s) have unavailable line counts; totals include known counts only.');
});

test('unborn HEAD: untracked lines come from sizes', async () => {
  const { inventory } = scriptedInventory({ lsFiles: 'new.ts\0', grep: 'new.ts\x007\n', head: 'unborn' });
  const map = await repoSnapshot('/repo', status([{ path: 'new.ts', status: '??' }]), true, { inventory, files: memoryFiles({ 'new.ts': 'z' }) });
  assert.deepEqual(map.files[0].lines, { added: 7, removed: 0 });
});

test('RepoMapService shares one in-flight snapshot per worktree and inspects through the ports', async () => {
  const { inventory, calls } = scriptedInventory({ lsFiles: 'a.ts\0', grep: 'a.ts\x001\n' });
  let statusCalls = 0;
  const service = new RepoMapService({
    git: { workspace: async id => ({ id, repoId: id, name: 'w', branch: 'main', path: '/repo', managed: false, previewUrl: '' }), status: async () => { statusCalls++; return status([]); } },
    inventory, files: memoryFiles({ 'a.ts': 'hello\n' }),
  });
  const [one, two] = await Promise.all([service.repoSnapshot('w'), service.repoSnapshot('w')]);
  assert.equal(one, two);
  assert.equal(statusCalls, 1);
  const inspection = await service.inspectFile('w', 'a.ts');
  assert.equal(inspection.content, 'hello\n');
  assert.match(inspection.revision, /^[0-9a-f]{64}$/);
  assert.ok(calls.every(c => c[0] !== 'status'), 'status comes from the git port, not the inventory');
});
```

- [ ] **Step 2: Run** — FAIL (signatures / `RepoMapService` missing).

- [ ] **Step 3: Rewrite `electron/core/repo-map/repo-map.ts`** (logic unchanged)

1. Delete the node imports, `exec`, the runner import (plan 05a) and `inventoryGit`/`boundedGit`/`readWorkingFile` (they move to Task 3 adapters). Add:
```ts
import { repoPathSchema, type GitStatus } from '../../../shared/contracts/git';
import type { FileInspection, LineStats, RepoFile, RepoSnapshot } from '../../../shared/contracts/repo-map';
import { sha256 } from '../shared/ports';
import type { RepoInventory, WorkingFiles } from './ports';
import { measureSizes } from './repo-map-size';
export type RepoMapPorts = { inventory: RepoInventory; files: WorkingFiles };
```
2. `repoSnapshot(root, status, withStats = true, ports: RepoMapPorts)`: `inventoryGit(root, …)` → `ports.inventory.run(root, …)`; replace the HEAD block (lines 63-84) with
```ts
  try {
    // A missing HEAD is expected only on an unborn branch; other failures keep counts unknown.
    unborn = (await ports.inventory.head(root)) === 'unborn';
    if (!unborn) counts = parseNumstat(await ports.inventory.run(root, ['diff', 'HEAD', '--numstat', '-z', '--find-renames', '-l1000', '--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short', '--']));
  } catch { failed = true; }
```
and `await measureSizes(root, files, unborn)` → `await measureSizes(root, files, unborn, ports)`.
3. `decode(data: Uint8Array)`: same body (`data.includes(0)` and `TextDecoder` work on `Uint8Array`).
4. `inspectFile(root, relative, snapshot, ports: RepoMapPorts)`: `readWorkingFile(root, relative)` → `ports.files.read(root, relative)`; `boundedGit(root, args)` → `ports.inventory.bytes(root, args)`; `.toString('utf8')` on diff output → `new TextDecoder().decode(…)`; `let bytes: Buffer | null` → `Uint8Array | null`.
5. `finish()`: `result.revision = sha256(JSON.stringify(result));`.

- [ ] **Step 4: `electron/core/repo-map/repo-map-size.ts`**

```ts
import type { RepoFile } from '../../../shared/contracts/repo-map';
import type { RepoMapPorts } from './repo-map';

export async function measureSizes(root: string, files: RepoFile[], unborn = false, ports: RepoMapPorts) {
  const output = await ports.inventory.run(root, ['grep', '-z', '-c', '-I', '--untracked', '-e', '']);
  // … lines 8-16 unchanged …
    if (count === undefined) {
      const probe = await ports.files.probe(root, file.path);
      if (probe === 'emptyFile') file.size = { state: 'known', source: 'working tree', textLines: 0 };
      absent = probe === 'missing';
      if (absent && file.status.includes('D') && file.lines) file.size = { state: 'known', source: 'HEAD', textLines: file.lines.removed };
    }
  // … lines 23-28 unchanged …
}
```
(`import type` from `./repo-map` is type-only, so there is no runtime cycle.)

- [ ] **Step 5: `electron/core/repo-map/repo-map-service.ts`** (moved from `GitService.repoSnapshot`/`inspectFile`, `electron/core/git/git.ts`)

```ts
import type { GitService } from '../git';
import type { FileInspection, RepoSnapshot } from '../../../shared/contracts/repo-map';
import { inspectFile, repoSnapshot, type RepoMapPorts } from './repo-map';

export type RepoMapDeps = RepoMapPorts & { git: Pick<GitService, 'workspace' | 'status'> };

export class RepoMapService {
  private readonly inFlight = new Map<string, Promise<RepoSnapshot>>();
  constructor(private readonly deps: RepoMapDeps) {}
  async repoSnapshot(id: string): Promise<RepoSnapshot> {
    const w = await this.deps.git.workspace(id);
    const root = await this.deps.files.realpath(w.path);
    let job = this.inFlight.get(root);
    if (!job) {
      job = (async () => repoSnapshot(root, await this.deps.git.status(id), true, this.deps))();
      this.inFlight.set(root, job);
    }
    // Concurrent requests share one entire status/inventory/count operation.
    try { return await job; } finally { if (this.inFlight.get(root) === job) this.inFlight.delete(root); }
  }
  async inspectFile(id: string, relative: string): Promise<FileInspection> {
    const w = await this.deps.git.workspace(id);
    return inspectFile(w.path, relative, await repoSnapshot(w.path, await this.deps.git.status(id), false, this.deps), this.deps);
  }
}
```

- [ ] **Step 6: `electron/core/git/git.ts`** — delete `snapshotsInFlight`, `repoSnapshot()`, `inspectFile()` and the imports of `../repo-map/repo-map` and `RepoSnapshot`. `electron/core/repo-map/index.ts` exports `RepoMapService, type RepoMapDeps, repoSnapshot, inspectFile, parseNumstat, measureSizes, type RepoMapPorts` and the port types.

- [ ] **Step 7: Run** — `npx tsx --test tests/repo-map/repo-map.core.test.ts` → PASS.

### Task 3: Driven adapters

- [ ] **Step 1: `electron/adapters/driven/git/inventory.ts`** (bodies moved from `repo-map.ts` lines 15-27, 63-82, 109-115)

```ts
import type { RepoInventory } from '../../../core/repo-map';
import { git, runGit } from './runner';

export const gitInventory: RepoInventory = {
  async run(root, args) {
    try { return await runGit(root, args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }); } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      if (args[0] === 'grep' && failure.code === 1 && failure.stdout === '') return '';
      throw new Error('Repository inventory exceeds the 16 MiB / 15 second limit, or Git is unavailable.');
    }
  },
  bytes: (root, args) => runGit(root, args, { timeout: 10000, maxBuffer: 512 * 1024, encoding: 'buffer' }),
  async head(root) {
    try { await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']); return 'born'; } catch {
      const branch = (await git(root, ['symbolic-ref', '-q', 'HEAD'])).trim();
      if (!branch.startsWith('refs/heads/')) throw new Error('HEAD unavailable');
      // Check this exact branch, not all refs: only exit 1 means absent; corrupt refs and timeouts stay errors.
      try { await runGit(root, ['show-ref', '--verify', '--quiet', branch], { timeout: 10000, maxBuffer: 4096 }); } catch (error) {
        if ((error as { code?: number }).code === 1) return 'unborn';
        throw error;
      }
      throw new Error('HEAD unavailable');
    }
  },
};
```

- [ ] **Step 2: `electron/adapters/driven/fs/working-files.ts`** — move `readWorkingFile` (today's `repo-map.ts` lines 120-170, with `maxBytes = 512 * 1024`) verbatim, plus:

```ts
export const nodeWorkingFiles: WorkingFiles = {
  realpath: p => realpath(p),
  read: (root, relative) => readWorkingFile(root, relative),
  async probe(root, relative) {
    try { const stat = await lstat(path.join(root, relative)); return stat.isFile() && stat.size === 0 ? 'emptyFile' : 'other'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other'; }
  },
};
```
(`readWorkingFile` imports `repoPathSchema` from `../../../../shared/contracts/git`; `WorkingFiles` type from `../../../core/repo-map`.)

### Task 4: Wiring, IPC, main, existing tests

- [ ] **Step 1: `electron/app/wiring/core-ports.ts`** — one place that fills the core shared port slots for every wiring module (plan 05f adds the glob matcher and the syntax parser here):

```ts
// Imported for its side effect by every electron/app/wiring module and process entry.
import { nodeHasher } from '../../adapters/driven/fs/hash';
import { provideHasher } from '../../core/shared/ports';

provideHasher(nodeHasher);
```
In `electron/app/wiring/git.ts` replace `provideHasher(nodeHasher);` and its two imports with `import './core-ports';`.

- [ ] **Step 1b: `electron/app/wiring/repo-map.ts`**

```ts
import type { GitStatus } from '../../../shared/contracts/git';
import { gitInventory } from '../../adapters/driven/git/inventory';
import { nodeWorkingFiles } from '../../adapters/driven/fs/working-files';
import { RepoMapService, repoSnapshot as coreRepoSnapshot, type RepoMapDeps } from '../../core/repo-map';
import './core-ports';

export const repoMapPorts = { inventory: gitInventory, files: nodeWorkingFiles };
export { parseNumstat } from '../../core/repo-map';
export { readWorkingFile } from '../../adapters/driven/fs/working-files';
export const repoSnapshot = (root: string, status: GitStatus, withStats = true) => coreRepoSnapshot(root, status, withStats, repoMapPorts);
export const createRepoMapService = (git: RepoMapDeps['git']) => new RepoMapService({ git, ...repoMapPorts });
```

- [ ] **Step 2: `electron/app/wiring/git.ts`** — the wiring `GitService` gains (after `super(...)`):

```ts
  /** Repo Map for this service (production IPC and the existing tests' service.repoSnapshot/inspectFile). */
  readonly repoMap = createRepoMapService(this);
  repoSnapshot(id: string) { return this.repoMap.repoSnapshot(id); }
  inspectFile(id: string, relative: string) { return this.repoMap.inspectFile(id, relative); }
```
(import `createRepoMapService` from `./repo-map`; there is no import cycle: `wiring/repo-map.ts` imports only `./core-ports`.)

- [ ] **Step 3: `electron/adapters/driving/ipc/repo-map.ts`**

```ts
import type { Handlers } from '../../../../shared/contracts/define';
import type { repoMapContract } from '../../../../shared/contracts/repo-map';
import type { RepoMapService } from '../../../core/repo-map';

export function repoMapHandlers(repoMap: RepoMapService): Handlers<typeof repoMapContract> {
  return { repoSnapshot: id => repoMap.repoSnapshot(id), inspectFile: (id, path) => repoMap.inspectFile(id, path) };
}
```
`electron/main.ts`: `registerContract(ipc, repoMapContract, repoMapHandlers(git.repoMap));`.

- [ ] **Step 4: Existing test paths** — `tests/repo-map/repo-map.test.ts:9`: `import { parseNumstat, repoSnapshot, readWorkingFile } from '../../electron/app/wiring/repo-map';` (GitService/git/Store already from wiring/git since plan 05a).

### Task 5: Verify and commit

- [ ] **Step 1**

```bash
grep -rn "from 'node:\|from 'electron'\|adapters/" electron/core/repo-map electron/core/git     # no output
grep -rn "repo-map" electron/core/git                                                          # no output (cycle gone)
npm run check 2>&1 | tail -n 12
npm run test:e2e -- repo-map desktop workspace-status
```
Expected: no grep output; `# fail 0`; 3 suites PASS.

- [ ] **Step 2: Commit**

```bash
git add -A electron tests
git commit -m "refactor(repo-map): RepoMapService in core behind inventory and working-file ports"
```

## Self-review

- Spec coverage (04 repo-map row): core `repo-map.ts`, `repo-map-size.ts`, `repo-map-service.ts`; ports `RepoInventory`, `WorkingFiles`; adapters `git/inventory.ts` (spec: "`git/runner.ts` (inventory)" — the inventory limits sit next to the runner in the same folder), `fs/working-files.ts`; driving `ipc/repo-map.ts`; `repo-map.core.test.ts` (assembly). The rule-2 degraded-sizes test is added in plan 07 together with the behaviour (spec 06).
- Cycles removed: `core/git` no longer imports `core/repo-map`; `repo-map-size` imports only a type from `repo-map`.
