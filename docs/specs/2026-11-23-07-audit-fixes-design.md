# Step 7 — Audit fixes

Status: implemented · Commit 8 (+ fixes inside commits 5, 6, 10) · Umbrella: [modular restructure](2026-11-23-modular-restructure-design.md)

## Goal

Fix the remaining audit findings, each with a test where it can be tested. Fixes that belong to one feature land in
that feature's extraction commit ([step 4](2026-11-23-04-hexagonal-modules-design.md#commit-5--per-feature-extraction));
the rest land in commit 8.

## Non-goals

- Findings 1, 2, 8 (step 1), 7 and 19 (step 3), 12 (step 6), 17 (step 2).
- No refactors beyond what each fix needs.

"Current" paths and line numbers are today's `origin/main`; "Design" paths are the final hex layout.

## Where each fix lands

| Fix | Commit |
|---|---|
| 3 removal consent race, 6 one git runner + `core.fsmonitor=false`, git error detail, branch exists, status buffer | 5 · git |
| 4 long Claude turns | 5 · activity |
| 9 terminal flow control, 15 `Terminals` tests, terminal titles | 5 · terminals |
| 5 CodeGraph respawn, overlays removed on workspace removal | 5 · stinggraph |
| 11 engine listing guard, 16 one walker (created) | 5 · views |
| 10 tree-sitter parsing in the worker, 16 (db/sql switched to the walker) | 5 · db-schema |
| CDP call timeout | 5 · runtime |
| 20 webview storage cleared on removal | 6 · composition root |
| `VIEW_KINDS` single list | 3 · contracts (`shared/contracts/views.ts`) |
| 13 flow diagram persistence, 14 `pi-activity` in runner/CI, one terminal-event dispatcher, CI double typecheck, `@types/prismjs` | 8 |
| 18 README / STATUS / archive | 10 · docs |

---

## Finding 3 — Removal consent race

**Current.** `GitService.removeWorkspace` (`electron/git.ts:163-197`) re-runs `removalReview` (:174) and checks only
`blockers`, "dirty needs discard" (:176-177) and "deleteBranch needs merged" (:178). Consent is
`{ discard, deleteBranch }` (`src/shared.ts:72`). If new changes appear between the dialog's review and the click,
`discard: true` removes them with `--force` (:183); the user never saw them. The review sends only 20 paths (:160).
`reviewPushStatus` (`electron/worktree-removal.ts:4-17`) also returns `identity` (upstream ref + tip), unused today.

**Design** (`electron/core/git/git.ts`, `worktree-removal.ts`).
- `RemovalReview` gains `fingerprint: string` = sha256 hex (via the `Hasher` port) of JSON of: `branch`, sorted full
  change list (`status` + `path` + `originalPath`, all entries, not the capped 20), `blockers`, `push`, `merged`,
  and `identity` (upstream ref + tip). A pushed or fetched upstream therefore invalidates consent. Terminal count is
  excluded (removal closes terminals anyway).
- `removalConsentSchema` (`shared/contracts/git.ts`) gains `fingerprint: z.string().regex(/^[0-9a-f]{64}$/)`.
- After the fresh review: if `review.fingerprint !== consent.fingerprint`, refuse without touching anything and
  return `{ stale: review }`. `RemovalResult` becomes `{ state; warning? } | { stale: RemovalReview }`.
- `src/features/git/RemoveWorktreeForm.tsx`: send `review.fingerprint`; on `stale`, the dialog reloads with
  `result.stale` (new change list, push status), resets the discard/deleteBranch checkboxes, and shows
  "New changes appeared since you reviewed. Review again." The user must confirm again.

**Tests.** `tests/git/git.core.test.ts` (fake runner): fingerprint changes when a change, the push status or the
upstream tip changes; stale consent removes nothing. `tests/git/git.test.ts` (new case, real git): review, create an
untracked file, `removeWorkspace` with the old fingerprint and `discard: true` → `stale`, worktree and file still
exist; fresh fingerprint → removed. `tests/git/worktree-removal.mjs` (new check): dialog open, file added on disk,
click Remove → message shown, review lists the new file, folder still exists.

