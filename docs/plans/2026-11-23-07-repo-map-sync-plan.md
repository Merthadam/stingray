# 07 · Repo map sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** the sidebar and Repo Map share one Git clock (audit 12): `GitStateService` polls the selected workspace every
5 s; Repo Map reloads when the git-state revision bumps and has no poll of its own; a cheap 5 s `statFile` check keeps
the open file fresh; a failed size measurement degrades the map (rule 2); `inspectFile` reuses the last snapshot.

**Architecture:** new routes `git.selectWorkspace(id | null)` and `repo-map.statFile(id, path)`; `GitStateService.select`
+ `selectedPollMs`; `RepoMapService` caches the last snapshot per workspace (cleared by an `afterRemove` listener) and
gains `statFile` through `WorkingFiles.stat`. Renderer: `App.tsx` reports the selection; `RepoMap.tsx` follows
`useGitState(...).state.revision`.

**Tech Stack:** TypeScript, React 19, node:test, Playwright.

**Spec:** [06 — Repo map sync](../specs/2026-11-23-06-repo-map-sync-design.md).

**Depends on:** plan 06 committed. **Commit:** one, `feat(repo-map): one git-state clock for sidebar and Repo Map; open-file check; degraded sizes`.

---

## Files

Modify: `shared/contracts/{git,repo-map}.ts`, `electron/core/git/git-state.ts`, `electron/core/repo-map/{ports,repo-map,repo-map-service}.ts`,
`electron/adapters/driven/fs/working-files.ts`, `electron/adapters/driving/ipc/{git,repo-map}.ts`, `electron/app/{index,removal-listeners}.ts`,
`src/app/App.tsx`, `src/features/repo-map/RepoMap.tsx`, `src/features/git/demo.ts`, `src/features/repo-map/demo.ts`,
`tests/git/git-state.core.test.ts`, `tests/repo-map/repo-map.core.test.ts`, `tests/fakes/repo-map.ts`, `tests/git/workspace-lifecycle.test.ts` (helper),
`tests/app/contracts.test.ts` (route count 46 → 48), `tests/repo-map/repo-map.mjs` (one new check + two listed replacements), ledger.

---

### Task 1: Contracts

- [ ] **Step 1:** `shared/contracts/git.ts` `gitContract.invoke` gains
```ts
    /** The workspace the user is looking at: polled every 5 s while the window is visible (null: none). */
    selectWorkspace: [z.tuple([idSchema.nullable()]), returns<void>()],
```
`shared/contracts/repo-map.ts` gains the type and route:
```ts
export type FileStamp = { exists: boolean; size: number; mtimeMs: number };
    /** Cheap change check of one working-tree file (lstat only, no git). */
    statFile: [z.tuple([idSchema, repoPathSchema]), returns<FileStamp>()],
```
- [ ] **Step 2: Demos** — `src/features/git/demo.ts`: `selectWorkspace: async () => undefined,`; `src/features/repo-map/demo.ts`: `statFile: async (_id, path) => ({ exists: ctx.files.some(f => f.path === path), size: 0, mtimeMs: 0 }),`.
- [ ] **Step 3:** `tests/app/contracts.test.ts`: `assert.equal(routes, 46, …)` → `assert.equal(routes, 48, 'main.ts routes minus db-schema, plus selectWorkspace and statFile');` (a test added by this PR; ledger row not needed).

### Task 2: One poller in `GitStateService` (TDD)

- [ ] **Step 1: Append to `tests/git/git-state.core.test.ts`**

