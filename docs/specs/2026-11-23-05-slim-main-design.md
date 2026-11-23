# Step 5 — Slim main

Status: draft · Umbrella: [modular restructure](2026-11-23-modular-restructure-design.md)

## Goal

`electron/app/main.ts` only starts the app and wires services together. Every piece of logic now written inline
in main moves to a named service or module in its feature (or `electron/app/window.ts`), where it can be unit-tested.

## Non-goals

- No behaviour change: same dialogs, same texts, same order of cleanup steps, same locks.
- No new features (the extra removal cleanups of step 7 — webview partition, codegraph overlays — come later and
  plug into the service created here).

## Current behaviour

Line numbers are today's `electron/main.ts` (before steps 2-4). After step 3 the `handle(...)` calls are handler
objects per contract, but their bodies are the same.

| Lines | Inline logic | Destination |
|---|---|---|
| 33-38 | app name, `STINGRAY_DATA_DIR`, dev URL check, renderer URL, single-instance lock | stays in `main.ts` (startup) |
| 39-40 | `second-instance` focus | `electron/app/window.ts` (`focusExisting(win)`) |
| 41 | `quitting` flag | `window.ts` (close guard state) |
| 42, 134-138 | `cloning` flag + "a clone is already in progress" lock | `electron/features/git/clone-lock.ts`: `CloneLock` with `run(fn)` and `busy`; git handler uses it, close guard reads `busy` |
| 43, 208-228 | `openingLink` flag, terminal lookup, confirm dialog, `openTerminalLink` call | `electron/features/terminals/link-opener.ts`: `TerminalLinkOpener({ terminals, workspacePath, confirm, shell })` with the one-at-a-time lock; `confirm` is the existing `dialog.showMessageBox` body, injected from `window.ts` |
| 44-66 | service construction and cross-wiring | stays in `main.ts` (wiring) |
| 49, 195-198, 199-201, 203 | `visibleTerminals` set, `activity-view` filter by known terminals, `acknowledge-activity` focus/visibility check, clear on `did-start-loading` | `electron/features/activity/activity-visibility.ts`: `ActivityVisibility({ terminals, activity, isWindowFocusedAndVisible })` with `setVisible(ids)`, `acknowledge(id, terminalId, revision)`, `reset()` |
| 68-74 | `handle()` with sender check | already `electron/app/ipc.ts` (step 3) |
| 75-82 | `lockSession` for webview partitions | `window.ts` |
| 84-98 | install `stingray-views` launcher, start activity socket, prepare shell, restore history | `electron/features/activity/start.ts`: `startActivity({ activity, activityShell, terminals, userData, dirname })`, and `installViewsLauncher(...)` in views; main awaits both in the same order |
| 99-122 | `BrowserWindow` creation, `setWindowOpenHandler`, `will-navigate`, `will-attach-webview`, `did-attach-webview` hardening | `window.ts`: `createMainWindow({ rendererUrl, preload })` |
| 124-127, 129-132 | open-folder dialogs for pick-repository / pick-clone-parent | git handlers, with `pickFolder(title)` injected from `window.ts` |
| 141-147 | remove-workspace cleanup sequence: `git.removeWorkspace` → `gitState.forget` → `viewState.forget` (errors ignored) → `activity.forgetWorkspace` | `electron/features/git/workspace-removal.ts`: `WorkspaceRemoval({ git, gitState, viewState, activity })` with `remove(id, consent)`; same order, same error handling |
| 150-160 | `dbScans` cache for the `db-schema` route | removed in step 2 |
| 161-171, 183-187 | views handlers resolving the workspace path; `open-service-docs` catalog lookup | `electron/features/views/handlers.ts` exporting `viewsHandlers(deps)` |
| 174-179 | codegraph settings/conflicts handlers | `electron/features/codegraph/handlers.ts` |
| 233-242 | live-view frame-size schema (moved to contract in step 3), `stopAll` on `did-start-loading` and `closed` | `LiveViews.attach(win)` in `electron/features/runtime/live-view.ts` registers both hooks |
| 243-258 | window `close` guard: clone in progress, running terminals confirm, `quitting` | `window.ts`: `guardClose(win, { cloneBusy, runningTerminals, quit })` |
| 261-267 | `window-all-closed`, `will-quit` cleanup order (flush history → close terminals → dispose git state → close activity + views → close database) | stays in `main.ts` (lifecycle wiring), unchanged |

Each feature also exports a `xHandlers(deps): Invoke<XContract>` (in `handlers.ts`), so main just does
`registerContract(gitContract, gitHandlers({...}), ipc)` per feature.

## Design

- `main.ts` shape after this step: imports; startup block (lines 33-38 today); construct services; wire hooks
  (`git.onStatus`, `pullRequests.onListChange`, removal hooks); `app.whenReady`: start activity + launcher,
  `createMainWindow`, `registerContract` × 8 (app, git, repo-map, terminals, activity, codegraph, views, runtime), `liveViews.attach(win)`, `guardClose`, `loadURL`; quit lifecycle.
- New service files live in their feature folder and are exported from its `index.ts`.
- Electron APIs (`dialog`, `shell`, `BrowserWindow`) are injected as small functions so services are testable with
  fakes. Only `window.ts` and `main.ts` import `dialog`/`BrowserWindow`.

## Acceptance criteria

- [ ] `electron/app/main.ts` has no `let` other than `win` and `cleanedUp`, no `dialog.` calls, no `ipcMain`, no
      `z.` schemas, and is at most ~120 lines.
- [ ] Every row in the table is done; `grep -n "showMessageBox\|showOpenDialog" electron/app/main.ts` is empty.
- [ ] Dialog texts unchanged (string-compare in review).
- [ ] All e2e suites pass unchanged (this step is behaviour-free).

## Verification

- `npm run check`; `npm run test:e2e`.
- New unit tests (in the feature test folders):
  - `tests/git/workspace-removal.test.ts`: calls happen in order git → gitState → viewState → activity; a
    `viewState.forget` rejection does not fail the removal; a `git.removeWorkspace` failure calls none of the others.
  - `tests/git/clone-lock.test.ts`: second `run` while busy throws the existing message; `busy` resets after error.
  - `tests/terminals/link-opener.test.ts`: second call during a pending confirm throws "Finish the current link
    confirmation first."; unknown terminal throws "Terminal not found."; lock released after confirm rejects.
  - `tests/activity/activity-visibility.test.ts`: unknown terminal ids ignored, acknowledge only when
    focused+visible and terminal visible, `reset()` clears.

## Risks & rollback

- Moving the webview hardening into `window.ts` is security-relevant. Review it as a verbatim move; the
  `terminal-links` and `desktop` e2e suites cover sender/navigation checks.
- Rollback: revert the commit.

## Open questions

- None beyond the umbrella ones.
