# 01 · Dev tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** `npm run dev` uses its own data dir and restarts Electron on main-process edits; `npm start` always builds; a
second instance on the same data dir fails loudly (audit 1, 2, 8).

**Architecture:** `scripts/build-electron.mjs` exports its esbuild options and the "extras" step; `scripts/dev.mjs` uses
an esbuild watch context with an `onEnd` plugin that restarts Electron. `electron/main.ts` prints an error and exits 1
when the single-instance lock fails.

**Tech Stack:** Node 24 ESM scripts, esbuild context API, Vite `createServer`, Electron 45.

**Spec:** [`docs/specs/2026-11-23-01-dev-tooling-design.md`](../specs/2026-11-23-01-dev-tooling-design.md)

**Depends on:** nothing (first plan). **Commit:** one, `chore(dev): separate dev data dir, watch+restart, fresh npm start, loud single-instance failure`.

---

## Files

- Modify: `scripts/build-electron.mjs` (export `electronBuildOptions`, `buildExtras`; run both when executed directly)
- Modify: `scripts/dev.mjs` (dev data dir, watch, restart)
- Modify: `package.json:15` (`start`)
- Modify: `electron/main.ts:38` (single-instance failure)
- Modify: `tests/launch.mjs:19` (ready deadline 20 s → 180 s; listed in ledger)
- Create: `tests/single-instance.mjs` (native, run by hand; moved to `tests/app/` in plan 04)
- Create: `docs/plans/2026-11-23-test-edit-ledger.md` (running list of allowed test edits for the PR description)
- Modify: `README.md:92` (Development bullet), `.agents/skills/run-local/SKILL.md:18-20`

---

### Task 1: Baseline and test-edit ledger

**Files:** Create `docs/plans/2026-11-23-test-edit-ledger.md`

- [ ] **Step 1: Confirm a green baseline**

Run: `git status --short && npm run check 2>&1 | tail -n 12`
Expected: empty `git status`; the node:test summary ends with `# fail 0`. Note the `# tests N` number.

- [ ] **Step 2: Record the build output baseline (used by Task 2 and plan 04)**

