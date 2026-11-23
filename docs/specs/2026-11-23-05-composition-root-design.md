# Step 5 — Composition root

Status: draft (decisions final) · Commit 6 · Umbrella: [modular restructure](2026-11-23-modular-restructure-design.md)

## Goal

`electron/main.ts` becomes a thin entry (`import { start } from './app'; start();`). `electron/app/` is the single
composition root: it creates driven adapters, wires them into core services, registers lifecycle listeners and IPC
contracts, and owns the window. Every piece of logic still written inline in main moves into core (testable with
fakes) or into an Electron-specific adapter.

## Non-goals

- No behaviour change except audit 20 (webview storage cleared on removal, [step 7](2026-11-23-07-audit-fixes-design.md#finding-20--webview-storage-survives-workspace-removal)):
  same dialogs, texts, cleanup order, locks.
- No change to feature handler objects (moved in commit 5) or to core services beyond the new ones below.

## Current behaviour

Line numbers are today's `electron/main.ts` (before steps 2-5). After commit 5 the handler bodies live in
`electron/adapters/driving/ipc/<feature>.ts` and services come from `electron/app/wiring/<feature>.ts`; the
remaining inline logic is what this table lists.

| Lines | Inline logic | Destination |
|---|---|---|
| 33-38 | app name, `STINGRAY_DATA_DIR`, dev URL check, renderer URL, single-instance lock (step 1 version) | `electron/app/index.ts` `start()`, unchanged |
| 39-40 | `second-instance` focus | `electron/app/window.ts` `focusExisting(win)` |
| 41 | `quitting` flag | `window.ts` (close guard state) |
| 42, 134-138 | `cloning` flag + "a clone is already in progress" lock | `electron/core/git/clone-lock.ts`: `CloneLock` with `run(fn)` and `busy`; git handlers use it, close guard reads `busy` |
| 43, 208-228 | `openingLink` flag, terminal lookup, confirm dialog, `openTerminalLink` | `electron/core/terminals/link-opener.ts`: `TerminalLinkOpener({ terminals, workspacePath, confirm, actions })` with the one-at-a-time lock; `confirm` port implemented by `electron/adapters/driven/electron-shell/dialogs.ts` (the existing `dialog.showMessageBox` body) |
| 44-66 | service construction, cross-wiring, event senders | `electron/app/compose.ts` using `app/wiring/*` and `driven/electron-shell/sender.ts` |
| 49, 195-203 | `visibleTerminals`, `activity-view` filter, `acknowledge-activity` focus/visibility check, reset on `did-start-loading` | `electron/core/activity/activity-visibility.ts`: `ActivityVisibility({ terminals: TerminalDirectory, activity, isWindowFocusedAndVisible })` with `setVisible(ids)`, `acknowledge(id, terminalId, revision)`, `reset()`; `window.ts` supplies `isWindowFocusedAndVisible` and calls `reset()` |
| 51-54 | `GitService` hooks `beforeRemove` (close terminals, release views) / `removeFailed` (reopen views) | `WorkspaceLifecycle` listeners registered in `compose.ts`: terminals `beforeRemove` (`blocking: true`), views release `beforeRemove`, views reopen `removeFailed` |
| 68-74 | `handle()` with sender check | `electron/app/ipc.ts` (step 3) |
| 75-82 | `lockSession` for webview partitions | `electron/adapters/driven/electron-shell/sessions.ts`: `lockSession(partition)`, `clearWorkspaceSession(id)` (audit 20) |
| 84-98 | install `stingray-views` launcher, start activity socket, prepare shell, restore history | `compose.ts` `startServices()`: `driven/fs/launcher.ts`, `driving/hooks/activity-socket.ts`, `driven/fs/activity-shell.ts`, `ActivityHistory.restore`; same order |
| 99-122 | `BrowserWindow`, `setWindowOpenHandler`, `will-navigate`, `will-attach-webview`, `did-attach-webview` | `window.ts`: `createMainWindow({ rendererUrl, preload, lockSession })`, moved verbatim |
| 124-132 | open-folder dialogs for pick-repository / pick-clone-parent | `pickFolder(title)` port implemented in `driven/electron-shell/dialogs.ts`, passed to `ipc/git.ts` |
| 141-147 | remove-workspace sequence: `git.removeWorkspace` → `gitState.forget` → `viewState.forget` (errors ignored) → `activity.forgetWorkspace` | `afterRemove` listeners in `compose.ts`, same registration order; `Promise.allSettled` keeps "errors ignored" for all of them (rule 3) |
| 161-171, 183-187 | views handlers resolving the workspace path; `open-service-docs` catalog lookup | already `ipc/views.ts` (commit 5) |
| 233-242 | `stopAll` on `did-start-loading` and `closed` | `window.ts` calls `liveViews.stopAll()` from both hooks |
| 243-258 | window `close` guard: clone in progress, running terminals confirm, `quitting` | `window.ts`: `guardClose(win, { cloneBusy, runningTerminals, confirm, quit })` |
| 261-267 | `window-all-closed`, `will-quit` cleanup order (flush history → close terminals → dispose git state → close activity + views → close database) | `electron/app/lifecycle.ts` `registerQuit(services)`, same order |

## Design

- `electron/main.ts`: one import, one call. Nothing else.
- `electron/app/index.ts` `start()`: startup block, then `app.whenReady` → `compose()` → `createMainWindow` →
  `registerContract` × 8 (app, git, repo-map, terminals, activity, codegraph, views, runtime) → `guardClose` →
  `loadURL`; `registerQuit`.
- `electron/app/compose.ts` is the only place that constructs adapters and core services and connects them
  (publishers via `sender()`, `WorkspaceLifecycle` listeners, `TerminalDirectory`, `GitStateService.observe`,
  `pullRequests.onListChange`). It returns a typed `Services` object.
- Only `electron/app/*` and `driven/electron-shell/*` import `electron` APIs (`dialog`, `shell`, `session`,
  `BrowserWindow`, `clipboard`); core receives them as ports.
- Process entries `electron/app/views-cli.ts` and `electron/app/codegraph-worker.ts` (commit 5) follow the same
  pattern for their processes.

## Acceptance criteria

- [ ] `electron/main.ts` has exactly one import (`./app`) and one call.
- [ ] `electron/app/index.ts` + `compose.ts` contain no business logic: no `let` other than `win`/`cleanedUp`, no
      `dialog.` calls, no `ipcMain`, no zod schemas.
- [ ] Every row of the table is done; `grep -rn "showMessageBox\|showOpenDialog" electron` only matches
      `electron/adapters/driven/electron-shell/dialogs.ts`.
- [ ] Dialog texts unchanged (string-compare in review).
- [ ] All e2e suites pass unchanged.

## Verification

- `npm run check`; `npm run test:e2e`.
- New core tests with fakes:
  - `tests/git/clone-lock.test.ts`: second `run` while busy throws the existing message; `busy` resets after error.
  - `tests/terminals/link-opener.test.ts`: second call during a pending confirm throws "Finish the current link
    confirmation first."; unknown terminal throws "Terminal not found."; lock released after confirm rejects.
  - `tests/activity/activity-visibility.test.ts`: unknown terminal ids ignored; acknowledge only when
    focused+visible and terminal visible; `reset()` clears.
  - `tests/git/workspace-lifecycle.test.ts` (from commit 5) gains: listeners registered by `compose.ts` run in the
    registration order git-state → view state → activity → webview session (audit 20); a view-state rejection does
    not fail the removal; a failing `git.removeWorkspace` runs no `afterRemove` listener.

## Risks & rollback

- Moving webview hardening into `window.ts` is security-relevant; review it as a verbatim move. The
  `terminal-links` and `desktop` e2e suites cover sender and navigation checks.
- Rollback: revert the commit.

## Decisions

- **Composition root (OQ1):** `electron/app/` (`index.ts`, `compose.ts`, `window.ts`, `ipc.ts`, `lifecycle.ts`,
  process entries, `wiring/`); `electron/main.ts` is a thin entry.
- **Single IPC sender check** in `electron/app/ipc.ts`, used by every contract registration.
- **Lifecycle (OQ7 A, rule 3):** removal side effects are `WorkspaceLifecycle` listeners; only terminals
  `beforeRemove` is blocking.
- **Electron APIs** stay in `electron/app/` and `driven/electron-shell/`; core sees ports.