## Finding 4 — Long Claude turns go `unknown` after 5 min

**Current.** `ActivityService.hookEvent` (`electron/activity.ts:147-170`): `if (e.resume && entry?.phase !== 'waiting') return;`
(:155) returns before `entry.seen = Date.now()` (:162). Claude's `PostToolUse` is sent as `resume`
(`agents/hook-client.ts:24`), so during a long Working turn only resume events arrive, `seen` stays old, and
`checkProcesses` (:132) turns Working into `unknown` after `hookWorkingMs` = 15 × 20 s = 5 min (:45).

**Design** (`electron/core/activity/activity.ts`). Before the resume early-return, when the entry exists and is `working` and `e.at >= entry.at`, refresh
`entry.seen` (and `entry.pid`, `entry.at`); then return as today. No phase change, no publish.

**Tests.** `tests/activity/activity.core.test.ts` (fake clock) and a new case in `tests/activity/activity.test.ts`: with a small `hookWorkingMs`, send a Working event, then `resume`
events more often than `hookWorkingMs` for longer than `hookWorkingMs` → phase stays `working`; stop sending →
becomes `unknown`.

## Finding 5 — CodeGraph respawn bypasses backoff and crash limit

**Current.** `electron/codegraph-process.ts:204`: `open()` does `if (child) post(...) else respawn();`. After a crash
`exited` (:160-169) schedules a backoff restart (1 s, 2 s, 4 s) and stops after 3 quick crashes, but any `open()`
respawns at once. `ViewService.worktree` calls `host.open` on every view computation
(`electron/views/service.ts:121-125`), so automatic recomputes defeat both the backoff and the limit. The header
comment (:4-5) and an existing test (`tests/codegraph-process.test.ts:78-82`, "An open() right after a crash
respawns immediately") describe today's behaviour as intended.

**Design.** The decision moves into `electron/core/stinggraph/restart-policy.ts` (pure, fake clock), used by
`electron/adapters/driven/stinggraph-worker/stinggraph-process.ts`:
- `open()` with no child: if a restart timer is pending, do nothing (the timer respawns and reopens all active
  graphs). If `crashes > 3` and the last crash was less than 30 s ago, do nothing (graphs stay `unavailable` with
  "reopen the view to retry"). Otherwise respawn.
- After 30 s since the last crash, the next `open()` respawns and the crash count restarts there (the existing
  `Date.now() - startedAt < 30_000` rule).
- Update the header comment to match.

**Tests.** `tests/stinggraph/restart-policy.test.ts` (fake clock): backoff 1/2/4 s, limit after 3 quick crashes,
reset after 30 s. `tests/stinggraph/stinggraph-process.test.ts` (today `tests/codegraph-process.test.ts`) with a fake spawn: crash → `open()` during backoff does
not spawn; the timer spawns once; three quick crashes → `open()` within 30 s does not spawn, after 30 s it does.
Assertion replacement (listed in the PR description, OQ3): the existing check at `:78-82` "An open() right after a
crash respawns immediately" becomes "an open() right after a crash does not spawn; the backoff timer respawns once
and the graph reopens". Same fake, same events, plus a spawn-count assertion, so it is stricter.

## Finding 6 — `core.fsmonitor=false` everywhere

**Current.** Git runners each spell their own `-c core.hooksPath=/dev/null` (none set fsmonitor):
`electron/git.ts:18`, `git-lines.ts:8`, `git-exclude.ts:14`, `repo-map.ts:17`, `:73` (show-ref, no hooksPath
either), `:110`, `pull-requests.ts:12` runner via `:180` (and `:110,113`, removed in step 2), `codegraph-overlay.ts:21`,
`clone.ts:10-14`, `views-cli.ts:64` (no `-c` at all). `git-state.ts` uses `git()` from git.ts. A repository's
`core.fsmonitor` can name a hook program that git would run.

**Design.** One runner, `electron/adapters/driven/git/runner.ts`:
`export const GIT_SAFE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];`,
`GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }`, and
`runGit(cwd, args, { timeout, maxBuffer, encoding, env })`. In the git extraction commit every git spawn listed
above switches to it (clone keeps its extra `-c` flags after `GIT_SAFE_CONFIG`; `views-cli` gains the flags it never
had). Callers keep their own timeouts, buffer limits and error wrapping (`git()` its message, `inventoryGit` its
grep exit-1 rule, `boundedGit` its encoding); the default `PRRunner` delegates to it for `git`. Later feature
commits move the call sites into their adapters but keep using this runner. The stinggraph overlay receives it by
injection from `electron/app/stinggraph-worker.ts`.

**Tests.** `tests/git/runner.test.ts`: in a temp repo with `core.fsmonitor` set to a script that writes a marker
file, `runGit(['status'])` → marker absent; same for `core.hooksPath` hooks. Source scan in the same file: no
`execFile`/`spawn` of `'git'` under `electron/` outside `electron/adapters/driven/git/`.

## Finding 9 — Terminal output flow control

**Current.** `electron/terminals.ts:44-47`: every PTY chunk is written to the headless mirror and sent to the
renderer with no back-pressure; a fast producer (`yes`, big `cat`) can grow the mirror's write queue and the IPC
queue without bound. `TerminalMirror.write` (`electron/terminal-mirror.ts:36`) calls xterm `write`, which can throw
(e.g. parser errors), inside the PTY data callback.

**Design** (`electron/core/terminals/terminals.ts`; `PtySpawner` port gains `pause()`/`resume()`, `MirrorFactory`
port's `write(data, done)`).
- Per entry, count bytes queued in the mirror: add `data.length` before `mirror.write`, subtract in the write
  callback. Above `HIGH = 1 MiB` call `process.pause()`; when it drops below `LOW = 256 KiB` call
  `process.resume()`. `TerminalMirror.write` gains an optional `done` callback (called from xterm's callback).
- Wrap the body of `TerminalMirror.write` in try/catch; on error, log once per terminal and keep the stream
  running (the chunk is still sent to the renderer). Lives in `electron/adapters/driven/pty/terminal-mirror.ts`.
- Close/exit: resume is not needed after kill; the counter is dropped with the entry.

**Tests.** `tests/terminals/terminals.test.ts` (fake PTY and fake mirror from `tests/fakes/terminals.ts`): emit 2 MiB quickly →
`pause` called once; let the mirror drain → `resume` called. A mirror whose `write` throws does not stop later
data events being sent.

## Finding 10 — Tree-sitter parsing off the main process

**Current.** `electron/codegraph-process.ts:1-3`: V8 must compile tree-sitter grammar wasm with `--liftoff-only` or
it may abort the whole process; the flag only works on the command line, so CodeGraph runs in a forked child. But
`extractDbSchema` (`electron/db-schema.ts:177`, loads the Python grammar and parses on the main thread; see the
`shortcut:` comment at :212) and `extractSqlSchema` (`electron/sql-schema.ts:40`, uses `views/rules/grammars`)
run in the Electron main process via `ViewService.schema/sqlSchema` (`electron/views/service.ts:101-117`).

**Design** (db-schema extraction commit; failure-isolation rule 4).
- `core/db-schema` extracts from syntax trees it gets through the `SyntaxParser` port and file lists through the
  walker port; it does no parsing itself.
- Two new worker calls in `driven/stinggraph-worker/stinggraph-process.ts` (`Call` union, :18-21 today):
  `{ type: 'dbSchema'; workspaceId; root; grammarPath }` and `{ type: 'sqlSchema'; workspaceId; root }`. The
  worker (`electron/app/stinggraph-worker.ts`) wires `core/db-schema` with `driven/tree-sitter` + `driven/fs/walk.ts`
  and serves them. Timeout: `evaluateTimeoutMs`.
- `ViewService` (`core/views/service.ts`) gets a `DbSchemaSource` port instead of importing the extractors; the
  composition root implements it with the worker host. Child down or timeout → the result an unreadable root gives
  (a warning, no tables), and the existing "drop cache when graph unavailable" logic retries later.
- `views-cli` and existing tests keep calling `extractDbSchema`/`extractSqlSchema` in-process through
  `electron/app/wiring/db-schema.ts`.
- Remove the `shortcut:` comment in db-schema.ts.

**Tests.** `tests/db-schema/db-schema-worker.test.ts`: a `ViewService` over the real worker computes the Database view
for a fixture with one SQLAlchemy model and one `.sql` file; with the child killed mid-call, the call resolves to an
empty result with a warning, not a rejection, and a fake-git main-process service still answers (rule 4).

## Finding 11 — Engine lists files when no rule needs them

**Current.** `electron/views/rules/engine.ts:206`: `files.list(...)` walks the whole scope (up to 200 000 entries,
`rules/files.ts:8`) even when `byLanguage` is empty, then `:210` skips the loop.

**Design** (`electron/core/views/rules/engine.ts`). Guard the listing: `const listed = byLanguage.size ? await files.list(...) : { files: [], truncated: false };`.

**Tests.** New case in `tests/views/rules-engine.test.ts`: a view with only graph steps and a file provider whose `list` throws →
evaluation succeeds; `list` not called.

## Finding 13 — Flow diagram persists layout without user action

**Current.** `src/views-ui/FlowDiagram.tsx:43` (→ `src/features/views/views-ui/FlowDiagram.tsx`): `useEffect(() => { if (ready) stateCallback.current(state); }, [state, ready])`
saves positions as soon as the automatic layout finishes and on every new result, so opening a view writes view
state and freezes the first auto-layout. `ErDiagram.tsx:65-69` skips its first state emission (`firstState`).
(Audit said ~41; the effect is at :43.)

**Design.** A `userMoved` ref, set by `onNodesChange` (`:100`) on a position change with `dragging === false`
(drag end) and by the Re-layout button (`:119`). The effect saves only when `ready && userMoved.current`.
After Re-layout, the new positions are saved once layout finishes.

**Tests.** New check in `tests/views/views-tab.mjs`: wrap the `views.saveViewState` IPC handler with a counter (same technique as
`repo-map.mjs`'s gate); open "Agent flow", wait for cards → counter 0; drag a card → counter ≥ 1; Re-layout →
counter increases after layout.

## Finding 14 — `pi-activity` not in the e2e runner

**Current.** `scripts/run-e2e.mjs:12` lists 8 suites; `tests/pi-activity.mjs` (native Pi activity UI) is not one, so
`npm run test:e2e` and CI never run it. `tests/verify-activity.mjs:36` runs it only as `pi-native`.

**Design.**
- `scripts/run-e2e.mjs`: add `'pi-activity': 'activity'` to the suite map, so `npm run test:e2e` (local, done bar)
  runs it.
- `.github/workflows/ci.yml`, non-blocking on both platforms:
  - macOS `e2e-macos`: the required step runs `npm run test:e2e -- <all suites except pi-activity>` (explicit list,
    like Linux); a new step `npm run test:e2e -- pi-activity` with `continue-on-error: true`.
  - Linux `e2e-linux`: add `pi-activity` to the existing non-blocking step
    (`scripts/test-env.sh test e2e terminal-links workspace-status pi-activity`).
- `docs/ci.md`: table and footnote say `pi-activity` runs non-blocking on macOS and Linux (it drives the native Pi
  activity UI over zsh PTYs, which the other PTY tests showed to be runner-sensitive). Moving it to required is a
  later, separate change.

**Tests.** `node scripts/run-e2e.mjs --list` includes it; `npm run test:e2e -- pi-activity` passes locally on macOS.

## Finding 15 — No unit tests for the `Terminals` lifecycle

**Current.** No `tests/*terminals*.test.ts`; only the mirror and links are unit-tested. `electron/terminals.ts`
behaviour: limit 24 (:28), title (:42), exit handling (:48), write after exit throws (:52), snapshot (:59-63),
close kills and disposes (:64).

**Design.** Falls out of the terminals extraction: `core/terminals/terminals.ts` takes a `PtySpawner` port
(`onData`, `onExit`, `write`, `resize`, `kill`, `pause`, `resume`); `tests/fakes/terminals.ts` provides the fake.
The wired `Terminals` (`electron/app/wiring/terminals.ts`) keeps today's constructor.

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
- `electron/adapters/driven/fs/walk.ts` (views extraction commit): `walkFiles(root, { keep(rel), skipDotDirs?, maxEntries? })`
  → `{ files, truncated }`, implementing the walker port used by views (`FileProvider.list`) and db-schema.
  - Skip set = union of today's lists: `.git`, `.codegraph`, `node_modules`, `dist`, `dist-electron`, `build`,
    `.venv`, `venv`, `__pycache__`, `.next`, `target`, `site-packages`, applied for every caller.
  - `skipDotDirs` (default `false`): also skip every directory whose name starts with `.`. Views keep the default
    (they already scan dot-dirs such as `.stingray/`); the db-schema and sql-schema scanners pass `true`, as their
    walks do today.
  - `maxEntries` (per-caller entry cap): default 200 000 (`MAX_WALKED`) for views; db-schema and sql-schema keep
    their 20 000 (`MAX_ENTRIES`). At most 5 000 kept files for parsing (`MAX_FILES` / `MAX_PY_FILES`) for every
    caller; either limit sets `truncated`.
  - Schema scanning therefore matches today (dot-dirs skipped, 20 000 entry cap, 5 000 parse cap). The union adds
    only two non-dot names to the db/sql skip lists: `target` (both) and `dist-electron` (db-schema).
  - Never follows symlinks (Dirent types). Results are sorted ascending by relative path for every caller.
  - Unreadable root throws (db/sql today); unreadable subdirectories are reported through `onDirError` (db/sql warn,
    views stay silent as today).
- `core/db-schema` (db-schema extraction commit) uses the same port; its own walk loops (`db-schema.ts:184-210`,
  `sql-schema.ts:44-59`) are deleted.
- Git runners: finding 6.

**Tests.** `tests/views/walk.test.ts`: symlinked file and dir skipped; every name in the skip set skipped at any
depth; dot-dirs not in the set walked by default and skipped with `skipDotDirs: true`; the default 200 000 cap, a
caller's `maxEntries: 20 000` and the 5 000 parse cap each set `truncated`; output sorted; unreadable subdir
reported via `onDirError`. Existing `db-schema`, `sql-schema` and `rule-files` tests pass unchanged.

## Finding 18 — README

**Current.** `README.md` (253 lines) mixes delivery history ("Pi activity (source and verified candidate)",
"Repo Map: idle-refresh fix verification", …) with setup; its "Structure" section (:234-253) names files that
no longer exist (`usePullRequest.ts`, `useSidebarGit.ts`, `workspace-read-queue.ts`). `TREEMAP-PLAN.md` is an old
plan at the root. Several specs in `docs/` say "Status: draft (design agreed, not implemented)" although the code
exists (`docs/flowchart-view-spec.md` → `electron/views/flowchart/`, `docs/explain-fingerprints-spec.md` →
`electron/views/explain.ts`; `docs/sequence-view-spec.md` → `electron/views/sequence/`).

**Design.**
- README sections: Overview (5 lines), Setup, Run (`npm run dev`, dev data dir, `npm start`, Docker env), Test
  (`npm run check`, `npm run test:e2e`, suite list incl. `pi-activity`, Docker), Build/package, Folder map (the
  umbrella's final tree, short form), Links (`STATUS.md`, `docs/ci.md`, `docs/specs/`, run-local skill).
- History sections move verbatim to the top of `STATUS.md` under "Earlier delivery notes (from README)".
- `git mv TREEMAP-PLAN.md docs/archive/TREEMAP-PLAN.md`.
- For each `docs/*-spec.md`/`*-plan.md`, check the code exists; if so set `Status: implemented` (one line edit).
  The eight files in `docs/specs/` get `Status: implemented` at the end of the PR.

**Tests.** None (docs). Review: every command in README runs.

## Finding 20 — Webview storage survives workspace removal

**Current.** `src/BrowserPane.tsx:33` (→ `src/features/runtime/BrowserPane.tsx`) gives each workspace a persistent partition `persist:stingray-<id>`;
`electron/main.ts:108-115` locks it down. Nothing clears it when the workspace is removed (grep for
`clearStorageData`/`clearCache` in `electron/` finds nothing), so cookies and cache of removed worktrees stay in
the data dir forever.

**Design** (composition root commit). `electron/adapters/driven/electron-shell/sessions.ts`
`clearWorkspaceSession(id)`: `session.fromPartition('persist:stingray-' + id)` → `clearStorageData()` then
`clearCache()`, and drops the partition from the locked-sessions set. `compose.ts` registers it as the last
`afterRemove` listener of `WorkspaceLifecycle`, so it runs only after a successful removal and its failure is logged
and ignored (rule 3).

**Tests.** `tests/git/workspace-lifecycle.test.ts` (fake listeners as registered by `compose.ts`): called once after
success, not on failure; a rejection does not fail the removal.

---

## Small fixes

| Fix | Current | Design | Test |
|---|---|---|---|
| Terminal titles | `electron/terminals.ts:42` `'Terminal ' + (entries.size + 1)` repeats a title after a close | monotonic counter field `created` in `core/terminals/terminals.ts`, title `'Terminal ' + ++this.created` | `tests/terminals/terminals.test.ts` |
| One terminal-event dispatcher | each `TerminalPane` (`src/TerminalPane.tsx:123`) and `App.tsx:103` add their own `api.onTerminal` listener | `src/features/terminals/terminal-events.ts` (exported from the feature `index.ts`): one `api.onTerminal` subscription, listeners by terminal id plus "all"; panes and App subscribe through it | `tests/terminals/terminal-events.test.ts`: two subscribers for different ids get only their events; unsubscribing the last removes the IPC listener |
| CDP call timeout | `electron/live-view.ts:115-118` `call()` waits forever for a reply | in `core/runtime/live-view.ts`: 10 s timer rejects "The live view did not respond." and deletes the pending entry | `tests/runtime/live-view.core.test.ts`: fake `CdpConnection` that never replies → rejects after the (injected short) timeout |
| CI double typecheck | `.github/workflows/ci.yml:37` `npm run typecheck`, then `:38` `npm run build`, which runs `tsc --noEmit` again (`package.json:13`) | drop `:37` | CI run |
| `@types/prismjs` | in `dependencies` (`package.json:34`) | move to `devDependencies` (`npm install -D @types/prismjs@^1.26.6`, lockfile updated) | `npm run check`; `npm run package:mac` still builds |
| `VIEW_KINDS` | type `src/views.ts:6` and array `electron/views/rules/schema.ts:11` (`KINDS`) are separate lists | `export const VIEW_KINDS = [...] as const; export type ViewKind = typeof VIEW_KINDS[number];` in `shared/contracts/views.ts`; `core/views/rules/schema.ts` imports it | `tsc` (one list) |
| CodeGraph overlays left behind | overlays at `<userData>/codegraph/<repoId>/overlays/<workspaceId>.db` (`electron/codegraph-overlay.ts:29`) are never deleted on removal | `removeOverlay(dataDir, repoId, workspaceId)` (db, `-wal`, `-shm`) in `driven/stinggraph-worker/stinggraph-overlay.ts`, registered as an `afterRemove` lifecycle listener; repoId captured in `beforeRemove`; runs whether or not shared base is on; on-disk path unchanged | `tests/stinggraph/stinggraph-overlay.test.ts` (new case) + `tests/git/workspace-lifecycle.test.ts` |
| Git error detail | `electron/git.ts:23-25` replaces every failure with one fixed message | in `driven/git/runner.ts` error wrapping: append the first non-empty stderr line (control chars stripped, `://user:pass@` redacted, max 200 chars): `Git operation failed: <line>. Check …` | `tests/git/git.test.ts` (new case): failing `worktree add` message contains git's reason |
| Branch exists | `createWorkspace` (`git.ts:105-125`) lets `worktree add -b` fail generically | in `core/git/git.ts` before `worktree add`: `rev-parse --verify --quiet refs/heads/<branch>` succeeds → "Branch <name> already exists. Choose another name." | `tests/git/git.core.test.ts` + new case in `git.test.ts` |
| Status buffer | `git()` has `maxBuffer: 4 MiB` (`git.ts:19`); `status --untracked-files=all` (:202) can exceed it in big repos | pass `maxBuffer: 16 MiB` (same as `inventoryGit`, `repo-map.ts:18`) for the status call | `tests/git/git.test.ts` (new case): status with > 4 MiB output (many long untracked names) succeeds |

## Acceptance criteria

- [ ] Each finding above implemented as designed.
- [ ] New tests listed above exist and pass; `npm run check` passes.
- [ ] `npm run test:e2e` passes, including `pi-activity`.
- [ ] `grep -rn "core.hooksPath" electron` shows only `electron/adapters/driven/git/runner.ts`.
- [ ] No existing assertion changed except finding 5's, listed old-vs-new in the PR description.

## Verification

```
npm run check
npm run test:e2e
npm run test:e2e -- pi-activity
scripts/test-env.sh test unit e2e desktop repo-map pull-requests worktree-removal add-project views-tab
```

plus the umbrella Docker smoke.

## Risks & rollback

- Finding 3 adds a field to the consent schema: an old renderer (not possible in one app build) would be refused.
- Finding 9 thresholds are guesses; too low slows fast output slightly. Easy to tune.
- Finding 10 changes where parsing runs; a worker crash now yields an empty Database view with a warning instead of
  crashing the app. Intended.
- Finding 16 keeps db-schema/sql-schema scope (dot-dirs skipped, 20 000 entry cap); left over: results are sorted
  ascending (today descending, which only affects warning/table order), and `target/` (plus `dist-electron/` for
  db-schema) is skipped via the union list. Existing tests pass unchanged.
- Each fix is small and local; revert per hunk if one misbehaves.

## Decisions

- **Placement:** feature fixes land in their extraction commit; the rest in commit 8; docs in commit 10 (table above).
- **Finding 3 (OQ4):** fingerprint includes the full change list, push status, merged flag, blockers and the
  upstream `identity` (ref + tip); terminal count excluded. Stale consent is refused with "New changes appeared
  since you reviewed. Review again." and the dialog reloads with the fresh review.
- **Finding 5 (OQ3):** the `codegraph-process.test.ts:78-82` assertion (`tests/stinggraph/stinggraph-process.test.ts`
  after commit 4) is replaced (old vs new in the PR
  description), at least as strict.
- **Finding 14 (OQ5):** `pi-activity` is in the e2e runner and in CI, non-blocking on macOS and Linux; documented
  in `docs/ci.md`.
- **Finding 16 (OQ6, refined):** one walker in `driven/fs/walk.ts` with options `skipDotDirs` and a per-caller
  entry cap. db-schema and sql-schema use `skipDotDirs: true` and keep their 20 000 cap; all other callers use the
  union skip list and the 200 000 limit; 5 000 parse cap; results always sorted. Schema scanning behaviour matches
  today; no behaviour-change note for schema dot-dirs or the 200 000 limit.
- **Naming:** design paths use the `stinggraph` feature name (umbrella decision); current paths and on-disk names
  (`<userData>/codegraph/`, `.codegraph`) are unchanged.
- **Finding 6:** one git runner in `driven/git/runner.ts` with `core.hooksPath=/dev/null` and `core.fsmonitor=false`.
