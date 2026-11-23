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

Baseline unit test count before plan 01: 435 (from `npm test`, `# tests 435`).

## Manual checks

(Each plan appends one line per manual check: what was run, result.)

- 01: `node tests/launch.mjs` — PASS (npm start builds first).
- 01: `node tests/single-instance.mjs` — FAIL before the main.ts change (exit code 0), PASS after.
- 01: `npm run dev` — prints `Stingray dev data: ~/Library/Application Support/Stingray-dev`, runs next to the installed app; editing `electron/main.ts` restarts Electron and prints the log line; a syntax error prints the esbuild error and the failed-build line, Electron keeps running; Ctrl-C leaves no Electron/dev/Vite process. `STINGRAY_DATA_DIR=/tmp/stingray-dev-x npm run dev` uses that dir. PASS (rerun on the done bar).
