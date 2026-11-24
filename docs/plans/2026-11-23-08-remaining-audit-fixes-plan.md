# 08 · Remaining audit fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** land the audit fixes that belong to no feature commit: 13 (flow diagram persists layout only after a user
action), 14 (`pi-activity` in the e2e runner and in CI, non-blocking), one terminal-event dispatcher in the renderer,
no double typecheck in CI, `@types/prismjs` as a dev dependency.

**Architecture:** small, local changes; each has its test or check.

**Tech Stack:** React 19 + @xyflow/react, Node scripts, GitHub Actions, npm.

**Spec:** [07 § 13, § 14, Small fixes](../specs/2026-11-23-07-audit-fixes-design.md).

**Depends on:** plan 07 committed. **Commit:** one, `fix: flow layout persists only after user action; pi-activity in e2e and CI; one terminal-event dispatcher; CI and deps cleanups`.

---

## Files

Create: `src/features/terminals/terminal-events.ts`, `src/features/terminals/terminal-event-bus.ts`, `tests/terminals/terminal-events.test.ts`.
Modify: `src/features/views/views-ui/FlowDiagram.tsx`, `tests/views/views-tab.mjs` (new check), `scripts/run-e2e.mjs`,
`.github/workflows/ci.yml`, `docs/ci.md`, `src/features/terminals/{TerminalPane.tsx,index.ts}`, `src/app/App.tsx`,
`package.json`, `package-lock.json`, ledger.

---

### Task 1: Flow diagram saves layout only after a user action (audit 13)

- [ ] **Step 1: New e2e check in `tests/views/views-tab.mjs`** — directly before `await list.getByRole('button', { name: 'Agent flow' }).click();` add

```js
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('views.saveViewState');
    globalThis.viewStateSaves = 0;
    ipcMain.removeHandler('views.saveViewState');
    ipcMain.handle('views.saveViewState', async (...args) => { globalThis.viewStateSaves++; return original(...args); });
  });
  const saves = () => app.evaluate(() => globalThis.viewStateSaves);
  const waitSaves = async (n) => { for (let i = 0; i < 50 && await saves() < n; i++) await page.waitForTimeout(100); return saves(); };
```
and directly after `check('flow view draws every transition', …);` add

```js
  await page.waitForTimeout(1000); // automatic layout settled
  check('opening a flow view writes no view state', await saves() === 0);
  const card = await flow.locator('.flow-card').first().boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2); await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 + 80, card.y + card.height / 2 + 40, { steps: 8 }); await page.mouse.up();
  check('dragging a card saves the layout', await waitSaves(1) >= 1);
  const afterDrag = await saves();
  await page.getByRole('button', { name: 'Re-layout the diagram' }).click();
  check('re-layout saves the new layout once it is computed', await waitSaves(afterDrag + 1) > afterDrag);
```

- [ ] **Step 2: Run** — `npm run build && npm run test:e2e -- views-tab` → FAIL at "opening a flow view writes no view state".

- [ ] **Step 3: `src/features/views/views-ui/FlowDiagram.tsx`**
  - After `const stateCallback = useRef(onStateChange); …` add `const userMoved = useRef(false); // only a drag or Re-layout persists positions`.
  - Line 43 → `useEffect(() => { if (ready && userMoved.current) stateCallback.current(state); }, [state, ready]);`
  - `onNodesChange` loop: add `if (c.type === 'position' && c.dragging === false) userMoved.current = true;` as the first statement in the `for` body.
  - Re-layout button `onClick`: prepend `userMoved.current = true;`.

- [ ] **Step 4: Run** — `npm run build && npm run test:e2e -- views-tab` → PASS.

### Task 2: One terminal-event dispatcher (TDD)

- [ ] **Step 1: `tests/terminals/terminal-events.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalEvents } from '../../src/features/terminals/terminal-events';
import type { TerminalEvent } from '../../shared/contracts/terminals';

test('subscribers get only their terminal’s events; the IPC listener exists only while someone listens', () => {
  let ipc: ((e: TerminalEvent) => void) | null = null, subscriptions = 0;
  const events = createTerminalEvents(listener => { subscriptions++; ipc = listener; return () => { ipc = null; }; });
  const a: TerminalEvent[] = [], b: TerminalEvent[] = [], all: TerminalEvent[] = [];
  const offA = events.on('a', e => a.push(e)), offB = events.on('b', e => b.push(e)), offAll = events.on(null, e => all.push(e));
  assert.equal(subscriptions, 1, 'one IPC subscription');
  ipc!({ id: 'a', data: 'x', sequence: 1 }); ipc!({ id: 'b', data: 'y', sequence: 1 });
  assert.deepEqual([a.length, b.length, all.length], [1, 1, 2]);
  offA(); offB();
  assert.notEqual(ipc, null);
  offAll();
  assert.equal(ipc, null, 'unsubscribing the last removes the IPC listener');
});
```

- [ ] **Step 2: Run** — FAIL (module missing).

- [ ] **Step 3: `src/features/terminals/terminal-events.ts`**

