# Step 6 — Repo map sync (audit 12)

Status: draft · Umbrella: [modular restructure](2026-11-23-modular-restructure-design.md)

## Goal

The sidebar and Repo Map show the same Git numbers at the same time, driven by one clock: `GitStateService`.
Repo Map stops its own polling of full snapshots. Two related robustness fixes: a failed size measurement does
not fail the whole map, and opening a file does not recompute repository status and inventory.

## Non-goals

- No change to the 60 s fallback poll, the `.git` watcher, PR polling or the debounce.
- No change to snapshot content, map layout or reader UI.
- No push of snapshot content over IPC (Repo Map still pulls `repoSnapshot`).

## Current behaviour

- `src/RepoMap.tsx:48-73`: `refresh()` calls `api.repoSnapshot` (full `git status` + `ls-files` + `diff --numstat`
  + `git grep -c` sizes); `:71` runs it every 5 s while the document is visible; after each snapshot it also
  re-runs `inspectFile` for the open file (`:63`, `refreshFile` defined `:89`).
- The sidebar (`src/WorkspaceStatus.tsx`) and the selected workspace (`src/App.tsx:67`) read `useGitState`
  (`src/useGitState.ts`), fed by `git-state-changed` events.
- `electron/git-state.ts:28-31`: one 60 s fallback poll of every tracked workspace (when visible) and a `.git`
  watcher (`:104-135`). No notion of a selected workspace. Working-tree edits do not touch `.git`, so the sidebar
  only learns of them via the 60 s poll, a manual refresh, or a Repo Map snapshot: `GitService.status` reports to
  `GitStateService.observe` (`electron/git.ts:208`, `electron/main.ts:61`, `electron/git-state.ts:56-61`).
- `src/App.tsx:104-111` refreshes the selected workspace on select, window focus and visibility change
  (`refreshGitState`, which also forces a PR re-query, main.ts:232).
- So the sidebar and the map agree only because the map's 5 s snapshot pushes status into git-state; with the map
  closed, the sidebar lags up to 60 s.
- `electron/repo-map.ts:104`: `await measureSizes(root, files, unborn)` is outside any try; `measureSizes`
  (`electron/repo-map-size.ts:7`) runs `inventoryGit(['grep', …])`, which throws on the 16 MiB / 15 s limit
  (`repo-map.ts:25`). One failure fails the whole snapshot. (Audit said ~94; the call is at 104.)
- `electron/git.ts:224-227`: `inspectFile` runs `this.status(id)` (status + line counts + origin/main base) and
  `repoSnapshot(..., false)` (`ls-files` of the whole repo) just to find one file's entry.