```ts
test('select(id) polls only the selected workspace every selectedPollMs while visible; select(null) and forget stop it', async () => {
  let visible = true;
  const calls = new Map<string, number>();
  const w = manualWatcher();
  const service = new GitStateService({ workspace: async wid => workspace(wid), status: async wid => { calls.set(wid, (calls.get(wid) ?? 0) + 1); return status([]); } },
    { resolve: async (_cwd, branch) => ({ kind: 'none', branch, repository: 'o/a', checkedAt: 0 }) },
    () => {}, () => visible, { debounceMs: 5, pollMs: 60_000, prPollMs: 60_000, selectedPollMs: 30 },
    { watcher: w.watcher, runner: async () => '' });
  const other = '00000000-0000-4000-8000-000000000009';
  try {
    await service.get(other);
    service.select(id);
    await sleep(140);
    const selected = calls.get(id) ?? 0;
    assert.ok(selected >= 3, `selected polled ${selected} times`);
    assert.equal(calls.get(other), 1, 'others are not polled at the selected rate');
    visible = false; const hidden = calls.get(id)!; await sleep(100);
    assert.equal(calls.get(id), hidden, 'never while hidden');
    visible = true; service.select(null); await sleep(20); const stopped = calls.get(id)!; await sleep(100);
    assert.equal(calls.get(id), stopped, 'select(null) stops it');
    service.select(id); await sleep(20); service.forget(id); const forgotten = calls.get(id)!; await sleep(100);
    assert.equal(calls.get(id), forgotten, 'forget stops it');
  } finally { service.dispose(); }
});
```
- [ ] **Step 2: Run** — FAIL (`select` missing).
- [ ] **Step 3: `electron/core/git/git-state.ts`**
  - `GitStateOptions` gains `selectedPollMs?: number`; destructure `selectedPollMs = 5000`.
  - Field `private selected: string | null = null;`.
  - Third timer: `setInterval(() => { if (this.visible() && this.selected) void this.refresh(this.selected).catch(() => {}); }, selectedPollMs),` (unref'd with the others).
  - Methods:
```ts
  /** The workspace the user is looking at: refreshed now and every selectedPollMs while visible (working-tree edits do not touch .git). */
  select(id: string | null) {
    this.selected = id;
    if (id) void this.refresh(id).catch(() => {});
  }
```
  and in `forget(id)`: `if (this.selected === id) this.selected = null;` as the first line.
- [ ] **Step 4: Run** — PASS. Then `electron/adapters/driving/ipc/git.ts`: `selectWorkspace: id => d.gitState.select(id),`. `electron/app/index.ts`: the renderer-reset callback becomes `() => { s.visibility.reset(); s.liveViews.stopAll(); s.gitState.select(null); }` (a reloading renderer re-sends its selection).

### Task 3: Repo map — degraded sizes, snapshot cache, `statFile` (TDD)

- [ ] **Step 1: `tests/fakes/repo-map.ts`** — `memoryFiles` gains `stat: async (_root, rel) => (rel in contents ? { exists: true, size: contents[rel].length, mtimeMs: 1 } : { exists: false, size: 0, mtimeMs: 0 })`.
- [ ] **Step 2: Append to `tests/repo-map/repo-map.core.test.ts`**

```ts
test('rule 2: a failing size measurement marks sizes unavailable and still returns the snapshot', async () => {
  const { inventory } = scriptedInventory({ lsFiles: 'a.ts\0new.ts\0', numstat: '1\t0\ta.ts\0', grep: new Error('Repository inventory exceeds the 16 MiB / 15 second limit, or Git is unavailable.') });
  const map = await repoSnapshot('/repo', status([{ path: 'a.ts', status: ' M' }, { path: 'new.ts', status: '??' }]), true, { inventory, files: memoryFiles({ 'a.ts': 'x', 'new.ts': 'y' }) });
  assert.ok(map.files.every(f => f.size?.state === 'unavailable' && f.size.reason === 'Size measurement failed or exceeded limits'));
  assert.equal(map.files.find(f => f.path === 'new.ts')!.lines, null);
  assert.match(map.statsNotice!, /size measurement failed/i);
});

function cachedService() {
  const { inventory, calls } = scriptedInventory({ lsFiles: 'a.ts\0', grep: 'a.ts\x001\n' });
  let statusCalls = 0;
  const service = new RepoMapService({
    git: { workspace: async id => ({ id, repoId: id, name: 'w', branch: 'main', path: '/repo', managed: false, previewUrl: '' }), status: async () => { statusCalls++; return status([]); } },
    inventory, files: memoryFiles({ 'a.ts': 'hello\n', 'new.ts': 'n\n' }),
  });
  return { service, calls, statusCalls: () => statusCalls };
}

test('after a snapshot, inspectFile runs no status or ls-files; an uncached path falls back; forget drops the cache', async () => {
  const s = cachedService();
  await s.service.repoSnapshot('w');
  const before = { status: s.statusCalls(), lsFiles: s.calls.filter(c => c[0] === 'ls-files').length };
  await s.service.inspectFile('w', 'a.ts');
  assert.deepEqual({ status: s.statusCalls(), lsFiles: s.calls.filter(c => c[0] === 'ls-files').length }, before);
  await assert.rejects(s.service.inspectFile('w', 'new.ts'), /inventory/); // not in the scripted inventory: today's computation, today's error
  assert.equal(s.statusCalls(), before.status + 1, 'uncached path falls back to status + ls-files');
  s.service.forget('w');
  await s.service.inspectFile('w', 'a.ts');
  assert.equal(s.statusCalls(), before.status + 2);
});

test('statFile makes no git calls and validates the path like inspectFile', async () => {
  const s = cachedService();
  assert.deepEqual(await s.service.statFile('w', 'a.ts'), { exists: true, size: 6, mtimeMs: 1 });
  assert.deepEqual(await s.service.statFile('w', 'gone.ts'), { exists: false, size: 0, mtimeMs: 0 });
  await assert.rejects(s.service.statFile('w', '../x'));
  assert.equal(s.calls.length, 0); assert.equal(s.statusCalls(), 0);
});
```
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement**
  - `electron/core/repo-map/ports.ts` `WorkingFiles` gains `/** lstat stamp; exists false when missing; rejects on other errors. */ stat(root: string, relative: string): Promise<FileStamp>;` (`FileStamp` from the repo-map contract).
  - `electron/adapters/driven/fs/working-files.ts` `nodeWorkingFiles.stat`:
```ts
  async stat(root, relative) {
    try { const s = await lstat(path.join(root, relative)); return { exists: true, size: s.size, mtimeMs: s.mtimeMs }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, size: 0, mtimeMs: 0 }; throw error; }
  },
```
  - `electron/core/repo-map/repo-map.ts` — replace `await measureSizes(root, files, unborn, ports);` and the `return` with:
```ts
  let sizesFailed = false;
  try { await measureSizes(root, files, unborn, ports); } catch {
    // Rule 2: a failed or over-limit measurement degrades sizes only; the map still opens.
    sizesFailed = true;
    const reason = 'Size measurement failed or exceeded limits';
    for (const file of files) {
      if (!file.size) file.size = { state: 'unavailable', source: 'working tree', reason };
      if (file.lines == null && (file.status === '??' || file.untrackedReplacement || unborn)) { file.lines = null; file.lineNotice = reason; }
    }
  }
  const unknown = files.filter(file => file.status && file.lines == null).length;
  const notices = [unknown ? `${unknown} changed file(s) have unavailable line counts; totals include known counts only.` : '',
    sizesFailed ? 'File sizes are unavailable: size measurement failed or exceeded limits.' : ''].filter(Boolean);
  return { ...status, files, statsNotice: notices.join(' ') };
```
  - `electron/core/repo-map/repo-map-service.ts`:
```ts
  private readonly last = new Map<string, RepoSnapshot>(); // last full snapshot per workspace (inspectFile reuses its entries)
  // in repoSnapshot(), after `const snapshot = await job;` (rewrite the try body to: const snapshot = await job; this.last.set(id, snapshot); return snapshot;)
  async inspectFile(id: string, relative: string): Promise<FileInspection> {
    const w = await this.deps.git.workspace(id);
    const cached = this.last.get(id);
    // A path missing from the cached snapshot (e.g. a new file) falls back to today's status + inventory read.
    const snapshot = cached?.files.some(f => f.path === relative) ? cached : await repoSnapshot(w.path, await this.deps.git.status(id), false, this.deps);
    return inspectFile(w.path, relative, snapshot, this.deps);
  }
  async statFile(id: string, relative: string): Promise<FileStamp> {
    repoPathSchema.parse(relative);
    return this.deps.files.stat((await this.deps.git.workspace(id)).path, relative);
  }
  /** Workspace removed. */
  forget(id: string) { this.last.delete(id); }
```
  - `electron/adapters/driving/ipc/repo-map.ts`: `statFile: (id, path) => repoMap.statFile(id, path),`.
  - `electron/app/removal-listeners.ts`: `RemovalParticipants` gains `repoMap: { forget(id: string): void }` and, right after the `activity` afterRemove listener, `lifecycle.onAfterRemove('repo map', id => p.repoMap.forget(id));`. `electron/app/compose.ts` passes `repoMap: git.repoMap`. In `tests/git/workspace-lifecycle.test.ts` the `participants()` helper (added by plan 06) gains `repoMap: { forget: () => { ran.push('repo map'); } },`.
- [ ] **Step 5: Run** — `npx tsx --test tests/repo-map/*.test.ts tests/git/*.test.ts` → PASS (existing `repo-map.test.ts` unchanged).

### Task 4: Renderer

- [ ] **Step 1: `src/app/App.tsx`** — the selection effect (today `App.tsx:104-111`) becomes:

```tsx
  // Working-tree edits don't touch .git: the main process polls the selected workspace (5 s); focus/visibility re-read now.
  useEffect(() => {
    void api.selectWorkspace(selected || null).catch(() => {});
    if (!selected) return;
    const update = () => { if (!document.hidden) void api.refreshGitState(selected).catch(() => {}); };
    update();
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update);
      void api.selectWorkspace(null).catch(() => {});
    };
  }, [selected]);
```

- [ ] **Step 2: `src/features/repo-map/RepoMap.tsx`**

1. Import `useGitState` from `'../git'` (feature index) and add after `const alive = useRef(false);`:
```tsx
  const { state: gitState } = useGitState(workspace.id);
  const latestRevision = useRef(0), loadedRevision = useRef(0);
  latestRevision.current = gitState?.revision ?? 0;
  const fileStamp = useRef('');
```
2. In `refresh()`: first line after the guard `const requested = latestRevision.current;`; on success (inside `if (alive.current && request === generation.current)`) add `loadedRevision.current = Math.max(loadedRevision.current, requested);`; in `finally` after `inFlight.current = false;` add `if (alive.current && latestRevision.current > loadedRevision.current) queueMicrotask(() => { void refresh(); });` (a bump during an in-flight load is not lost).
3. Replace the mount effect (today lines 68-73) with:
```tsx
  useEffect(() => {
    generation.current++; inFlight.current = false; loadedRevision.current = 0;
    alive.current = true; void refresh();
    return () => { alive.current = false; generation.current++; };
  }, [refresh]);
  // One clock (audit 12): reload when the shared Git state moved past the snapshot shown; no poll of our own.
  useEffect(() => { if (alive.current && latestRevision.current > loadedRevision.current) void refresh(); }, [gitState?.revision, refresh]);
```
4. In the inspection effect's `load()`: before `const next = await api.inspectFile(…)` add `const stamp = JSON.stringify(await api.statFile(workspace.id, selected).catch(() => null));` and after a successful inspection `fileStamp.current = stamp;`.
5. New effect after the inspection effect:
```tsx
  // Same-line edits keep counts and status: a cheap stat of the open file (no git) re-inspects when it changed.
  useEffect(() => {
    if (!selected) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void api.statFile(workspace.id, selected).then(stamp => { if (JSON.stringify(stamp) !== fileStamp.current) refreshFile.current(); }, () => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, [workspace.id, selected]);
```
6. Update the comment on line 11: `// Snapshot status reads also update the shared Git state (GitService.onStatus); the map reloads when that state's revision moves.`

### Task 5: e2e — new check and the two listed replacements

- [ ] **Step 1: Replacement 1 (`tests/repo-map/repo-map.mjs`, idle window)** — replace the `app.evaluate` block that wraps `'repo-map.repoSnapshot'` and sets `globalThis.idleMapPolls` (today lines 136-140) with:

```js
  await app.evaluate(({ ipcMain }) => {
    globalThis.idleMapPolls = 0; globalThis.idleSnapshots = 0;
    for (const [channel, counter] of [['repo-map.statFile', 'idleMapPolls'], ['repo-map.repoSnapshot', 'idleSnapshots']]) {
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel); ipcMain.handle(channel, async (...args) => { const result = await original(...args); globalThis[counter]++; return result; });
    }
  });
```
then `timings.idle = { polls: …, snapshots: await app.evaluate(() => globalThis.idleSnapshots), mutations: …, records: … }` and the check:
Old: `check('two real idle polls leave map, counts and reader visually unchanged', timings.idle.polls >= 2 && timings.idle.mutations === 0);`
New: `check('two real idle file checks leave map, counts and reader visually unchanged, with no map reload', timings.idle.polls >= 2 && timings.idle.snapshots === 0 && timings.idle.mutations === 0);`

- [ ] **Step 2: New check** — directly after the `'silent polling still detects same-line edits'` check:

```js
  // One clock: an unstaged edit reaches the sidebar and the map at the same Git revision.
  const summary = () => page.getByRole('group', { name: 'main Git summary', exact: true });
  const labelBefore = await summary().locator('.git-lines').getAttribute('aria-label');
  await put('electron/main.ts', '// Main process\n'.repeat(40) + '// synced edit\n');
  await page.waitForFunction(before => document.querySelector('[aria-label="main Git summary"] .git-lines')?.getAttribute('aria-label') !== before, labelBefore, { timeout: 15000 });
  const shared = await page.evaluate(workspaceId => window.stingray.gitState(workspaceId), id);
  await page.waitForFunction(n => document.querySelector('.map-title h2 span')?.textContent === `${n} changes`, shared.status.changes.length, { timeout: 15000 });
  check('sidebar and Repo Map agree at the same revision after an unstaged edit',
    (await summary().locator('.git-lines').innerText()).replace(/\s+/g, '') === `+${shared.status.lines.added}−${shared.status.lines.deleted}` &&
    (await page.locator('.map-title h2 span').innerText()) === `${shared.status.changes.length} changes`);
  await put('electron/main.ts', '// Main process\n'.repeat(40));
  await page.waitForFunction(n => document.querySelector('.map-title h2 span')?.textContent === `${n} changes`, shared.status.changes.length - 1, { timeout: 15000 });
```
(Confirm the selectors on the running fixture once: the primary workspace's card is named `main`; adjust only the selector strings if the DOM differs.)

- [ ] **Step 3: Replacement 2 (automatic snapshot held by the gate)** — today:
```js
  await gateResponse('repo-snapshot', id);   // 'repo-map.repoSnapshot' since plan 03
  // Hold a real automatic refresh. …
  await waitGate();
```
New:
```js
  await gateResponse('repo-map.repoSnapshot', id);
  // Hold a real automatic refresh: an on-disk edit that changes counts bumps the shared Git revision, which reloads the map.
  await put('held-by-gate.txt', 'untracked\n');
  await page.evaluate(workspaceId => window.stingray.refreshGitState(workspaceId), id);
  await waitGate();
```
and right after the existing `await releaseGate(); await page.waitForTimeout(150);` that follows the workspace switch, add `await rm(path.join(repo, 'held-by-gate.txt'));`. Every assertion of the block is unchanged.

- [ ] **Step 4: Ledger rows**

```markdown
| 07 | tests/repo-map/repo-map.mjs (idle window) | wraps `repo-snapshot`; `idleMapPolls >= 2 && mutations === 0`, "two real idle polls leave map, counts and reader visually unchanged" | wraps `repo-map.statFile` and `repo-map.repoSnapshot`; `idleMapPolls >= 2 && idleSnapshots === 0 && mutations === 0`, "two real idle file checks … with no map reload" | Same 11 s window and zero-mutation check, plus zero snapshot reloads: stricter (spec 06). |
| 07 | tests/repo-map/repo-map.mjs (held automatic snapshot) | waited for a poll-driven snapshot | an on-disk edit that changes counts + `refreshGitState` triggers the revision-driven snapshot; same gate and assertions | Same assertions; the trigger is the new automatic path (spec 06). |
| 07 | tests/repo-map/repo-map.mjs | — | new check "sidebar and Repo Map agree at the same revision after an unstaged edit" | New check. |
```

### Task 6: Verify and commit

- [ ] **Step 1**

```bash
npm run check 2>&1 | tail -n 12
npm run test:e2e -- repo-map desktop workspace-status pull-requests
```
Expected: `# fail 0`; 4 suites PASS. If "polling refreshes contents after edits" / "silent polling still detects same-line edits" fail, check the order: the `statFile` check re-inspects with the cached entry; the revision reload then refreshes the entry's status and counts (≤ 5 s + debounce). Do not weaken those checks; fix the code path.

- [ ] **Step 2: Commit**

```bash
git add -A shared electron src tests docs/plans/2026-11-23-test-edit-ledger.md
git commit -m "feat(repo-map): one git-state clock for sidebar and Repo Map; open-file check; degraded sizes"
```

## Self-review

- Spec 06 coverage: `selectWorkspace` route + `select()` + `selectedPollMs` + `forget` + reload clears (T1-T2); `statFile` route and core method via `WorkingFiles` (T1, T3); renderer selection effect, revision reload, no poll, 5 s open-file check (T4); `measureSizes` degrade (T3); `inspectFile` cache with fallback and `afterRemove` clear (T3); unit tests and e2e check + the two listed replacements (T2, T3, T5).
- Risk kept visible: a cached entry's status can lag one revision (≤ 5 s) after an edit to a previously clean, open file; the diff appears with the next revision reload.