Run:
```bash
node scripts/build-electron.mjs && (cd dist-electron && find . -type f | sort | xargs shasum -a 256) > /tmp/stingray-dist-electron-before.txt && wc -l /tmp/stingray-dist-electron-before.txt
```
Expected: a line count > 5 (main.cjs, preload.cjs, codegraph-worker.cjs, views-cli.cjs, tree-sitter-python.wasm, pi-extension.js, hook-client.cjs, skills/**).

- [ ] **Step 3: Create the ledger**

```markdown
# Test-edit ledger (modular restructure PR)

Every edit to an existing test file other than an import path, a fixture/entry path string (plan 04) or a raw IPC
channel string (plan 03) is listed here, old vs new. Plan 10 copies this file into the PR description (OQ3).
Each replacement is at least as strict as the original.

| Plan | File | Old | New | Why at least as strict |
|---|---|---|---|---|
| 01 | `tests/launch.mjs:19` | `const deadline = Date.now() + 20000;` | `const deadline = Date.now() + 180000;` | Timeout only: `npm start` now runs a full build first (spec 01). Every check is unchanged. |

Baseline unit test count before plan 01: N (from `npm test`, `# tests N`).

## Manual checks

(Each plan appends one line per manual check: what was run, result.)
```

Replace `N` with the number from Step 1.

### Task 2: Export build options and extras from `build-electron.mjs`

**Files:** Modify `scripts/build-electron.mjs` (whole file, 13 lines today)

- [ ] **Step 1: Rewrite the file**

```js
import { build } from 'esbuild';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const electronBuildOptions = { entryPoints: ['electron/main.ts', 'electron/preload.ts', 'electron/codegraph-worker.ts', 'electron/views-cli.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, external: ['electron', 'node-pty', 'web-tree-sitter', '@colbymchenry/codegraph'] };
// CodeGraph runs in codegraph-worker.cjs (forked by main) and stays external: it resolves its platform bundle (grammars, native kernel, workers) from node_modules at runtime.

export async function buildExtras() {
  await mkdir('dist-electron', { recursive: true });
  // The Database tab parses Python with this grammar; web-tree-sitter stays external so it finds its own runtime wasm.
  await copyFile('electron/tree-sitter-python.wasm', 'dist-electron/tree-sitter-python.wasm');
  // Agent skills: Pi loads them via the extension's resources_discover; `stingray-views help` prints the same SKILL.md.
  await rm('dist-electron/skills', { recursive: true, force: true });
  await cp('agents/skills', 'dist-electron/skills', { recursive: true });
  // Keep Pi's host API external: the per-invocation extension resolves it inside Pi.
  await build({ entryPoints: ['agents/pi-extension.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: 'dist-electron/pi-extension.js', external: ['@earendil-works/pi-coding-agent'] });
  // Claude Code hooks / Codex notify run this per event with Stingray's Electron binary as Node (ELECTRON_RUN_AS_NODE).
  await build({ entryPoints: ['agents/hook-client.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist-electron/hook-client.cjs' });
}

// Run directly (npm run build): same output as before. Imported (scripts/dev.mjs): nothing runs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build(electronBuildOptions);
  await buildExtras();
}
```

- [ ] **Step 2: Verify byte-identical output**

Run:
```bash
rm -rf dist-electron && node scripts/build-electron.mjs && (cd dist-electron && find . -type f | sort | xargs shasum -a 256) > /tmp/stingray-dist-electron-after.txt && diff /tmp/stingray-dist-electron-before.txt /tmp/stingray-dist-electron-after.txt && echo SAME
```
Expected: `SAME`.

### Task 3: Watch + restart in `scripts/dev.mjs`

**Files:** Modify `scripts/dev.mjs` (whole file, 10 lines today)

- [ ] **Step 1: Rewrite the file**

```js
// npm run dev: own data dir, Vite for the renderer, esbuild watch for main/preload/worker/CLI with an Electron restart
// after every successful rebuild. A failed rebuild prints esbuild's errors and leaves the running app alone.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { context } from 'esbuild';
import { createServer } from 'vite';
import { buildExtras, electronBuildOptions } from './build-electron.mjs';

const appData = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
  : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dataDir = path.resolve(process.env.STINGRAY_DATA_DIR || path.join(appData, 'Stingray-dev'));
console.log(`Stingray dev data: ${dataDir}`);

await buildExtras();
const server = await createServer();
await server.listen();
const env = { ...process.env, STINGRAY_DEV_URL: 'http://127.0.0.1:5178', STINGRAY_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;

let child = null, restarting = false, pending = false, stopping = false;
const stopChild = c => new Promise(resolve => { if (c.exitCode !== null || c.signalCode !== null) resolve(); else { c.once('exit', resolve); c.kill('SIGTERM'); } });
function launch() {
  const c = spawn('node_modules/.bin/electron', ['.'], { stdio: 'inherit', env });
  child = c;
  // Quitting the app (not a restart) ends the dev session, as before.
  c.on('exit', code => { if (child === c) child = null; if (!restarting && !stopping) void shutdown(code || 0); });
}
async function restart() {
  if (restarting) { pending = true; return; } // coalesce: at most one pending restart
  restarting = true;
  if (child) await stopChild(child);
  restarting = false;
  if (stopping) return;
  launch();
  if (pending) { pending = false; await restart(); }
}
const restartPlugin = { name: 'restart-electron', setup(build) {
  build.onEnd(result => {
    if (result.errors.length) { console.error(`Main-process build failed (${result.errors.length} error(s)); Electron keeps running the previous build.`); return; }
    void restart();
  });
} };
const ctx = await context({ ...electronBuildOptions, plugins: [restartPlugin] });
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  await ctx.dispose();
  if (child) await stopChild(child);
  await server.close();
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown(0));
await ctx.watch();
```

- [ ] **Step 2: Manual check — data dir and restart**

Run: `npm run dev` (leave it running).
Expected: first line `Stingray dev data: /Users/<you>/Library/Application Support/Stingray-dev`; the app window opens.
Then add `console.log('dev restart check');` as the last line of `electron/main.ts` and save.
Expected within a few seconds: the window closes and reopens; the terminal prints `dev restart check`.
Then change that line to `console.log('dev restart check'` (syntax error) and save.
Expected: esbuild prints the error plus `Main-process build failed (1 error(s)); Electron keeps running the previous build.`; the window stays open.
Remove the line again (window restarts), then press Ctrl-C.
Expected: the script exits. Run `pgrep -fl "$(pwd)/node_modules/electron"`; Expected: no output.

- [ ] **Step 3: Manual check — explicit data dir and parallel installed app**

Run: `STINGRAY_DATA_DIR=/tmp/stingray-dev-x npm run dev`
Expected: `Stingray dev data: /tmp/stingray-dev-x`; the app opens even while the installed Stingray app is running. Ctrl-C.

### Task 4: `npm start` builds first

**Files:** Modify `package.json:15`, `tests/launch.mjs:19`

- [ ] **Step 1: Edit `package.json`**

Replace `"start": "electron .",` with `"start": "npm run build && electron .",`.

- [ ] **Step 2: Edit `tests/launch.mjs:19`**

Replace `const deadline = Date.now() + 20000;` with `const deadline = Date.now() + 180000;` (already in the ledger, Task 1).

- [ ] **Step 3: Run the launch smoke**

Run: `node tests/launch.mjs`
Expected: `PASS npm start opens real desktop bridge and empty state, closes cleanly.` (takes a full build first).

### Task 5: Single-instance failure is loud (TDD)

**Files:** Create `tests/single-instance.mjs`; Modify `electron/main.ts:38`

- [ ] **Step 1: Write the failing native test**

```js
// Native check, run by hand and in the done-bar run (needs `npm run build` and a display): a second instance on the
// same data dir exits with code 1 and names the data dir on stderr.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'stingray-single-instance-'));
const env = { ...process.env, STINGRAY_DATA_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE; delete env.STINGRAY_DEV_URL;
const electron = 'node_modules/.bin/electron';
const first = spawn(electron, ['.', '--remote-debugging-port=0'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let firstErr = '';
first.stderr.on('data', b => { firstErr += b; });
try {
  for (const end = Date.now() + 30000; !/DevTools listening/.test(firstErr); await new Promise(r => setTimeout(r, 100))) {
    if (first.exitCode !== null) throw new Error('First instance exited early');
    if (Date.now() > end) throw new Error('First instance not ready');
  }
  const second = spawn(electron, ['.'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  second.stderr.on('data', b => { stderr += b; });
  const code = await new Promise(resolve => second.on('exit', resolve));
  assert.equal(code, 1, 'second instance exit code');
  assert.ok(stderr.includes(`Stingray is already running with data dir ${dir}`), stderr);
  console.log('PASS second instance on the same data dir exits 1 and names the data dir.');
} finally {
  first.kill();
  await new Promise(resolve => (first.exitCode !== null ? resolve() : first.once('exit', resolve)));
  await rm(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run build && node tests/single-instance.mjs`
Expected: FAIL with `AssertionError ... second instance exit code` (actual `0`).

- [ ] **Step 3: Implement in `electron/main.ts`**

Replace line 38 `if (!app.requestSingleInstanceLock()) app.exit(0);` with:

```ts
if (!app.requestSingleInstanceLock()) {
  console.error(`Stingray is already running with data dir ${app.getPath('userData')}. ` +
    'Quit it, or set STINGRAY_DATA_DIR to another folder.');
  app.exit(1);
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm run build && node tests/single-instance.mjs`
Expected: `PASS second instance on the same data dir exits 1 and names the data dir.`

### Task 6: Docs

**Files:** Modify `README.md:92`, `.agents/skills/run-local/SKILL.md:18-20`

- [ ] **Step 1: README line 92** — replace the `npm run dev` bullet with:

```markdown
- `npm run dev`: builds the agent bundles, starts Vite on `127.0.0.1:5178`, then launches Electron with its own data dir `~/Library/Application Support/Stingray-dev` (Linux: `$XDG_CONFIG_HOME/Stingray-dev` or `~/.config/Stingray-dev`; override with `STINGRAY_DATA_DIR`). It never touches the installed app's data and can run next to it. Renderer changes hot-reload; main/preload/worker/CLI changes rebuild and restart Electron (dev terminals are closed by the restart); a build error is printed and the running app stays. `npm start` runs a full `npm run build` (incl. typecheck) and then launches.
```

- [ ] **Step 2: SKILL.md lines 18-20** — replace with:

```markdown
- **Native (macOS, fastest loop):** `npm run dev` — serves the renderer with Vite hot reload, rebuilds the main
  process on save and restarts Electron. Uses its own data dir (`~/Library/Application Support/Stingray-dev`, printed
  at start), so your real projects/worktrees are untouched; set `STINGRAY_DATA_DIR=/tmp/somewhere` for a throwaway one.
```

### Task 7: Verify and commit

- [ ] **Step 1: Full check**

Run: `npm run check 2>&1 | tail -n 12`
Expected: `# fail 0`; `# tests` equals the baseline N.

- [ ] **Step 2: Commit**

```bash
git add scripts/build-electron.mjs scripts/dev.mjs package.json electron/main.ts tests/launch.mjs tests/single-instance.mjs README.md .agents/skills/run-local/SKILL.md docs/plans/2026-11-23-test-edit-ledger.md
git status --short   # nothing from release/, artifacts/, dist*/
git commit -m "chore(dev): separate dev data dir, watch+restart, fresh npm start, loud single-instance failure"
```

## Self-review checklist (done when writing this plan)

- Spec coverage: data dir (T3), watch/restart/coalesce/error/SIGINT (T3), `npm start` (T4), launch timeout + ledger (T1, T4), single-instance (T5), docs (T6), byte-for-byte build (T2). Build entry `electron/main.ts` keeps its path.
- No new e2e suite; `tests/single-instance.mjs` is not added to `scripts/run-e2e.mjs`.
