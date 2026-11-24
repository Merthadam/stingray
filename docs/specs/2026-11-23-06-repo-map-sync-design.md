# Step 6 — Repo map sync (audit 12)

Status: implemented · Commit 7 · Umbrella: [modular restructure](2026-11-23-modular-restructure-design.md)

## Goal

The sidebar and Repo Map show the same Git numbers at the same time, driven by one clock: `GitStateService`
(`electron/core/git/git-state.ts`). Repo Map has no poll of its own; it reloads when the git-state revision bumps.
The renderer keeps a cheap 5 s check of the open file only. Two related robustness fixes: a failed size
measurement does not fail the whole map, and opening a file does not recompute status and inventory.

## Non-goals

- No change to the 60 s fallback poll, the `.git` watcher, PR polling or the debounce.
- No change to snapshot content, map layout or reader UI.
- No push of snapshot content over IPC (Repo Map still pulls `repoSnapshot`).

## Current behaviour

Paths are today's; after step 4 they are `electron/core/git/`, `electron/core/repo-map/`, `src/features/repo-map/`,
`src/features/git/`, `src/app/`.

- `src/RepoMap.tsx:48-73`: `refresh()` calls `api.repoSnapshot` (full `git status` + `ls-files` + `diff --numstat`
  + `git grep -c` sizes); `:71` runs it every 5 s while visible; after each snapshot it re-runs `inspectFile` for
  the open file (`:63`, `refreshFile` at `:89`).
- The sidebar (`src/WorkspaceStatus.tsx`) and the selected workspace (`src/App.tsx:67`) read `useGitState`
  (`src/useGitState.ts`), fed by the git-state event (`git.onStatusChanged` after step 3).
- `electron/git-state.ts:28-31`: one 60 s fallback poll of every tracked workspace (when visible) and a `.git`
  watcher (`:104-135`). No notion of a selected workspace. Working-tree edits do not touch `.git`, so the sidebar
  learns of them only via the 60 s poll, a manual refresh, or a Repo Map snapshot (`GitService.status` reports to
  `GitStateService.observe`: `electron/git.ts:208`, `electron/main.ts:61`, `electron/git-state.ts:56-61`).
- `src/App.tsx:104-111` refreshes the selected workspace on select, window focus and visibility change.
- `electron/repo-map.ts:104`: `await measureSizes(root, files, unborn)` is outside any try; `measureSizes`
  (`electron/repo-map-size.ts:7`) throws on the 16 MiB / 15 s limit (`repo-map.ts:25`), failing the whole snapshot.
- `electron/git.ts:224-227`: `inspectFile` runs `this.status(id)` and `repoSnapshot(..., false)` (`ls-files` of the
  whole repo) to find one file's entry. After commit 5 this lives in `core/repo-map/repo-map-service.ts`.
