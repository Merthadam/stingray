# Step 7 — Audit fixes

Status: draft · Umbrella: [modular restructure](2026-11-23-modular-restructure-design.md)

## Goal

Fix the remaining audit findings, each with a test where it can be tested.

## Non-goals

- Findings 1, 2, 8 (step 1), 7 and 19 (step 3), 12 (step 6), 17 (step 2).
- No refactors beyond what each fix needs.

Paths below are today's paths; after step 4 they live in the feature folders listed in the step 4 table.
Line numbers are today's `origin/main`.

---

## Finding 3 — Removal consent race

**Current.** `GitService.removeWorkspace` (`electron/git.ts:163-197`) re-runs `removalReview` (:174) and checks only
`blockers`, "dirty needs discard" (:176-177) and "deleteBranch needs merged" (:178). Consent is
`{ discard, deleteBranch }` (`src/shared.ts:72`). If new changes appear between the dialog's review and the click,
`discard: true` removes them with `--force` (:183); the user never saw them. The review sends only 20 paths
(:160).

**Design.**
- `RemovalReview` gains `fingerprint: string` = sha256 hex of JSON of: `branch`, sorted full change list
  (`status` + `path` + `originalPath`, all entries, not the capped 20), `blockers`, `push`, `merged`.
  Terminal count is excluded (removal closes terminals anyway).
- `removalConsentSchema` gains `fingerprint: z.string().regex(/^[0-9a-f]{64}$/)`.
- In `removeWorkspace`, after the fresh review: if `review.fingerprint !== consent.fingerprint`, refuse without
  touching anything and return `{ stale: review }`. `RemovalResult` becomes
  `{ state; warning? } | { stale: RemovalReview }`.
- `src/RemoveWorktreeForm.tsx:36`: send `review.fingerprint`; on `stale`, replace the review with `result.stale`,
  reset the discard/deleteBranch checkboxes, and show "New changes appeared since you reviewed. Review again."
  (a result instead of an error string avoids parsing `Error invoking remote method` prefixes).

**Tests.** `tests/git/git.test.ts`: review a worktree, create a new untracked file, call `removeWorkspace` with the
old fingerprint and `discard: true` → result is `stale`, worktree and new file still exist; with the fresh
fingerprint → removed. `tests/git/worktree-removal.mjs`: dialog open, file added on disk, click Remove → message
shown, review lists the new file, folder still exists.

## Finding 4 — Long Claude turns go `unknown` after 5 min

**Current.** `ActivityService.hookEvent` (`electron/activity.ts:147-170`): `if (e.resume && entry?.phase !== 'waiting') return;`
(:155) returns before `entry.seen = Date.now()` (:162). Claude's `PostToolUse` is sent as `resume`
(`agents/hook-client.ts:24`), so during a long Working turn only resume events arrive, `seen` stays old, and
`checkProcesses` (:132) turns Working into `unknown` after `hookWorkingMs` = 15 × 20 s = 5 min (:45).

**Design.** Before the resume early-return, when the entry exists and is `working` and `e.at >= entry.at`, refresh
`entry.seen` (and `entry.pid`, `entry.at`); then return as today. No phase change, no publish.

**Tests.** `tests/activity/activity.test.ts`: with a small `hookWorkingMs`, send a Working event, then `resume`
events more often than `hookWorkingMs` for longer than `hookWorkingMs` → phase stays `working`; stop sending →
becomes `unknown`.

## Finding 5 — CodeGraph respawn bypasses backoff and crash limit

