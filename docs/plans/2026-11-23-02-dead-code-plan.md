# 02 · Dead code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** delete the unused `db-schema` IPC route, the project-home prototype and `PullRequestService.status()` (audit 17).

**Architecture:** pure deletions plus the test substitutions the spec lists; no behaviour change.

**Tech Stack:** TypeScript, node:test, Playwright e2e.

**Spec:** [`docs/specs/2026-11-23-02-dead-code-design.md`](../specs/2026-11-23-02-dead-code-design.md)

**Depends on:** plan 01 committed. **Commit:** one, `chore: remove dead db-schema route, project-home prototype and PullRequestService.status`.

---

## Files

- Modify: `electron/main.ts` (lines 19-20 imports, 150-160 route), `electron/preload.ts:18`, `src/shared.ts` (line 4 import, line 107), `src/demo.ts` (lines 248-249)
- Delete: `src/project-home.prototype.tsx`, `src/project-home.prototype.css`, `src/project-home.prototype.html`
- Modify: `package.json:12` (`prototype:home`), `tests/desktop.mjs:102`
- Modify: `electron/pull-requests.ts:108-115` (delete `status()`), `tests/pull-requests.test.ts` (lines 74, 119-130, 133-146, 148-155)
- Modify: `tests/git-state.test.ts` (one new test: failing status → no PR lookup)
- Modify: `docs/plans/2026-11-23-test-edit-ledger.md`

---

### Task 1: Remove the `db-schema` route

- [ ] **Step 1: Edit `electron/main.ts`**

Delete line 19 `import { extractDbSchema } from './db-schema';`, line 20 `import type { DbSchemaResult } from '../src/db-schema';` and lines 150-160 (the `// Static parse only…` comment, `const dbScans = …` and the whole `handle('db-schema', …)` block).

- [ ] **Step 2: Edit `electron/preload.ts`** — delete line 18 `dbSchema: id => ipcRenderer.invoke('db-schema', id),`.

- [ ] **Step 3: Edit `src/shared.ts`** — delete line 107 `dbSchema(workspaceId: string): Promise<DbSchemaResult>;` and line 4 `import type { DbSchemaResult } from './db-schema';`.

- [ ] **Step 4: Edit `src/demo.ts`** — delete lines 248-249 (`// Fixed sample schema…` and `dbSchema: async id => …`). Keep `demoDbSchema` (still used at lines 143 and 156) and the `DbSchemaResult` type import at line 2 (used by `demoDbSchema`).

- [ ] **Step 5: Verify**

Run: `npm run typecheck && grep -rn "'db-schema'\|dbSchema(" src electron`
Expected: typecheck passes; grep prints only `electron/views-cli.ts` lines (the CLI's own `dbSchema` dependency: 34, 145, 280).

### Task 2: Remove the project-home prototype

- [ ] **Step 1: Delete files and script**

```bash
git rm src/project-home.prototype.tsx src/project-home.prototype.css src/project-home.prototype.html
```
In `package.json` delete line 12 `"prototype:home": "vite --host 127.0.0.1 --port 5180 --strictPort",`.

- [ ] **Step 2: Edit `tests/desktop.mjs:102`** (assertion replacement listed in the spec)

Old:
```js
  check('compact project cards fit without horizontal overflow or a prototype switcher', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.project-home').scrollWidth <= document.querySelector('.project-home').clientWidth && !document.querySelector('.ph-switcher')));
```
New:
```js
  check('compact project cards fit without horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.project-home').scrollWidth <= document.querySelector('.project-home').clientWidth));
```

- [ ] **Step 3: Verify**

Run: `grep -rn "ph-switcher\|project-home.prototype\|prototype:home" src tests package.json`
Expected: no output.

### Task 3: Add the "status error → no PR lookup" test to git-state (TDD guard before deleting `status()`)

**Files:** Modify `tests/git-state.test.ts` (append one test at the end of the file)

- [ ] **Step 1: Append the test**

```ts
test('a failing status read makes no PR lookup', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'stingray-git-state-nogit-')));
  const branches: string[] = [];
  const gitState = new GitStateService({
    workspace: async id => ({ id, repoId: id, name: 'x', branch: 'x', path: root, managed: false, previewUrl: '' }),
    status: async () => { throw new Error('Git operation failed.'); },
  }, {
    resolve: async (_cwd, branch): Promise<PullRequestStatus> => { branches.push(branch); return { kind: 'none', branch, repository: 'owner/app', checkedAt: 0 }; },
  }, () => {});
  try {
    const state = await gitState.refresh('00000000-0000-4000-8000-000000000001');
    assert.equal(state.status, null);
    assert.equal(state.pr, null);
    assert.equal(state.error, 'Git operation failed.');
    assert.deepEqual(branches, [], 'no PR lookup without a status');
  } finally { gitState.dispose(); await rm(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run it**

Run: `npx tsx --test tests/git-state.test.ts`
Expected: PASS (it documents existing behaviour that was covered by the old `status()` "git-fails" case).

### Task 4: Delete `PullRequestService.status()` and rewrite its test calls

**Files:** Modify `electron/pull-requests.ts:108-115`, `tests/pull-requests.test.ts`

- [ ] **Step 1: Rewrite the test calls first (they must still pass against the current code)**

1. Line 74 — replace `service.status('/repo')` with `service.resolve('/repo', 'feature/ui', 'git@github.com:owner/app.git')`. All assertions of the test stay.
2. Lines 119-130 — replace the whole test with:

```ts
test('detached HEAD, absent and unsupported origins never make GitHub requests', async () => {
  for (const mode of ['detached', 'no-remote', 'unsupported']) {
    const service = new PullRequestService(async command => { assert.equal(command, 'git'); return ''; });
    const result = mode === 'detached' ? await service.resolve('/repo', '', 'https://github.com/owner/app')
      : await service.resolve('/repo', 'main', mode === 'no-remote' ? null : 'https://gitlab.com/owner/app');
    assert.equal(result.kind, 'unsupported');
    assert.ok(!JSON.stringify(result).includes('private path'));
  }
});
```
3. Lines 138-145 ("isolates remotes") — replace each `service.status('/repo')` with `service.resolve('/repo', branch, remote)` (five occurrences: 138, 139, 140, 143, 145). Assertions unchanged.
4. Line 152 ("missing gh") — replace `service.status('/repo')` with `service.resolve('/repo', 'main', 'https://github.com/owner/app')`.

- [ ] **Step 2: Run the tests against the unchanged service**

Run: `npx tsx --test tests/pull-requests.test.ts`
Expected: PASS.

- [ ] **Step 3: Delete `status()`** — in `electron/pull-requests.ts` delete lines 108-115 (the `async status(cwd: string, refresh = false)` method, through its closing `}` and the blank line after it).

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npx tsx --test tests/pull-requests.test.ts tests/git-state.test.ts && grep -n "\.status(" tests/pull-requests.test.ts`
Expected: PASS; grep prints nothing.

