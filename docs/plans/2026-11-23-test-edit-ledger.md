# Test-edit ledger (modular restructure PR)

Every edit to an existing test file other than an import path, a fixture/entry path string (plan 04) or a raw IPC
channel string (plan 03) is listed here, old vs new. Plan 10 copies this file into the PR description (OQ3).
Each replacement is at least as strict as the original.

| Plan | File | Old | New | Why at least as strict |
|---|---|---|---|---|
| 01 | `tests/launch.mjs:19` | `const deadline = Date.now() + 20000;` | `const deadline = Date.now() + 180000;` | Timeout only: `npm start` now runs a full build first (spec 01). Every check is unchanged. |
| 01 | `tests/desktop.mjs:58` | `secondaryExit === 0 && app.windows().length === 1` | `secondaryExit === 1 && app.windows().length === 1` | Spec 01 makes a second instance exit 1 with a message (loud single-instance failure); the exit code is still pinned and the one-window check is unchanged. Found by plan 02's desktop e2e gate. |
| 02 | `tests/desktop.mjs:102` | label `…without horizontal overflow or a prototype switcher`, clause `&& !document.querySelector('.ph-switcher')` | label `…without horizontal overflow`, clause removed | `.ph-switcher` only existed in the deleted prototype; the overflow checks are unchanged. |
| 02 | `tests/pull-requests.test.ts:74` | `service.status('/repo')` | `service.resolve('/repo', 'feature/ui', 'git@github.com:owner/app.git')` | Same branch/remote the fake returned; every assertion kept. |
| 02 | `tests/pull-requests.test.ts:116-129` | test "missing Git, detached HEAD, absent and unsupported origins never make GitHub requests" via `status()` | "detached HEAD, absent and unsupported origins never make GitHub requests" via `resolve(cwd, '', remote)`, `resolve(cwd, branch, null)`, `resolve(cwd, branch, 'https://gitlab.com/owner/app')`; same `unsupported` + no-leak + git-only assertions | Missing Git now covered by new `tests/git-state.test.ts` "a failing status read makes no PR lookup" (no PR call, `pr: null`). |
| 02 | `tests/pull-requests.test.ts:138-145` | `service.status('/repo')` ×5 | `service.resolve('/repo', branch, remote)` ×5 | Same values the fake returned; assertions unchanged. |
| 02 | `tests/pull-requests.test.ts:152` | `service.status('/repo')` | `service.resolve('/repo', 'main', 'https://github.com/owner/app')` | Same values; assertions unchanged. |
| 03 | tests/repo-map.mjs, tests/terminal-links.mjs:171, tests/worktree-removal.mjs:48 | kebab channels | feature.member channels | String renames only (spec 03); no assertion changed. |
| 03 | tests/desktop.mjs | — | new check "no DEMO badge in desktop mode" | New check. |
| 04 | path strings in 9 test files (table in plan 04 Task 6, plus `tests/views/views.test.ts:11`) | old paths | moved paths | Fixture/entry path strings only. `tests/db-schema/db-schema.test.ts:11`, `tests/views/view-service.test.ts:11` and `tests/views/views.test.ts:11` (wasm path) were not in the spec's list but are the same kind of path string. |
| 05a | `tests/git/git.test.ts:49, 63, 67`; `tests/git/worktree-removal.test.ts:49, 64, 77, 79, 92, 109, 133, 137, 147, 163, 174, 177, 181` (16 calls; origin lines `git.test.ts:45, 59, 63`, `worktree-removal.test.ts:44, 59, 72, 74, 87, 104, 128, 132, 142, 158, 169, 172, 176`) | `<service>.removeWorkspace(<id>, X)` | `<service>.removeWorkspace(<id>, await consent(<service>, <id>, X))` (helper adds `(await service.reviewRemoval(id)).fingerprint`) | Same choice, now with the fresh review fingerprint the renderer sends (audit 3, no legacy path); every assertion unchanged. New test "a removal consent without the review fingerprint is refused and removes nothing" proves the old shape is refused. |
| 05a | `tests/git/git.test.ts:49`, `tests/git/worktree-removal.test.ts:49` | `const { state… } = await f.service.removeWorkspace(…)` | `const { state… } = notStale(await f.service.removeWorkspace(…))` | `RemovalResult` is now `{ state; warning? } \| { stale }`; `notStale` asserts the removal was not refused as stale before destructuring (adds an assertion). |
| 05a | `tests/git/git.test.ts:37` | `removeWorkspace(primaryId, { discard: true, deleteBranch: false })` → rejects `/Only worktrees/` | same plus `fingerprint: '0'.repeat(64)` | The consent schema requires a fingerprint; a well-formed consent still gets the ownership refusal, so the check now isolates ownership from consent validation. |
| 05a | `tests/git/git.test.ts` | — | new tests: consent without fingerprint refused; stale consent keeps the worktree and a fresh review removes it; existing branch refused before `worktree add`; failing `worktree add` reports git's reason; status with > 4 MiB output | New tests (audit 3, branch exists, git error detail, status buffer). |
| 05a | `tests/git/worktree-removal.mjs` | — | new check "changes after the review refuse removal and reload the review" | New check (audit 3). |
| 05b | `tests/activity/activity.test.ts` | — | new test case "resume events keep a long hook Working turn alive; silence still expires it" (audit 4) | New test. Other 05b edits are import paths only (`tests/activity/{activity,activity-shell,activity-history}.test.ts`, `tests/agents/{pi-smoke.ts,pi-observer.test.ts,hook-client.test.ts}` → `electron/app/wiring/activity`). |

Baseline unit test count before plan 01: 435 (from `npm test`, `# tests 435`).

## Manual checks

(Each plan appends one line per manual check: what was run, result.)

- 01: `node tests/launch.mjs` — PASS (npm start builds first).
- 01: `node tests/single-instance.mjs` — FAIL before the main.ts change (exit code 0), PASS after.
- 01: `npm run dev` — prints `Stingray dev data: ~/Library/Application Support/Stingray-dev`, runs next to the installed app; editing `electron/main.ts` restarts Electron and prints the log line; a syntax error prints the esbuild error and the failed-build line, Electron keeps running; Ctrl-C leaves no Electron/dev/Vite process. `STINGRAY_DATA_DIR=/tmp/stingray-dev-x npm run dev` uses that dir. PASS (rerun on the done bar).
- 03: browser demo (Vite on 127.0.0.1:5199, since the user's Vite holds 5178; headless Chrome) — demo loads, `DEMO` badge (`role=status`, "Demo data") visible in the status bar, no page errors. PASS.
- 03: desktop mode, no `DEMO` badge — covered by the new `tests/desktop.mjs` check "no DEMO badge in desktop mode" (PASS in `npm run test:e2e`). `npm run dev` not run (port 5178 in use by the user's Vite).
- 03: missing preload — built app launched (temp data dir) with `dist-electron/preload.cjs` temporarily hidden instead of editing `electron/main.ts`: the bridge-missing message is shown, no demo data, `window.stingray` undefined; file restored. PASS.
- 05b: `node tests/activity/pi-activity.mjs` (non-blocking) — FAIL at the same step on 941a764 (before 05b) and after 05b: `phase('Idle')` timeout after "scrollback view cannot acknowledge unseen output at bottom" (scroll-to-bottom acknowledgement); every earlier check PASS. Pre-existing, not caused by the activity extraction.
