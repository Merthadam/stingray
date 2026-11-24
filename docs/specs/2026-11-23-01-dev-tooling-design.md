# Step 1 — Dev tooling (audit 1, 2, 8)

Status: implemented · Commit 1 · Umbrella: [modular restructure](2026-11-23-modular-restructure-design.md)

## Goal

- `npm run dev` never touches the real app data and never collides with the installed app.
- Main-process code (main, preload, workers, CLI) rebuilds on save and Electron restarts by itself.
- `npm start` always runs a fresh build.
- A second instance on the same data dir fails loudly instead of exiting silently.

## Non-goals

- No hot reload of the main process without restart.
- No copy or migration of real app data into the dev data dir.
- No change to the packaged app's data location or to `STINGRAY_DATA_DIR` semantics.
- No watch for `agents/` bundles beyond what the main build needs (they are built once at dev start).

## Current behaviour

- `scripts/dev.mjs:3` imports `build-electron.mjs` once; there is no watch. Main/preload edits need a manual
  restart (README.md:92 says so).
- `scripts/dev.mjs:6-8` passes only `STINGRAY_DEV_URL`; no data dir is set, so dev uses the default userData
  (`~/Library/Application Support/Stingray`, from `app.setName('Stingray')` at `electron/main.ts:33`) — the same
  data as the installed app.
- `scripts/build-electron.mjs:3` builds four entry points (`main`, `preload`, `codegraph-worker`, `views-cli`)
  with a single top-level `await build(...)`; lines 6-13 copy the grammar wasm and skills and build
  `agents/pi-extension.ts` and `agents/hook-client.ts`. Nothing is exported for reuse.
- `package.json` `"start": "electron ."` runs whatever is in `dist-electron/` and `dist/`, possibly stale.
- `electron/main.ts:34` applies `STINGRAY_DATA_DIR`; `electron/main.ts:38` does
  `if (!app.requestSingleInstanceLock()) app.exit(0);` — exit code 0, no message. Electron keeps the singleton
  lock in the userData directory, so the lock is per data dir (main.ts:34 runs before :38).

## Design

### Separate dev data dir (scripts/dev.mjs)

- If `STINGRAY_DATA_DIR` is unset, `dev.mjs` sets it to `<appData>/Stingray-dev`, where `<appData>` is
  `~/Library/Application Support` on macOS and `$XDG_CONFIG_HOME` or `~/.config` on Linux.
- The directory starts empty (Electron creates it). Nothing is copied.
- `dev.mjs` prints one line at start: `Stingray dev data: <dir>`.

### Watch and restart

- `build-electron.mjs` exports `electronBuildOptions` (the line-3 options) and an `async function buildExtras()`
  (lines 6-13). Run directly, it behaves exactly as today (build + extras).
- `dev.mjs`:
  1. `await buildExtras()` once.
  2. `const ctx = await esbuild.context({ ...electronBuildOptions, plugins: [restartPlugin] })`, then `ctx.watch()`.
  3. `restartPlugin.onEnd(result)`: if `result.errors.length`, print them and keep the current Electron running;
     otherwise (re)start Electron.
  4. Restart = send `SIGTERM` to the child, wait for its `exit`, spawn a new one. A `restarting` flag tells the
     child `exit` handler not to close Vite and exit the script.
  5. Rebuilds during a restart are coalesced: at most one pending restart.
  6. `SIGINT`/`SIGTERM` to `dev.mjs`: dispose ctx, kill the child, close Vite, exit.
- The Electron `will-quit` path already flushes and closes (main.ts:263-267), so a SIGTERM restart is a normal
  quit. Running terminals are killed on restart; this is dev-only and expected.

### `npm start`

`"start": "npm run build && electron ."`. npm appends extra args to the last command, so
`npm start -- --remote-debugging-port=0` (used by `tests/launch.mjs:12`) still reaches Electron.

### Single-instance failure

Replace `electron/main.ts:38` with:

```ts
if (!app.requestSingleInstanceLock()) {
  console.error(`Stingray is already running with data dir ${app.getPath('userData')}. ` +
    'Quit it, or set STINGRAY_DATA_DIR to another folder.');
  app.exit(1);
}
```

The `second-instance` handler (main.ts:40) stays: the running instance still focuses its window. Step 5 moves this
block unchanged into `electron/app/index.ts` ([composition root](2026-11-23-05-composition-root-design.md)).

### Docs

Update README "Development" bullets and `.agents/skills/run-local/SKILL.md` (mentions `npm run dev`) to describe
the dev data dir and auto-restart.

## Acceptance criteria

- [ ] `npm run dev` with no env uses `<appData>/Stingray-dev`; the path is printed.
- [ ] `STINGRAY_DATA_DIR=/tmp/x npm run dev` uses `/tmp/x`.
- [ ] `npm run dev` works while the installed app runs (different data dir, different lock).
- [ ] Saving a file under `electron/` rebuilds and restarts Electron within a few seconds; a type/syntax error
      prints the esbuild error and leaves the running app alone.
- [ ] Ctrl-C stops Electron, Vite and the watcher; no orphan processes.
- [ ] `npm start` builds before launching.
- [ ] A second `electron .` on the same data dir prints the error naming the data dir and exits with code 1.
- [ ] `node scripts/build-electron.mjs` output is byte-for-byte the same file set as before.

## Verification

- `npm run check`.
- `node tests/launch.mjs` (exercises `npm start`). Its ready deadline (`tests/launch.mjs:19`, 20 s) does not cover a
  full build; raise it so it waits for the build (180 s). This is a timeout change, not a weaker check; it is
  listed in the PR description with the other test edits (OQ3).
- New `tests/single-instance.mjs` (moved to `tests/app/` in step 4; native, run by hand and in the done-bar run,
  not a new e2e suite): start
  `electron .` with a temp `STINGRAY_DATA_DIR`, start a second one with the same dir, assert exit code 1 and
  stderr containing the dir.
- Manual: `npm run dev`, edit `electron/main.ts` (add a `console.log`), see restart; introduce a syntax error,
  see the error and no restart; Ctrl-C, `pgrep -f Electron` shows none from this checkout.

## Risks & rollback

- Restart kills dev terminals and in-flight clones. Accepted for dev.
- macOS may show a second Dock icon briefly during restart. Cosmetic.
- `npm start` becomes slower (tsc + vite + esbuild). `tests/launch.mjs` timeout must follow (see above).
- Rollback: revert the commit; behaviour returns to build-once dev and `electron .` start.

## Decisions

- **`npm start` (OQ9):** `npm run build` (incl. `tsc --noEmit` typecheck) then `electron .`; no fast path.
- Dev data dir is `<appData>/Stingray-dev` unless `STINGRAY_DATA_DIR` is set; nothing is copied into it.
- Main-process code is rebuilt by esbuild watch and Electron is restarted; no in-process hot reload.
- A failed single-instance lock prints an error naming the data dir and exits with code 1.
- Build entry `electron/main.ts` keeps its path through the whole PR (it becomes the thin entry in step 5), so the
  watch set up here keeps working after the moves.