**Current.** `electron/codegraph-process.ts:204`: `open()` does `if (child) post(...) else respawn();`. After a crash
`exited` (:160-169) schedules a backoff restart (1 s, 2 s, 4 s) and stops after 3 quick crashes, but any `open()`
respawns at once. `ViewService.worktree` calls `host.open` on every view computation
(`electron/views/service.ts:121-125`), so automatic recomputes defeat both the backoff and the limit. The header
comment (:4-5) and an existing test (`tests/codegraph-process.test.ts:78-82`, "An open() right after a crash
respawns immediately") describe today's behaviour as intended.

**Design.**
- `open()` with no child: if a restart timer is pending, do nothing (the timer will respawn and reopen all active
  graphs). If `crashes > 3` and the last crash was less than 30 s ago, do nothing (graphs stay `unavailable` with
  "reopen the view to retry"). Otherwise respawn.
- After 30 s since the last crash, the next `open()` respawns and the crash count restarts at that point (the
  existing `Date.now() - startedAt < 30_000` rule already resets it).
- Update the header comment to match.

**Tests.** `tests/codegraph/codegraph-process.test.ts` with a fake spawn and fake clock: crash → `open()` during
backoff does not spawn; the timer spawns once. Three quick crashes → `open()` within 30 s does not spawn; after
30 s it does. The existing assertion at :78-82 changes from "respawns immediately" to "respawns when the backoff
timer fires" (see open questions).

## Finding 6 — `core.fsmonitor=false` everywhere

**Current.** Git runners each spell their own `-c core.hooksPath=/dev/null` (none set fsmonitor):
`electron/git.ts:18`, `git-lines.ts:8`, `git-exclude.ts:14`, `repo-map.ts:17`, `:73` (show-ref, no hooksPath
either), `:110`, `pull-requests.ts:12` runner via `:180` (and `:110,113`, removed in step 2), `codegraph-overlay.ts:21`,
`clone.ts:10-14`, `views-cli.ts:64` (no `-c` at all). `git-state.ts` uses `git()` from git.ts. A repository's
`core.fsmonitor` can name a hook program that git would run.

**Design.** One constant in `electron/shared/git.ts`:
`export const GIT_SAFE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];` plus
`GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }`. Every runner above uses it (clone keeps its
extra `-c` flags after it). Done together with the shared runner of finding 16.

**Tests.** `tests/shared/git.test.ts`: in a temp repo with `core.fsmonitor` set to a script that writes a marker
file, run `status` through the shared runner → marker absent. A source scan test: no `'git'` spawn/execFile in
`electron/` outside `electron/shared/git.ts` (and `clone.ts`, which must include `GIT_SAFE_CONFIG`).

## Finding 9 — Terminal output flow control

**Current.** `electron/terminals.ts:44-47`: every PTY chunk is written to the headless mirror and sent to the
renderer with no back-pressure; a fast producer (`yes`, big `cat`) can grow the mirror's write queue and the IPC
queue without bound. `TerminalMirror.write` (`electron/terminal-mirror.ts:36`) calls xterm `write`, which can throw
(e.g. parser errors), inside the PTY data callback.

**Design.**
- Per entry, count bytes queued in the mirror: add `data.length` before `mirror.write`, subtract in the write
  callback. Above `HIGH = 1 MiB` call `process.pause()`; when it drops below `LOW = 256 KiB` call
  `process.resume()`. `TerminalMirror.write` gains an optional `done` callback (called from xterm's callback).
- Wrap the body of `TerminalMirror.write` in try/catch; on error, log once per terminal and keep the stream
  running (the chunk is still sent to the renderer).
- Close/exit: resume is not needed after kill; the counter is dropped with the entry.

**Tests.** `tests/terminals/terminals.test.ts` (with an injected fake PTY, see finding 15): emit 2 MiB quickly →
`pause` called once; let the mirror drain → `resume` called. A mirror whose `write` throws does not stop later
data events being sent.

## Finding 10 — Tree-sitter parsing off the main process

**Current.** `electron/codegraph-process.ts:1-3`: V8 must compile tree-sitter grammar wasm with `--liftoff-only` or
it may abort the whole process; the flag only works on the command line, so CodeGraph runs in a forked child. But
`extractDbSchema` (`electron/db-schema.ts:177`, loads the Python grammar and parses on the main thread; see the
`shortcut:` comment at :212) and `extractSqlSchema` (`electron/sql-schema.ts:40`, uses `views/rules/grammars`)
run in the Electron main process via `ViewService.schema/sqlSchema` (`electron/views/service.ts:101-117`).

**Design.**
- Two new worker calls in `codegraph-process.ts` (`Call` union, :18-21): `{ type: 'dbSchema'; workspaceId; root; grammarPath }`
  and `{ type: 'sqlSchema'; workspaceId; root }`, served in `codegraph.ts` `serveCodeGraph` by calling the existing
  extractors. Timeout: `evaluateTimeoutMs`.
- `CodeGraphProcessHost` gains `dbSchema(...)`/`sqlSchema(...)`; `ViewService` calls them instead of importing the
  extractors. Child down or timeout → the same error shape the extractor gives for an unreadable root (a warning,
  no tables), and the existing "drop cache when graph unavailable" logic retries later.
- `views-cli` keeps calling the extractors in its own process (unchanged).
- Remove the `shortcut:` comment in db-schema.ts.

**Tests.** `tests/codegraph/codegraph-process.test.ts`: a `ViewService` over the real worker computes the Database
view for a fixture with one SQLAlchemy model and one `.sql` file; with the child killed, the call resolves to an
empty result with a warning, not a rejection.

## Finding 11 — Engine lists files when no rule needs them

**Current.** `electron/views/rules/engine.ts:206`: `files.list(...)` walks the whole scope (up to 200 000 entries,
`rules/files.ts:8`) even when `byLanguage` is empty, then `:210` skips the loop.

**Design.** Guard the listing: `const listed = byLanguage.size ? await files.list(...) : { files: [], truncated: false };`.

**Tests.** `tests/views/rules-engine.test.ts`: a view with only graph steps and a file provider whose `list` throws →
evaluation succeeds; `list` not called.

## Finding 13 — Flow diagram persists layout without user action

**Current.** `src/views-ui/FlowDiagram.tsx:43`: `useEffect(() => { if (ready) stateCallback.current(state); }, [state, ready])`
saves positions as soon as the automatic layout finishes and on every new result, so opening a view writes view
state and freezes the first auto-layout. `ErDiagram.tsx:65-69` skips its first state emission (`firstState`).
(Audit said ~41; the effect is at :43.)

**Design.** A `userMoved` ref, set by `onNodesChange` (`:100`) on a position change with `dragging === false`
(drag end) and by the Re-layout button (`:119`). The effect saves only when `ready && userMoved.current`.
After Re-layout, the new positions are saved once layout finishes.

**Tests.** `tests/views/views-tab.mjs`: wrap the `views.saveViewState` IPC handler with a counter (same technique as
`repo-map.mjs`'s gate); open "Agent flow", wait for cards → counter 0; drag a card → counter ≥ 1; Re-layout →
counter increases after layout.

## Finding 14 — `pi-activity` not in the e2e runner

**Current.** `scripts/run-e2e.mjs:12` lists 8 suites; `tests/pi-activity.mjs` (native Pi activity UI) is not one, so
`npm run test:e2e` and CI never run it. `tests/verify-activity.mjs:36` runs it only as `pi-native`.

**Design.** Add `'pi-activity'` to the suite list (after step 4: `'pi-activity': 'activity'`). macOS CI runs it via
`npm run test:e2e`. Linux CI: add it to the non-blocking step in `ci.yml` first (it spawns zsh PTYs, like the
unit tests that needed Docker); move to required once green. Update `docs/ci.md`.

**Tests.** `node scripts/run-e2e.mjs --list` includes it; `npm run test:e2e -- pi-activity` passes.

## Finding 15 — No unit tests for the `Terminals` lifecycle

**Current.** No `tests/*terminals*.test.ts`; only the mirror and links are unit-tested. `electron/terminals.ts`
behaviour: limit 24 (:28), title (:42), exit handling (:48), write after exit throws (:52), snapshot (:59-63),
close kills and disposes (:64).

**Design.** `Terminals` takes an optional `spawn` (default `pty.spawn`) as a fourth constructor argument so tests
use a fake PTY (`onData`, `onExit`, `write`, `resize`, `kill`, `pause`, `resume`). No other change.

**Tests.** `tests/terminals/terminals.test.ts`:
- close before exit: `close()` kills, removes from `list()`, a later fake `exit` does not throw or re-add, and
  sends no data events for that id afterwards;
- exit then snapshot: after `exit(3)`, `snapshot()` resolves with the written data and `exitCode: 3`;
- write after exit throws "This terminal has exited. Open a new one.";
- the 25th `create` throws "Close a terminal before opening another (limit 24).";
- titles stay unique after closing one (see small fixes).

## Finding 16 — One file walker, one git runner

**Current.** Three hand-written walkers: `electron/db-schema.ts:184-210` (stack, skips dot-dirs and its
`SKIP_DIRS`, `MAX_ENTRIES`, warns on unreadable dirs, throws if root unreadable, files in descending name order),
`electron/sql-schema.ts:44-59` (same algorithm, own `SKIP_DIRS`, file filter), `electron/views/rules/files.ts:19-37`
(recursive, ascending, skips `SKIPPED_DIRS` incl. `.git` but not other dot-dirs, `MAX_WALKED`/`MAX_FILES`, silent on
errors). Git runners: see finding 6.

**Design.**
- `electron/shared/walk.ts`: `walkFiles(root, { skipDir(name, rel), keep(rel), maxEntries, maxFiles, onDirError })`
  → `{ files, truncated }`, never follows symlinks (Dirent types), one fixed traversal order (ascending, depth
  first, like `files.ts`). Each caller passes its current skip rules and limits, so the set of scanned files is the
  same; only db-schema/sql-schema visit order changes.
- `electron/shared/git.ts`: `runGit(cwd, args, { timeout, maxBuffer, encoding })` using `GIT_SAFE_CONFIG` and
  `GIT_ENV`. Callers keep their own timeouts, buffer limits and error wrapping (`git()` keeps its fixed message,
  `inventoryGit` its grep exit-1 rule, `boundedGit` its buffer encoding). `PRRunner` for `git` delegates to it.

**Tests.** `tests/shared/walk.test.ts`: symlinked file and dir skipped, skip rules applied, limits set `truncated`,
unreadable subdir reported via `onDirError`. Existing db-schema, sql-schema and rule-files tests pass; if any
asserts order and fails only on order, sort the output rather than the walk (note it in the PR).

## Finding 18 — README

**Current.** `README.md` (253 lines) mixes delivery history ("Pi activity (source and verified candidate)",
"Repo Map: idle-refresh fix verification", …) with setup; its "Structure" section (:234-253) names files that
no longer exist (`usePullRequest.ts`, `useSidebarGit.ts`, `workspace-read-queue.ts`). `TREEMAP-PLAN.md` is an old
plan at the root. Several specs in `docs/` say "Status: draft (design agreed, not implemented)" although the code
exists (`docs/flowchart-view-spec.md` → `electron/views/flowchart/`, `docs/explain-fingerprints-spec.md` →
`electron/views/explain.ts`; `docs/sequence-view-spec.md` → `electron/views/sequence/`).

**Design.**
- README sections: Overview (5 lines), Setup, Run (`npm run dev`, dev data dir, `npm start`, Docker env), Test
  (`npm run check`, `npm run test:e2e`, suite list, Docker), Build/package, Folder map (from the umbrella), Links
  (`STATUS.md`, `docs/ci.md`, `docs/specs/`, run-local skill).
- History sections move verbatim to the top of `STATUS.md` under "Earlier delivery notes (from README)".
- `git mv TREEMAP-PLAN.md docs/archive/TREEMAP-PLAN.md`.
- For each `docs/*-spec.md`/`*-plan.md`, check the code exists; if so set `Status: implemented` (one line edit).
  The eight files in `docs/specs/` get `Status: implemented` at the end of the PR.

**Tests.** None (docs). Review: every command in README runs.

## Finding 20 — Webview storage survives workspace removal

**Current.** `src/BrowserPane.tsx:33` gives each workspace a persistent partition `persist:stingray-<id>`;
`electron/main.ts:108-115` locks it down. Nothing clears it when the workspace is removed (grep for
`clearStorageData`/`clearCache` in `electron/` finds nothing), so cookies and cache of removed worktrees stay in
the data dir forever.

**Design.** `WorkspaceRemoval` (step 5) gains an injected `clearWorkspaceSession(id)`; `window.ts` implements it as
`session.fromPartition('persist:stingray-' + id)` → `clearStorageData()` then `clearCache()`, errors logged and
ignored. Called only after a successful removal, after the existing cleanups. `lockedSessions` entry for that
partition is dropped.

**Tests.** `tests/git/workspace-removal.test.ts`: called once after success, not on failure, a rejection does not
fail the removal.

---

## Small fixes

| Fix | Current | Design | Test |
|---|---|---|---|
| Terminal titles | `electron/terminals.ts:42` `'Terminal ' + (entries.size + 1)` repeats a title after a close | monotonic counter field `created`, title `'Terminal ' + ++this.created` | in `terminals.test.ts` |
| One terminal-event dispatcher | each `TerminalPane` (`src/TerminalPane.tsx:123`) and `App.tsx:103` add their own `api.onTerminal` listener | `src/features/terminals/terminal-events.ts`: one `api.onTerminal` subscription, listeners by terminal id plus "all"; panes and App subscribe through it | unit test: two subscribers for different ids get only their events; unsubscribing the last removes the IPC listener |
| CDP call timeout | `electron/live-view.ts:115-118` `call()` waits forever for a reply | 10 s timer rejects "The live view did not respond." and deletes the pending entry | `tests/runtime/live-view.test.ts`: fake socket that never replies → rejects after the (injected short) timeout |
| CI double typecheck | `.github/workflows/ci.yml:37` `npm run typecheck`, then `:38` `npm run build`, which runs `tsc --noEmit` again (`package.json:13`) | drop `:37` | CI run |
| `@types/prismjs` | in `dependencies` (`package.json:34`) | move to `devDependencies` (`npm install -D @types/prismjs@^1.26.6`, lockfile updated) | `npm run check`; `npm run package:mac` still builds |
| `VIEW_KINDS` | type `src/views.ts:6` and array `electron/views/rules/schema.ts:11` (`KINDS`) are separate lists | `export const VIEW_KINDS = [...] as const; export type ViewKind = typeof VIEW_KINDS[number];` in the views renderer module; `schema.ts` imports it | `tsc` (one list) |
| CodeGraph overlays left behind | overlays at `<userData>/codegraph/<repoId>/overlays/<workspaceId>.db` (`electron/codegraph-overlay.ts:29`) are never deleted on removal | `removeOverlay(dataDir, repoId, workspaceId)` (db, `-wal`, `-shm`) called by `WorkspaceRemoval` after success; repoId captured before removal; runs whether or not shared base is on | `tests/codegraph/codegraph-overlay.test.ts` + `workspace-removal.test.ts` |
| Git error detail | `electron/git.ts:23-25` replaces every failure with one fixed message | append the first non-empty stderr line (control chars stripped, `://user:pass@` redacted, max 200 chars): `Git operation failed: <line>. Check …` | `tests/git/git.test.ts`: failing `worktree add` message contains git's reason |
| Branch exists | `createWorkspace` (`git.ts:105-125`) lets `worktree add -b` fail generically | before `worktree add`: `rev-parse --verify --quiet refs/heads/<branch>` succeeds → "Branch <name> already exists. Choose another name." | `git.test.ts` |
| Status buffer | `git()` has `maxBuffer: 4 MiB` (`git.ts:19`); `status --untracked-files=all` (:202) can exceed it in big repos | pass `maxBuffer: 16 MiB` (same as `inventoryGit`, `repo-map.ts:18`) for the status call | `git.test.ts`: status with > 4 MiB output (many long untracked names) succeeds |

## Acceptance criteria

- [ ] Each finding above implemented as designed.
- [ ] New tests listed above exist and pass; `npm run check` passes.
- [ ] `npm run test:e2e` passes, including `pi-activity`.
- [ ] `grep -rn "core.hooksPath" electron` shows only `electron/shared/git.ts`.

## Verification

```
npm run check
npm run test:e2e
scripts/test-env.sh test unit e2e desktop repo-map pull-requests worktree-removal add-project views-tab
```

plus the umbrella Docker smoke.

## Risks & rollback

- Finding 3 adds a field to the consent schema: an old renderer (not possible in one app build) would be refused.
- Finding 9 thresholds are guesses; too low slows fast output slightly. Easy to tune.
- Finding 10 changes where parsing runs; a worker crash now yields an empty Database view with a warning instead of
  crashing the app. Intended.
- Finding 16 changes db-schema/sql-schema visit order; results could differ in order or, when truncated, in which
  files are scanned.
- Each fix is small and local; revert per hunk if one misbehaves.

## Open questions

- **Finding 5 vs existing test.** `tests/codegraph-process.test.ts:78-82` asserts that `open()` right after a crash
  respawns immediately, and the header comment calls that intended. The agreed fix reverses it, so that assertion
  must change. Confirm.
- **Finding 3 fingerprint scope.** Excludes terminal count; includes push status. Step 2 deletes the upstream
  `identity`; if the upstream tip should be in the fingerprint, keep it (see step 2).
- **Finding 14 on Linux CI.** Required or non-blocking at first? This spec says non-blocking until it passes there.
- **Finding 16 order.** Is a changed scan order for db/sql schema acceptable, or must the walker support both orders?