- [ ] **Step 5: Ledger entries** — append to `docs/plans/2026-11-23-test-edit-ledger.md`:

```markdown
| 02 | `tests/desktop.mjs:102` | label `…without horizontal overflow or a prototype switcher`, clause `&& !document.querySelector('.ph-switcher')` | label `…without horizontal overflow`, clause removed | `.ph-switcher` only existed in the deleted prototype; the overflow checks are unchanged. |
| 02 | `tests/pull-requests.test.ts:74` | `service.status('/repo')` | `service.resolve('/repo', 'feature/ui', 'git@github.com:owner/app.git')` | Same branch/remote the fake returned; every assertion kept. |
| 02 | `tests/pull-requests.test.ts:119-130` | test "missing Git, detached HEAD, absent and unsupported origins never make GitHub requests" via `status()` | "detached HEAD, absent and unsupported origins never make GitHub requests" via `resolve(cwd, '', remote)`, `resolve(cwd, branch, null)`, `resolve(cwd, branch, 'https://gitlab.com/owner/app')`; same `unsupported` + no-leak + git-only assertions | Missing Git now covered by new `tests/git-state.test.ts` "a failing status read makes no PR lookup" (no PR call, `pr: null`). |
| 02 | `tests/pull-requests.test.ts:138-145` | `service.status('/repo')` ×5 | `service.resolve('/repo', branch, remote)` ×5 | Same values the fake returned; assertions unchanged. |
| 02 | `tests/pull-requests.test.ts:152` | `service.status('/repo')` | `service.resolve('/repo', 'main', 'https://github.com/owner/app')` | Same values; assertions unchanged. |
```

### Task 5: Verify and commit

- [ ] **Step 1: Checks**

Run: `npm run check 2>&1 | tail -n 12 && npm run test:e2e -- desktop pull-requests worktree-removal views-tab`
Expected: `# fail 0` (tests = baseline + 1); e2e summary shows `PASS` for all four suites.

- [ ] **Step 2: Commit**

```bash
git add -A electron src tests package.json docs/plans/2026-11-23-test-edit-ledger.md
git status --short
git commit -m "chore: remove dead db-schema route, project-home prototype and PullRequestService.status"
```

## Self-review

- Spec coverage: route + preload + type + demo (T1), prototype + script + desktop clause (T2), `status()` + test substitutions + git-state coverage (T3-T4), acceptance greps (T1 S5, T2 S3, T4 S4), e2e suites (T5).
- Kept on purpose: `extractDbSchema`, `demoDbSchema`, `reviewPushStatus().identity` (used by plan 05a).
