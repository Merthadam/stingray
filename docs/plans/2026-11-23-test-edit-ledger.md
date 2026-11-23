# Test-edit ledger (modular restructure PR)

Every edit to an existing test file other than an import path, a fixture/entry path string (plan 04) or a raw IPC
channel string (plan 03) is listed here, old vs new. Plan 10 copies this file into the PR description (OQ3).
Each replacement is at least as strict as the original.

| Plan | File | Old | New | Why at least as strict |
|---|---|---|---|---|
| 01 | `tests/launch.mjs:19` | `const deadline = Date.now() + 20000;` | `const deadline = Date.now() + 180000;` | Timeout only: `npm start` now runs a full build first (spec 01). Every check is unchanged. |

Baseline unit test count before plan 01: 435 (from `npm test`, `# tests 435`).

## Manual checks

(Each plan appends one line per manual check: what was run, result.)

- 01: `node tests/launch.mjs` — PASS (npm start builds first).
- 01: `node tests/single-instance.mjs` — FAIL before the main.ts change (exit code 0), PASS after.
- 01: `npm run dev` — prints `Stingray dev data: ~/Library/Application Support/Stingray-dev`, runs next to the installed app; editing `electron/main.ts` restarts Electron and prints the log line; a syntax error prints the esbuild error and the failed-build line, Electron keeps running; Ctrl-C leaves no Electron/dev/Vite process. `STINGRAY_DATA_DIR=/tmp/stingray-dev-x npm run dev` uses that dir. PASS (rerun on the done bar).