- `WorkspaceGitState.revision` (`src/shared.ts:167`) increases only when status/error/PR changed
  (`git-state.ts:178-188`). `GitStatus` includes line totals, so most edits change it; an edit that keeps
  `+/−` counts and the change list identical (e.g. replacing a line's text) does not.

## Design

### Main: one poller

- New contract route `git.selectWorkspace(id: string | null)` (git contract, `z.tuple([idSchema.nullable()])`).
- `GitStateService.select(id | null)`: stores `selected`; if non-null, `track(id)` and `refresh(id)` once.
- New option `selectedPollMs = 5000`: a third interval refreshes `selected` when `visible()` (same guard as the
  existing polls), without forcing PR.
- `forget(id)` clears `selected` if it matches. `did-start-loading` (renderer reload) clears `selected`; the
  renderer re-sends.
- Status reads from `repoSnapshot` still go through `observe` (no change), so a manual map refresh still updates
  the sidebar.

### Renderer

- `src/App.tsx`: in the existing selection effect (`:104-111`), call `api.selectWorkspace(selected || null)` on
  change and on cleanup `selectWorkspace(null)`. The focus/visibility `refreshGitState` stays.
- `RepoMap.tsx`:
  - Remove the 5 s `setInterval` of `refresh()` (`:71`). Keep the initial load and the manual Refresh button.
  - `const { state } = useGitState(workspace.id)`; an effect calls `refresh()` (background, no spinner) whenever
    `state.revision` is greater than the revision the current snapshot was loaded for. Late responses keep using
    the existing `generation` guard.
  - Open-file check: while a file is open and the document is visible, a 5 s timer calls the existing
    `refreshFile` (`inspectFile` only, cheap after the fix below). This catches content edits that do not change
    the revision. With no file open, no timer runs.
- No feedback loop: a revision-triggered snapshot calls `status`, which reaches `observe`; if nothing changed,
  `apply` returns the previous state without a new revision (`git-state.ts:182`).

### `measureSizes` failure (repo-map.ts:104)

Wrap the call: on error, every file whose size is still unset gets
`{ state: 'unavailable', source: 'working tree', reason: 'Size measurement failed or exceeded limits' }` and
`statsNotice` mentions it. Untracked/unborn files whose `lines` come from sizes keep `lines: null` with the same
`lineNotice` path (`repo-map-size.ts:26`). The snapshot still returns.

### `inspectFile` without status/ls-files (git.ts:224-227)

- `GitService` keeps the last snapshot entry list per workspace root (set by `repoSnapshot`, cleared on removal).
- `inspectFile(id, path)` uses the cached entry for `path`. Only when there is no cached snapshot, or the path is
  not in it, it falls back to today's computation (so a file that just appeared still opens).
- `repo-map.ts` `inspectFile` itself is unchanged (it already takes the snapshot as an argument).
- Content changes are still detected: the inspection's `revision` hashes the file contents and diffs.

## Acceptance criteria

- [ ] With Repo Map closed, an unstaged edit in the selected workspace shows in the sidebar within ~5 s (+ debounce).
- [ ] With Repo Map open and idle, no `repo-map.repoSnapshot` calls happen while git-state revision is unchanged.
- [ ] After an edit that changes counts, the map reloads once; header change count and sidebar counts match.
- [ ] A same-line edit to the open file shows in the reader within ~5 s.
- [ ] Non-selected workspaces still update via watcher + 60 s poll only.
- [ ] A forced `measureSizes` failure gives a map with sizes marked unavailable, not an error.
- [ ] `inspectFile` with a cached snapshot runs no `status`/`ls-files` (asserted with a counting runner).

## Verification

- `npm run check`; `npm run test:e2e -- repo-map desktop workspace-status pull-requests`.
- New unit tests:
  - `tests/git/git-state.test.ts`: `select(id)` refreshes the selected workspace every `selectedPollMs` while
    visible, never when hidden; other tracked workspaces are not polled at that rate; `select(null)` and
    `forget(id)` stop it.
  - `tests/repo-map/repo-map.test.ts`: `repoSnapshot` with a runner whose `grep` fails still returns files with
    `size.state === 'unavailable'` and a `statsNotice`.
  - `tests/git/git.test.ts`: after `repoSnapshot`, `inspectFile` does not call `status`/`ls-files`; for a path not in
    the cache it falls back.
- New e2e check in `tests/repo-map/repo-map.mjs`: "sidebar and Repo Map agree at the same revision after an
  unstaged edit" — edit a tracked file, wait for the sidebar line label to change, then read
  `window.stingray.gitState(id)` and assert: map header change count = `status.changes.length`, sidebar
  `+a −d` = `status.lines`, and the map was reloaded for that revision.
- Existing `tests/repo-map.mjs` assertions that assume map polling must be re-targeted (not dropped):
  - `:136-159` "two real idle polls leave map … unchanged" counts `repo-snapshot` calls (`idleMapPolls >= 2`).
    New form: count `inspect-file` calls (≥ 2 in 11 s with a file open), assert **zero** `repo-snapshot` calls
    while idle, and the same zero-mutation check. This is stricter than before.
  - `:308-316` "automatic snapshot is held …" waits for a poll-driven snapshot. New form: trigger the automatic
    snapshot by an on-disk edit that changes counts (revision bump), then hold it with the same gate and keep the
    same assertions.
  - `:177-186` (edits refresh contents/line counts, same-line edits) keep their assertions; they now pass via
    revision reload and the open-file timer.

## Risks & rollback

- The selected workspace now runs `git status` + line counts every 5 s even when Repo Map is not shown (today
  only while the map is mounted, and the map's snapshot is heavier). Net cost is lower with the map open and
  higher with it closed. Bounded by the existing `concurrency = 3` limiter.
- A content edit that changes nothing in status and touches a file that is not open is not reflected in the map
  until the next revision. Sizes/line counts of such a file would be unchanged anyway.
- Rollback: revert the commit (no data changes).

## Open questions

- The agreement says the file check runs "on the same clock" as the git-state poll. Main does not emit when
  nothing changed, so this spec uses a renderer 5 s timer with the same period, running only while a file is
  open. If a literal shared tick is wanted, main would need a `git.onPollTick` event; not proposed.
- Re-targeting the two `repo-map.mjs` checks above changes existing assertions. Confirm this counts as
  "not weakened".