- `WorkspaceGitState.revision` increases only when status/error/PR changed (`git-state.ts:178-188`). An edit that
  keeps `+/−` counts and the change list identical (replacing a line's text) does not bump it.

## Design

### Main: one poller

- New git contract route `selectWorkspace(id: string | null)` (`z.tuple([idSchema.nullable()])`), channel
  `git.selectWorkspace`.
- `GitStateService.select(id | null)`: stores `selected`; if non-null, `track(id)` and `refresh(id)` once.
- New option `selectedPollMs = 5000`: a third interval refreshes `selected` when `visible()`, without forcing PR.
- Non-selected workspaces: `.git` watcher + 60 s poll, unchanged.
- `forget(id)` clears `selected` if it matches; a renderer reload (`did-start-loading`, handled in
  `electron/app/window.ts`) clears it and the renderer re-sends.
- Status reads from `repoSnapshot` still go through `observe`, so a manual map refresh still updates the sidebar.

### Main: open-file stamp

- New repo-map contract route `statFile(workspaceId, path)` → `{ exists: boolean; size: number; mtimeMs: number }`,
  channel `repo-map.statFile`. Core `RepoMapService.statFile` uses the `WorkingFiles` port (`lstat` in
  `driven/fs/working-files.ts`); path validation is the same as `inspectFile`'s. No git calls.

### Renderer

- `src/app/App.tsx`: in the selection effect (`:104-111` today), call `api.selectWorkspace(selected || null)` on
  change and `selectWorkspace(null)` on cleanup. The focus/visibility `refreshGitState` stays.
- `src/features/repo-map/RepoMap.tsx`:
  - Remove the 5 s `setInterval` of `refresh()`. Keep the initial load and the Refresh button.
  - `const { state } = useGitState(workspace.id)` (via `src/features/git/index.ts`); an effect calls `refresh()`
    (background, no spinner) whenever `state.revision` is greater than the revision the current snapshot was loaded
    for. Late responses keep the existing `generation` guard.
  - Open-file check: while a file is open and the document is visible, a 5 s timer calls `api.statFile`; if the
    stamp differs from the one taken at the last inspection (or the file vanished), it calls the existing
    `refreshFile` (`inspectFile`). With no file open, no timer runs. This catches same-line edits that do not bump
    the revision.
- No feedback loop: a revision-triggered snapshot calls `status` → `observe`; if nothing changed, `apply` returns
  the previous state without a new revision (`git-state.ts:182`).

### `measureSizes` failure

Wrap the call (rule 2, degraded result): on error, every file whose size is unset gets
`{ state: 'unavailable', source: 'working tree', reason: 'Size measurement failed or exceeded limits' }` and
`statsNotice` mentions it. Untracked/unborn files whose `lines` come from sizes keep `lines: null` with the same
`lineNotice` path (`repo-map-size.ts:26`). The snapshot still returns.

### `inspectFile` without status/ls-files

- `RepoMapService` keeps the last snapshot entry list per workspace (set by `repoSnapshot`, cleared by an
  `afterRemove` lifecycle listener).
- `inspectFile(id, path)` uses the cached entry. Only without a cached snapshot, or for a path not in it, it falls
  back to today's computation (a new file still opens).
- Content changes are still detected: the inspection's `revision` hashes contents and diffs.

## Acceptance criteria

- [ ] With Repo Map closed, an unstaged edit in the selected workspace shows in the sidebar within ~5 s (+ debounce).
- [ ] With Repo Map open and idle, no `repo-map.repoSnapshot` calls happen while the revision is unchanged.
- [ ] After an edit that changes counts, the map reloads once; header change count and sidebar counts match.
- [ ] A same-line edit to the open file shows in the reader within ~5 s.
- [ ] Non-selected workspaces still update via watcher + 60 s poll only.
- [ ] A forced `measureSizes` failure gives a map with sizes marked unavailable, not an error.
- [ ] `inspectFile` with a cached snapshot runs no `status`/`ls-files` (counting fake runner).

## Verification

- `npm run check`; `npm run test:e2e -- repo-map desktop workspace-status pull-requests`.
- New unit tests:
  - `tests/git/git-state.core.test.ts`: `select(id)` refreshes the selected workspace every `selectedPollMs` while
    visible, never when hidden; other workspaces are not polled at that rate; `select(null)` and `forget(id)` stop it.
  - `tests/repo-map/repo-map.core.test.ts`: inventory whose `grep` fails → files with `size.state === 'unavailable'`
    and a `statsNotice`; after `repoSnapshot`, `inspectFile` makes no `status`/`ls-files` calls; uncached path falls
    back; `statFile` makes no git calls.
- New e2e check in `tests/repo-map/repo-map.mjs`: "sidebar and Repo Map agree at the same revision after an
  unstaged edit" — edit a tracked file, wait for the sidebar line label to change, then read
  `window.stingray.gitState(id)` and assert: map header change count = `status.changes.length`, sidebar `+a −d` =
  `status.lines`, and the map reloaded for that revision.
- Existing `tests/repo-map/repo-map.mjs` assertions replaced (listed old-vs-new in the PR description, OQ3):
  - "two real idle polls leave map, counts and reader visually unchanged" (`idleMapPolls >= 2` on
    `repo-snapshot`): new form wraps `repo-map.statFile` and asserts ≥ 2 calls in the 11 s window with a file open,
    **zero** `repo-map.repoSnapshot` calls, and the same zero-mutation check. Stricter.
  - "automatic snapshot is held without visible loading churn before workspace switch" waits for a poll-driven
    snapshot: new form triggers the automatic snapshot with an on-disk edit that changes counts (revision bump),
    then holds it with the same gate and keeps every assertion.
  - "polling refreshes contents after edits", "polling updates actual line counts", "silent polling still detects
    same-line edits" keep their assertions unchanged; they now pass via revision reload and the open-file check.

## Risks & rollback

- The selected workspace runs `git status` + line counts every 5 s even with Repo Map hidden (today only while the
  map is mounted, and the snapshot is heavier). Bounded by the existing `concurrency = 3` limiter.
- A content edit to a file that is not open and does not change status is not reflected in the map until the next
  revision; its sizes and counts would be unchanged anyway.
- Rollback: revert the commit (no data changes).

## Decisions

- **One poller (OQ8):** `GitStateService` polls the selected workspace every 5 s; others use the watcher + 60 s poll.
- **Repo Map reloads on revision bump** and has no poll of its own.
- **Open file:** cheap 5 s renderer check via `statFile` (exists, size, mtime) for the open file only; a changed
  stamp re-runs `inspectFile`.
- **Test replacements (OQ3):** the two `repo-map.mjs` checks above, listed in the PR description, each at least as strict.