```ts
import type { TerminalEvent } from '../../../shared/contracts/terminals';

type Listener = (event: TerminalEvent) => void;
/** One api.onTerminal subscription shared by every pane and the app shell; listeners by terminal id, or null for all. */
export function createTerminalEvents(subscribe: (listener: Listener) => () => void) {
  const byId = new Map<string, Set<Listener>>(), all = new Set<Listener>();
  let off: (() => void) | null = null;
  const dispatch: Listener = event => { byId.get(event.id)?.forEach(l => l(event)); all.forEach(l => l(event)); };
  return {
    on(id: string | null, listener: Listener): () => void {
      off ??= subscribe(dispatch);
      if (id === null) all.add(listener); else { let set = byId.get(id); if (!set) byId.set(id, set = new Set()); set.add(listener); }
      return () => {
        if (id === null) all.delete(listener); else { const set = byId.get(id); set?.delete(listener); if (set && !set.size) byId.delete(id); }
        if (off && !all.size && !byId.size) { off(); off = null; }
      };
    },
  };
}
```
`src/features/terminals/terminal-event-bus.ts`:
```ts
import { api } from '../../app/api';
import { createTerminalEvents } from './terminal-events';
export const terminalEvents = createTerminalEvents(listener => api.onTerminal(listener));
```
`src/features/terminals/index.ts`: add `export { terminalEvents } from './terminal-event-bus';`.

- [ ] **Step 4: Use it** — `src/features/terminals/TerminalPane.tsx:123`: `const off = api.onTerminal(event => {` → `const off = terminalEvents.on(info.id, event => {` and delete the now-redundant `if (event.id !== info.id) return;` line (the dispatcher filters by id); import `terminalEvents` from `./terminal-event-bus`. `src/app/App.tsx:103`: `return api.onTerminal(e => …)` → `return terminalEvents.on(null, e => …)` with `import { terminalEvents } from '../features/terminals';`.

- [ ] **Step 5: Run** — `npx tsx --test tests/terminals/terminal-events.test.ts` → PASS; `npm run test:e2e -- terminal-links desktop` → PASS.

### Task 3: `pi-activity` in the runner and CI (audit 14)

- [ ] **Step 1: `scripts/run-e2e.mjs`** — add `'pi-activity': 'activity'` to the `suites` map (last entry).
Run: `node scripts/run-e2e.mjs --list` → 9 names including `pi-activity`.

- [ ] **Step 2: `.github/workflows/ci.yml`**
  - `check` job: delete the `- run: npm run typecheck` step (CI double typecheck; `npm run build` runs `tsc --noEmit`).
  - `e2e-macos`: replace `- run: npm run test:e2e` with
```yaml
      - run: npm run test:e2e -- desktop repo-map terminal-links workspace-status pull-requests worktree-removal add-project views-tab
        env:
          GIT_AUTHOR_NAME: CI
          GIT_AUTHOR_EMAIL: ci@invalid
          GIT_COMMITTER_NAME: CI
          GIT_COMMITTER_EMAIL: ci@invalid
      - name: pi-activity (non-blocking, tracked in docs/ci.md)
        continue-on-error: true
        run: npm run test:e2e -- pi-activity
        env:
          GIT_AUTHOR_NAME: CI
          GIT_AUTHOR_EMAIL: ci@invalid
          GIT_COMMITTER_NAME: CI
          GIT_COMMITTER_EMAIL: ci@invalid
```
  - `e2e-linux` non-blocking step: `run: scripts/test-env.sh test e2e terminal-links workspace-status pi-activity`.

- [ ] **Step 3: `docs/ci.md`** — stage 2b row: "all e2e suites except `pi-activity` (`npm run test:e2e -- <list>`); `pi-activity` in a separate non-blocking step"; extend the footnote: "`pi-activity` (native Pi activity UI over zsh PTYs, runner-sensitive like the other PTY tests) runs non-blocking on macOS and Linux; moving it to required is a later change." Replace "All suites are required on macOS." with "All suites except `pi-activity` are required on macOS." Update the path `tests/activity-shell.test.ts` → `tests/activity/activity-shell.test.ts`.

- [ ] **Step 4: Run locally (macOS)** — `npm run test:e2e -- pi-activity` → PASS.

### Task 4: `@types/prismjs` to devDependencies

- [ ] **Step 1:** `npm uninstall @types/prismjs && npm install -D @types/prismjs@^1.26.6`
Expected: `package.json` lists it under `devDependencies` only; `package-lock.json` updated.
- [ ] **Step 2:** `npm run check` → PASS. On macOS also `npm run package:mac` with `STINGRAY_PACKAGE_OUTPUT=release/plan08-check` → builds; then `rm -rf release/plan08-check` (never commit or keep release copies).

### Task 5: Verify and commit

- [ ] **Step 1**

```bash
npm run check 2>&1 | tail -n 12
npm run test:e2e
```
Expected: `# fail 0`; all 9 suites PASS locally on macOS.

- [ ] **Step 2: Ledger** — rows: "tests/views/views-tab.mjs — new checks (audit 13)", "scripts/run-e2e.mjs — `pi-activity` added (audit 14)".

- [ ] **Step 3: Commit**

```bash
git add -A src tests scripts .github/workflows/ci.yml docs/ci.md package.json package-lock.json docs/plans/2026-11-23-test-edit-ledger.md
git status --short   # no release/, artifacts/, dist*/
git commit -m "fix: flow layout persists only after user action; pi-activity in e2e and CI; one terminal-event dispatcher; CI and deps cleanups"
```

## Self-review

- Spec 07 coverage for commit 8: 13 (T1, e2e check as specified: 0 saves on open, ≥ 1 after drag, more after Re-layout), 14 (T3: runner, CI macOS explicit list + non-blocking step, Linux non-blocking, `docs/ci.md`), terminal-event dispatcher (T2 with the specified test), CI double typecheck (T3), `@types/prismjs` (T4).
