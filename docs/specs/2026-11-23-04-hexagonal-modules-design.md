# Step 4 — Hexagonal modules

Status: draft (decisions final) · Commits 4, 5 (× 8), 9 · Umbrella: [modular restructure](2026-11-23-modular-restructure-design.md)

## Goal

Every main-process file lives in one hexagonal layer, organised by feature; renderer files are organised by the same
features; core logic is unit-tested with fake adapters; strict tests keep it that way.

- Commit 4 moves files into the final layout without changing behaviour.
- Commit 5 is eight commits, one per feature (git, activity, terminals, stinggraph, repo-map, views, db-schema,
  runtime), that split mixed files into core + ports + driven adapters, add fake adapters and core unit tests, and
  carry the audit fixes that belong to the feature ([step 7](2026-11-23-07-audit-fixes-design.md#where-each-fix-lands)).
- Commit 9 adds the strict boundary and cycle tests (no allow-list).

## Non-goals

- No behaviour change in commits 4 and 9. In commit 5, behaviour changes only through the listed audit fixes and
  the failure-isolation rules below.
- No renames of exported symbols that existing tests import (see "Compatibility wiring").
- `agents/` stays top-level.

## Layers and rules

| Layer | Path | May import (runtime) | Never imports |
|---|---|---|---|
| core | `electron/core/<feature>/`, `electron/core/shared/` | own feature; other core features via `index.ts`; `electron/core/shared/`; `shared/`; packages `zod`, `yaml` | `node:*`, `electron`, any other package, `electron/adapters/`, `electron/app/`, `src/`, `agents/` |
| driving adapters | `electron/adapters/driving/{ipc,cli,hooks}/` | core (`index.ts`), `shared/`, `electron`, `node:*`, packages | driven adapters, `electron/app/`, `src/` |
| driven adapters | `electron/adapters/driven/<adapter>/` | core (`index.ts`, port types), `shared/`, `electron`, `node:*`, packages, files of the same adapter folder | other adapter folders, `electron/app/`, `src/` |
| composition root | `electron/app/` | anything under `electron/`, `shared/` | `src/` |
| entry | `electron/main.ts` | `electron/app/index.ts` only | everything else |
| shared | `shared/` | `shared/`, `zod` | `electron/`, `src/`, `agents/` |
| renderer | `src/app/`, `src/features/<f>/`, `src/shared/` | `shared/`, packages; other features only via `src/features/<g>/index.ts`; `src/shared/` imports no feature and no app | `electron/` |
| agents | `agents/` | `shared/`, packages | `electron/`, `src/` |

- Type-only imports (`import type`, `export type`) are erased at build and are exempt from the package rules (core
  may `import type { Node } from 'web-tree-sitter'`), but not from the layer rules (core still may not import types
  from adapters or `src/`).
- Core purity in practice:
  - `node:path` → `electron/core/shared/posix-path.ts` (pure `join`, `dirname`, `basename`, `extname`, `relative`,
    `normalize`, `isAbsolute` on POSIX paths). Core works on workspace-relative POSIX paths; adapters handle OS paths.
  - `path.posix.matchesGlob` (5 sites) → `GlobMatcher` port; `node:crypto` hashing → `Hasher` port
    (`electron/core/shared/ports.ts`), implemented in `driven/fs/glob.ts` and `driven/fs/hash.ts` with the same Node
    calls, so results are identical.
  - ids: `globalThis.crypto.randomUUID()` (Web standard, no import).
  - tree-sitter runtime (`Parser`, `Language`, `Query`) → `SyntaxParser` port, implemented in `driven/tree-sitter/`.
  - `process.*` (`platform`, `env`, `kill`, `pid`) is Node-only and not used in core; values come in as options or
    ports (e.g. `PortService`'s platform, `ProcessProbe`).
  - timers (`setTimeout`, `setInterval`) and `Date.now()` are globals and allowed; services that need a fake clock
    for tests take an optional `now`/timer injection.
- Ports live in `electron/core/<feature>/ports.ts` (owned by the consumer) and are exported from the feature's
  `index.ts`. Adapters implement them; only `electron/app/` constructs adapters and passes them in.

### Core feature dependencies (one-way)

Intended edges (the cycle test enforces acyclicity; any new edge must keep the graph acyclic):

```
repo-map   → git
terminals  → git, activity
runtime    → git, terminals
views      → git, db-schema, stinggraph
stinggraph → git
app        → git
git, activity, db-schema → (none)
```

Back-edges become ports or listeners, never imports:

- `WorkspaceLifecycle` (`electron/core/git/workspace-lifecycle.ts`): `onCreated`, `beforeRemove`, `afterRemove`,
  `removeFailed` listeners. Terminals, views, stinggraph, activity, git-state and view state register in
  `electron/app/compose.ts`. Replaces `GitService`'s `hooks` (`electron/git.ts:47`, wired at `electron/main.ts:51-54`)
  and the inline removal sequence at `electron/main.ts:141-147`.
- Activity needs the list of known terminals (`main.ts:195-201`): `TerminalDirectory` port in `core/activity`,
  implemented by the terminals service in `compose.ts`.
- `GitService.repoSnapshot` / `inspectFile` (`electron/git.ts:224-227`) move to `core/repo-map` (`RepoMapService`,
  which uses git's workspace lookup and status). This removes today's `git.ts` ↔ `repo-map.ts` cycle.
- `driven/stinggraph-worker/stinggraph.ts` → `core/views/rules/*` (worker evaluates rules) is adapter → core and allowed.

### Failure isolation

| # | Rule | Where | "X fails, Y still works" test (fake adapters) |
|---|---|---|---|
| 1 | One error boundary per driving entry: each IPC handler, CLI command and hook event catches and returns a typed error. | `electron/app/ipc.ts` envelope ([step 3](2026-11-23-03-ipc-contracts-design.md#main-electronappipcts)); `driving/cli/views-cli.ts` (exit 1 + message); `driving/hooks/activity-socket.ts` (per-event catch and log; the server keeps accepting) | `tests/app/contracts.test.ts`: handler A throws → `{ ok: false }`, handler B answers. `tests/views/views-cli.core.test.ts`: failing core → exit code 1 + message, no throw. `tests/activity/activity-socket.test.ts`: malformed event and an event whose core call throws → logged, socket still listening; next valid event is applied. |
| 2 | Cross-feature calls degrade instead of throwing. | caller wraps the call and returns a degraded result with a notice | `tests/views/view-service.core.test.ts`: `GraphHost` throws → non-graph views compute, graph status `unavailable`; `DbSchemaSource` rejects → Database view resolves with a warning, other views unaffected. `tests/repo-map/repo-map.core.test.ts`: size measurement fails → snapshot with sizes `unavailable` (step 6). |
| 3 | Lifecycle listeners run independently (`Promise.allSettled`). Only safety-critical `beforeRemove` listeners are `blocking: true`: terminals closed, and the stinggraph release. The stinggraph release falls back to killing the worker serving the workspace and rejects (blocks) only if that kill also fails. The views release never blocks (failure logged). | `core/git/workspace-lifecycle.ts`; `core/stinggraph/release.ts` (`releaseWorkspace(host, id)`: `host.close(id)`, on failure log and `host.kill()`) | `tests/git/workspace-lifecycle.test.ts` (listeners as `compose.ts` registers them, fake `GraphHost`): view-state `afterRemove` rejects → activity and git-state listeners still run, removal succeeds; views release fails → removal proceeds; stinggraph release fails, kill succeeds → removal proceeds; stinggraph release and kill fail → removal refused with "Could not stop the code graph for this workspace. Close Stingray and try again.", nothing deleted, `removeFailed` listeners run; terminals `beforeRemove` rejects → removal aborted, nothing deleted, `removeFailed` listeners run. |
| 4 | Crash-prone code runs in the worker process. | stinggraph worker already; db-schema/sql-schema parsing moves there (audit 10) | `tests/db-schema/db-schema-worker.test.ts`: worker killed mid-parse → Database view resolves to a warning, main-process services (fake git) keep answering. |

## Commit 4 — Moves

All moves use `git mv` so history follows. Only import specifiers, build/test config and path strings change.
The code-graph feature is renamed `codegraph` → `stinggraph` here (folders and file names in the new layout; the app
uses the stinggraph fork of CodeGraph), behaviour-free. Not renamed: the npm package `@colbymchenry/codegraph` and
its imports, the `.codegraph` cache dir and other on-disk names (`<userData>/codegraph/` overlays, the
`codegraph.sharedBase` setting key), `dist-electron/` output names (`codegraph-worker.cjs`), exported symbols
existing tests import (`createCodeGraphProcessHost`, …), and the flat `window.stingray.*` names.
Files that mix logic and I/O move whole to the layer named below and are split in their feature's commit 5
("split" column). New files from step 3 (`shared/contracts/**`, `electron/app/ipc.ts`,
`electron/adapters/driving/ipc/build-api.ts`, `electron/adapters/driven/electron-shell/sender.ts`,
`src/features/<x>/demo.ts`) are already in place. Paths below are relative to `electron/` unless they start with
`src/`, `shared/` or `tests/`.

### electron/

| From | To | Split in commit 5 |
|---|---|---|
| `main.ts` | stays `main.ts` | thin entry in step 5 |
| `preload.ts` | `adapters/driving/ipc/preload.ts` | — |
| `store.ts` | `core/git/store.ts` | SQLite access → `driven/sqlite/state-repository.ts` |
| `database.ts` | `adapters/driven/sqlite/database.ts` | — |
| `editors.ts` | `core/app/editors.ts` | spawn → `driven/process/editor-launcher.ts`; realpath → `driven/fs/source-files.ts`; settings → `driven/sqlite/settings-repository.ts` |
| `git.ts` | `core/git/git.ts` | `git()` runner → `driven/git/runner.ts`; fs ops → `driven/fs/workspace-files.ts`; `repoSnapshot`/`inspectFile` → `core/repo-map/repo-map-service.ts` |
| `git-state.ts` | `core/git/git-state.ts` | `.git` watcher → `driven/git/watcher.ts` |
| `git-lines.ts` | `core/git/git-lines.ts` | runner → `driven/git/runner.ts` |
| `git-exclude.ts` | `adapters/driven/git/git-exclude.ts` | — |
| `clone.ts` | `adapters/driven/git/clone.ts` | — |
| `worktree-removal.ts` | `core/git/worktree-removal.ts` | — |
| `pull-requests.ts` | `core/git/pull-requests.ts` | default `PRRunner` → `driven/git/gh.ts` |
| `repo-map.ts` | `core/repo-map/repo-map.ts` | `inventoryGit` → `driven/git/runner.ts`; `readWorkingFile` → `driven/fs/working-files.ts` |
| `repo-map-size.ts` | `core/repo-map/repo-map-size.ts` | file reads → `driven/fs/working-files.ts` |
| `terminals.ts` | `core/terminals/terminals.ts` | `pty.spawn`, `os` → `driven/pty/node-pty.ts` |
| `terminal-mirror.ts` | `adapters/driven/pty/terminal-mirror.ts` | — |
| `terminal-serialize.ts` | `adapters/driven/pty/terminal-serialize.ts` | — |
| `terminal-links.ts` | `core/terminals/terminal-links.ts` | stat/realpath → `driven/fs/link-targets.ts` |
| `activity.ts` | `core/activity/activity.ts` | socket server → `driving/hooks/activity-socket.ts`; pid probe → `driven/process/process-probe.ts` |
| `activity-shell.ts` | `adapters/driven/fs/activity-shell.ts` | `shellQuote` stays here (used by `driven/fs/launcher.ts`) |
| `activity-history.ts` | `core/activity/activity-history.ts` | SQLite → `driven/sqlite/activity-history-repository.ts` |
| `harnesses.ts` | `core/activity/harnesses.ts` | — |
| `codegraph.ts` | `adapters/driven/stinggraph-worker/stinggraph.ts` | — |
| `codegraph-process.ts` | `adapters/driven/stinggraph-worker/stinggraph-process.ts` | restart policy → `core/stinggraph/restart-policy.ts` |
| `codegraph-worker.ts` | `app/stinggraph-worker.ts` (process entry) | — |
| `codegraph-overlay.ts` | `adapters/driven/stinggraph-worker/stinggraph-overlay.ts` | `gitOut` uses the injected `driven/git` runner |
| `codegraph-settings.ts` | `core/stinggraph/stinggraph-settings.ts` | SQLite → `driven/sqlite/settings-repository.ts` |
| `view-state.ts` | `core/views/view-state.ts` | SQLite → `driven/sqlite/view-state-repository.ts` |
| `views-cli.ts` | `adapters/driving/cli/views-cli.ts` | process wiring → `app/views-cli.ts` (new build entry) |
| `db-schema.ts` | `core/db-schema/db-schema.ts` | parser → `driven/tree-sitter`; walk → `driven/fs/walk.ts` |
| `sql-schema.ts` | `core/db-schema/sql-schema.ts` | same |
| `sql-ddl.ts` | `core/db-schema/sql-ddl.ts` | — |
| `tree-sitter-python.wasm` | `adapters/driven/tree-sitter/tree-sitter-python.wasm` | — |
| `ports.ts` | `core/runtime/ports.ts` | ps/lsof → `driven/process/ps-lsof.ts` |
| `containers.ts` | `core/runtime/containers.ts` | docker exec → `driven/docker/docker-runner.ts` |
| `live-view.ts` | `core/runtime/live-view.ts` | `fetch` + `WebSocket` → `driven/cdp/cdp-connection.ts` |
| `chrome-inspect.ts` | `core/runtime/chrome-inspect.ts` | clipboard → `driven/electron-shell/clipboard.ts`; `open -a` → `driven/process/open-app.ts` |
| `views/launcher.ts` | `adapters/driven/fs/launcher.ts` | — |
| `views/rules/files.ts` | `adapters/driven/fs/files.ts` | becomes `walk.ts` + file provider (audit 16) |
| `views/rules/grammars.ts` | `adapters/driven/tree-sitter/grammars.ts` | — |
| `views/rules/codegraph-api.ts` | `adapters/driven/stinggraph-worker/stinggraph-api.ts` | — |
| `views/save-view.ts` | `core/views/save-view.ts` | writes → `driven/fs/view-files.ts` |
| `views/view-file.ts` | `core/views/view-file.ts` | reads → `driven/fs/view-files.ts` |
| every other `views/**` file: `compute.ts`, `database.ts`, `explain.ts`, `explanation.ts`, `graph.ts`, `index.ts`, `infra.ts`, `service.ts`, `flowchart/{build,cfg,index,labels,python,typescript}.ts`, `rules/{callees,engine,graph-steps,layers,schema,template,types}.ts`, `sequence/{auth-links,event-links,externals,index,langgraph-links,links,walk}.ts`, `sets/{alembic,cdk,index,langgraph-routers,langgraph,terraform}.ts` | `core/views/<same relative path>` (`views/index.ts` becomes the feature's `index.ts`) | `rules/engine.ts`, `sequence/langgraph-links.ts`: runtime tree-sitter → `SyntaxParser`; `node:path`/`matchesGlob` → `posix-path` + `GlobMatcher`; `explain.ts` hashing → `Hasher` |

New in commit 4: `core/<feature>/index.ts` for every feature (named re-exports of what other layers import today,
no `export *`), `core/shared/` (empty until commit 5).

### shared/ (pure code both processes run)

| From | To |
|---|---|
| `src/infra/catalog.ts` | `shared/views/infra/catalog.ts` |
| `src/views-text.ts` | `shared/views/views-text.ts` |
| `src/sequence-events.ts` | `shared/views/sequence-events.ts` |
| `src/views-database.ts` | `shared/views/views-database.ts` |

### src/

| From | To |
|---|---|
| `src/main.tsx`, `src/App.tsx`, `src/api.ts`, `src/demo.ts`, `src/ProjectHome.tsx`, `src/project-home.css`, `src/project-navigation.ts`, `src/styles.css`, `src/workspace-chrome.css` | `src/app/<same name>` |
| `src/Modal.tsx`, `src/highlight.ts`, `src/prism.d.ts` | `src/shared/<same name>` |
| `src/AddProjectForm.tsx`, `src/add-project.css`, `src/RemoveWorktreeForm.tsx`, `src/worktree-removal.css`, `src/WorkspaceStatus.tsx`, `src/workspace-git.css`, `src/useGitState.ts` | `src/features/git/` |
| `src/RepoMap.tsx`, `src/RepoMapCanvas.tsx`, `src/RepoMapCodeView.tsx`, `src/LineCounts.tsx`, `src/repo-map-layout.ts`, `src/repo-map-model.ts`, `src/repo-map.css` | `src/features/repo-map/` |
| `src/TerminalPane.tsx`, `src/terminal-links.ts` | `src/features/terminals/` |
| `src/activity.ts`, `src/useActivity.ts`, `src/WorkspaceActivity.tsx`, `src/workspace-activity.css` | `src/features/activity/` |
| `src/views.ts` | deleted in step 3 (types in `shared/contracts/views.ts`) |
| `src/ViewsTab.tsx`, `src/views-tab.css`, `src/views-tab-model.ts` | `src/features/views/` |
| `src/infra/icons.ts` | `src/features/views/infra/icons.ts` (its `../assets/...` glob still resolves) |
| `src/assets/infra-icons/**` (151 SVGs) | `src/features/views/assets/infra-icons/**` (one `git mv` of the folder) |
| `src/views-ui/**` (22 files) | `src/features/views/views-ui/**` |
| `src/db-schema.ts` | deleted in step 3 (types in `shared/contracts/db-schema.ts`) |
| `src/live-view.ts`, `src/LiveView.tsx`, `src/live-view.css`, `src/BrowserPane.tsx`, `src/WorkspacePortsChip.tsx`, `src/workspace-ports.css`, `src/workspace-status.ts`, `src/useWorkspacePorts.ts` | `src/features/runtime/` |
| `src/shared.ts` | deleted in step 3 |

New: `src/features/<f>/index.ts` per feature, exporting what `src/app/` and other features import (e.g. `RepoMap`,
`TerminalPane`, `ViewsTab`, `WorkspaceStatus`, `useGitState`, `useActivity`, `LiveView`, `BrowserPane`,
`WorkspacePortsChip`, `createXDemo`). `src/features/stinggraph/` and `src/features/db-schema/` hold only `demo.ts` + `index.ts`.

### tests/

| Folder | Files |
|---|---|
| `tests/app/` | `database.test.ts`, `editors.test.ts`, `project-navigation.test.ts`, `desktop.mjs`, `launch.mjs`, `package-launch.mjs`, `contracts.test.ts` (step 3), `single-instance.mjs` (step 1) |
| `tests/shared/` | `highlight.test.ts` |
| `tests/agents/` | `hook-client.test.ts`, `pi-observer.test.ts`, `pi-smoke.ts` |
| `tests/git/` | `git.test.ts`, `git-state.test.ts`, `git-lines.test.ts`, `git-exclude.test.ts`, `clone.test.ts`, `worktree-removal.test.ts`, `pull-requests.test.ts`, `pull-requests.mjs`, `worktree-removal.mjs`, `add-project.mjs` |
| `tests/repo-map/` | `repo-map.test.ts`, `repo-map.mjs` |
| `tests/terminals/` | `terminal-links.test.ts`, `terminal-mirror.test.ts`, `terminal-links.mjs` |
| `tests/activity/` | `activity.test.ts`, `activity-shell.test.ts`, `activity-history.test.ts`, `pi-activity.mjs`, `verify-activity.mjs` |
| `tests/stinggraph/` | `codegraph.test.ts` → `stinggraph.test.ts`, `codegraph-process.test.ts` → `stinggraph-process.test.ts`, `codegraph-overlay.test.ts` → `stinggraph-overlay.test.ts`, `codegraph-engine.test.ts` → `stinggraph-engine.test.ts` |
| `tests/views/` | `views.test.ts`, `view-service.test.ts`, `view-state.test.ts`, `view-file.test.ts`, `views-cli.test.ts`, `views-tab-model.test.ts`, `save-view.test.ts`, `launcher.test.ts`, `rules-engine.test.ts`, `rules-schema.test.ts`, `rule-files.test.ts`, `graph-steps.test.ts`, `callees.test.ts`, `codegraph-api.test.ts` → `stinggraph-api.test.ts`, `layers.test.ts`, `explain.test.ts`, `explanation.test.ts`, `explanation-title.test.ts`, `flowchart.test.ts`, `flowchart-labels.test.ts`, `flow-layout.test.ts`, `er-diff.test.ts`, `er-filter.test.ts`, `er-layout.test.ts`, `sequence.test.ts`, `sequence-links.test.ts`, `sequence-layout.test.ts`, `sequence-helpers.ts`, `sets-builtin.test.ts`, `langgraph-routers.test.ts`, `text-diagram.test.ts`, `infra-catalog.test.ts`, `views-tab.mjs` |
| `tests/db-schema/` | `db-schema.test.ts`, `sql-schema.test.ts`, `sql-ddl.test.ts` |
| `tests/runtime/` | `ports.test.ts`, `live-view.test.ts`, `workspace-status.test.ts`, `workspace-status.mjs` |
| `tests/fixtures/` | stays |

New folders filled later: `tests/fakes/` (commit 5, e.g. `tests/fakes/stinggraph.ts`), `tests/architecture/` (commit 9).

### Build, config, scripts (commit 4)

- `scripts/build-electron.mjs`: entry points as an object so output names stay flat:
  `{ main: 'electron/main.ts', preload: 'electron/adapters/driving/ipc/preload.ts', 'codegraph-worker': 'electron/app/stinggraph-worker.ts', 'views-cli': 'electron/adapters/driving/cli/views-cli.ts' }`
  (the `views-cli` entry becomes `electron/app/views-cli.ts` in the views extraction commit); wasm copied from
  `electron/adapters/driven/tree-sitter/tree-sitter-python.wasm`. `dist-electron/` layout unchanged (the worker
  output stays `codegraph-worker.cjs`).
- `package.json`: `"test": "tsx --test \"tests/**/*.test.ts\""`; `test:*` scripts point at the new `.mjs` paths.
- `tsconfig.json`: include `shared` and `tests/**/*.ts`.
- `index.html`: `/src/app/main.tsx`.
- `scripts/run-e2e.mjs`: `suites` becomes a map `{ desktop: 'app', 'repo-map': 'repo-map', 'terminal-links': 'terminals', 'workspace-status': 'runtime', 'pull-requests': 'git', 'worktree-removal': 'git', 'add-project': 'git', 'views-tab': 'views' }`,
  runs `tests/${suites[suite]}/${suite}.mjs`; `--list` prints the keys. Same suite names.
- `tests/verify-activity.mjs`: `readdir('tests', { recursive: true })` for unit files; update the `.mjs` paths.
- Path strings: `tests/stinggraph/stinggraph-process.test.ts:16` (worker entry), `:212` (grammar path),
  `tests/views/infra-catalog.test.ts:8` (icons dir), `tests/views/langgraph-routers.test.ts:14` and
  `tests/views/sets-builtin.test.ts:13` (`../fixtures/views`), `tests/views/views-tab.mjs:36` (`../fixtures/...`).
- `agents/skills/stingray-views/SKILL.md:91` → `shared/views/infra/catalog.ts`.
- Runtime paths in code (`__dirname`-relative `tree-sitter-python.wasm`, preload and worker `.cjs`) are unchanged
  because `dist-electron/` stays flat.

## Commit 5 — Per-feature extraction

One commit per feature, in this order: git, activity, terminals, stinggraph, repo-map, views, db-schema, runtime.
Each commit:

1. Splits the files marked "split" above: logic stays in `core/<f>/`; I/O moves to the named driven adapter;
   `core/<f>/ports.ts` declares the interfaces.
2. Moves the feature's IPC handler object out of `main.ts` into `adapters/driving/ipc/<f>.ts`
   (`<f>Handlers(core): Invoke<FContract>`), calling core only.
3. Adds `tests/fakes/<f>.ts` (in-memory or scripted fakes for every port of the feature) and core unit tests
   `tests/<f>/<module>.core.test.ts` that run without git, PTYs, SQLite, Docker or Electron.
4. Adds `electron/app/wiring/<f>.ts` (see below) and switches `main.ts` to it.
5. Applies the audit fixes listed for the feature, with their tests.

| Feature | Core (`electron/core/<f>/`) | Ports | Driven adapters | Driving | Audit fixes in this commit |
|---|---|---|---|---|---|
| git | `store.ts`, `git.ts`, `git-state.ts`, `git-lines.ts`, `worktree-removal.ts`, `pull-requests.ts`, `workspace-lifecycle.ts` (new) | `GitRunner`, `WorkspaceFiles`, `StateRepository`, `GitDirWatcher`, `PRRunner`, `Cloner`, `GitStatePublisher` | `git/runner.ts`, `git/watcher.ts`, `git/gh.ts`, `git/clone.ts`, `git/git-exclude.ts`, `fs/workspace-files.ts`, `sqlite/state-repository.ts` | `ipc/git.ts` | 3, 6, git error detail, branch exists, status buffer |
| activity | `activity.ts`, `activity-history.ts`, `harnesses.ts` | `ProcessProbe`, `HistoryRepository`, `ShellIntegration`, `ActivityPublisher`, `TerminalDirectory` | `process/process-probe.ts`, `sqlite/activity-history-repository.ts`, `fs/activity-shell.ts` | `ipc/activity.ts`, `hooks/activity-socket.ts` | 4 |
| terminals | `terminals.ts`, `terminal-links.ts` | `PtySpawner`, `MirrorFactory`, `LinkTargets`, `LinkActions`, `TerminalPublisher` | `pty/node-pty.ts`, `pty/terminal-mirror.ts`, `pty/terminal-serialize.ts`, `fs/link-targets.ts`, `electron-shell/shell.ts` | `ipc/terminals.ts` | 9, 15, terminal titles |
| stinggraph | `stinggraph-settings.ts`, `restart-policy.ts` (new), `release.ts` (new, rule 3) | `SettingsRepository`, `GraphHost` (`close`, `kill`) | `stinggraph-worker/*`, `sqlite/settings-repository.ts` | `ipc/stinggraph.ts` | 5, overlays removed on workspace removal |
| repo-map | `repo-map.ts`, `repo-map-size.ts`, `repo-map-service.ts` (from `git.ts:224-227` and `GitService.repoSnapshot`) | `RepoInventory`, `WorkingFiles` | `git/runner.ts` (inventory), `fs/working-files.ts` | `ipc/repo-map.ts` | — (step 6 changes behaviour) |
| views | everything under `core/views/` | `ViewFiles`, `FileProvider`, `SyntaxParser`, `GraphHost` (in `graph.ts`), `ViewStateRepository`, `GlobMatcher`, `Hasher`, `ViewsPublisher` | `fs/walk.ts`, `fs/files.ts`, `fs/view-files.ts`, `fs/launcher.ts`, `fs/glob.ts`, `fs/hash.ts`, `tree-sitter/*`, `sqlite/view-state-repository.ts` | `ipc/views.ts`, `cli/views-cli.ts` (+ `app/views-cli.ts` entry) | 11, 16 (walker) |
| db-schema | `db-schema.ts`, `sql-schema.ts`, `sql-ddl.ts` | `SyntaxParser`, `FileProvider` (walker, `skipDotDirs: true`, 20 000 entry cap) | worker calls in `stinggraph-worker/` | — (served via views) | 10, 16 (db/sql use the walker) |
| runtime | `ports.ts`, `containers.ts`, `live-view.ts`, `chrome-inspect.ts` | `PortScanner`, `DockerRunner`, `CdpConnection`, `Clipboard`, `AppOpener`, `LiveViewPublisher` | `process/ps-lsof.ts`, `process/open-app.ts`, `docker/docker-runner.ts`, `cdp/cdp-connection.ts`, `electron-shell/clipboard.ts` | `ipc/runtime.ts` | CDP call timeout |

Core unit tests per feature (minimum; each uses only `tests/fakes/<f>.ts`):

- git: `git.core.test.ts` (create/review/remove against a scripted `GitRunner`, consent fingerprint),
  `git-state.core.test.ts` (debounce, revision bumps, `forget`), `workspace-lifecycle.test.ts` (rule 3).
- activity: `activity.core.test.ts` (phase transitions, lease expiry with fake clock, hook resume keeps `seen`),
  `activity-socket.test.ts` (rule 1).
- terminals: `terminals.test.ts` (audit 15 cases with a fake PTY), `terminal-links.core.test.ts`.
- stinggraph: `restart-policy.test.ts` (backoff, crash limit, 30 s reset, fake clock), `release.test.ts` (close
  fails → `kill` called once; close and kill fail → rejects with the removal-refused message).
- repo-map: `repo-map.core.test.ts` (snapshot assembly from scripted inventory; rule 2 degraded sizes).
- views: `view-service.core.test.ts` (rule 2 with failing `GraphHost`), `views-cli.core.test.ts` (rule 1),
  `posix-path.test.ts` (each helper compared with `node:path.posix` on a table of inputs).
- db-schema: `db-schema.core.test.ts` (extraction from a fake `SyntaxParser` tree), `db-schema-worker.test.ts` (rule 4).
- runtime: `ports.core.test.ts` (fake `PortScanner`, injected platform), `containers.core.test.ts`, `live-view.core.test.ts` (fake `CdpConnection`).

### Compatibility wiring (`electron/app/wiring/<f>.ts`)

Existing tests must pass unchanged apart from import paths (OQ3). Where a test constructs a service or calls a
function whose dependencies become ports, the old name and call signature stay available from
`electron/app/wiring/<f>.ts`, built as core + real adapters. Examples: `new GitService(store, count?, hooks?)`
(including `repoSnapshot`/`inspectFile`, delegating to `RepoMapService`), `new Store(dir)`,
`new ActivityService(publish, lease?, hookWorking?, …)`, `new ViewService({ host, grammarPath, emit, … })`,
`extractDbSchema(id, root, grammarPath)`, `extractSqlSchema(id, root, grammarDir?)`,
`createCodeGraphProcessHost(options)` (from `electron/app/wiring/stinggraph.ts`), `new PortService(roots)`, `new ContainerService()`,
`new LiveViews(publish)`, `new EditorService(dir, deps)`, `git(cwd, args)`. Pure functions that tests import
(`parseStatus`, `parseNumstat`, `processOwners`, `parseContainers`, rules engine helpers, …) are imported straight
from core. `compose.ts` uses the same wiring factories, so tests exercise the production assembly. Existing tests
thus become integration tests of core + real adapters; the new `*.core.test.ts` files cover core alone.

## Commit 9 — Boundary and cycle tests

`tests/architecture/import-boundaries.test.ts` (node:test, no new dependency):

- Walks `electron/`, `shared/`, `src/`, `agents/` for `.ts`/`.tsx`. Extracts specifiers from
  `import … from`, `export … from`, side-effect `import '…'` and `import('…')`, recording whether the statement is
  type-only (`import type`, `export type`, or every named binding marked `type`). Resolves relative specifiers to a
  file (`.ts`, `.tsx`, `/index.ts`, `/index.tsx`, exact for `.css`/`.wasm`/`.svg`).
- Classifies each file into a layer from the "Layers and rules" table and checks every import against it:
  - runtime imports in core: only own feature, other core feature `index.ts`, `electron/core/shared/`, `shared/`,
    `zod`, `yaml`; any `node:*`, `electron` or other package fails;
  - type-only imports are checked for layer rules only, never for package rules;
  - cross-feature imports (core and `src/features/`) must target that feature's `index.ts`;
  - driving ↔ driven and adapter ↔ adapter (different folder) imports fail; only `electron/app/` imports adapters,
    and no adapter imports `electron/app/`;
  - `electron/main.ts` imports only `electron/app/index.ts`;
  - `shared/` imports only `shared/` and `zod` at runtime; `src/` never imports `electron/`; `agents/` imports
    only `shared/` and packages.
- No allow-list: the test has no list of exempt files. A violation is fixed in code.
- Failure output: `file:line → target (rule)`.
- Self-check: a table of (from, to, typeOnly, expected) cases runs through the classifier.

`tests/architecture/core-cycles.test.ts`: builds the graph of core feature → core feature edges (runtime and
type-only) from the same scanner and fails on any cycle, printing it. It also asserts the edges are a subset of the
intended set above (kept as `INTENDED_EDGES` in the test), so a new edge is a reviewed change.

## Acceptance criteria

- [ ] `ls electron` shows `main.ts`, `app/`, `core/`, `adapters/`; `ls src` shows `app/`, `features/`, `shared/`.
- [ ] Commit 4: `git diff -M` shows renames with only import/path hunks plus new `index.ts` files and config;
      `ls dist-electron` identical before and after; all existing tests pass with path-only edits.
- [ ] Each commit 5 leaves no `node:*`/`electron`/native import in that feature's core and adds its fakes and core tests.
- [ ] Commit 9: boundary and cycle tests pass with no allow-list and fail on a deliberate bad import and a
      deliberate cycle (checked once by hand, noted in the PR).
- [ ] Every failure-isolation rule has its test, passing.
- [ ] `npm test` runs all unit test files (node:test count = before + new).

## Verification

```
npm run check
npm run test:e2e                    # after commits 4, each 5, and 9
node scripts/run-e2e.mjs --list
ls dist-electron                    # compare with pre-move listing
```

## Risks & rollback

- Cycles through `index.ts` during commits 4-5 (`git` ↔ `repo-map`, views ↔ db-schema ↔ stinggraph) can hit a TDZ
  at startup; e2e after each commit catches it, and the extraction removes the cycles in order.
- Rule 3 splits today's single release (`views.release`, which also closes the graph; its failure aborts the
  removal): the views release becomes non-blocking; the stinggraph release stays blocking but first falls back to
  killing the worker, so the worker never holds files in a folder being deleted. One worker serves all workspaces
  today, so the kill also stops other workspaces' graphs; they show `unavailable` and reopen on their next `open()`
  (a deliberate kill is not counted as a crash by the restart policy).
- Compatibility wiring keeps old signatures alive; it is deliberate (tests unchanged) and is the same code path
  production uses.
- Re-implemented POSIX path helpers could differ from Node on edge cases; the table test against `node:path.posix`
  guards that, and globs/hashes keep the Node implementation via ports.
- Rollback: revert per commit; no data touched.

## Decisions

- **Hexagonal layout** with the layer table above; `electron/main.ts` is the only entry file outside `app/`.
- **Full extraction in this PR (Hex-B)**: moves commit, eight feature commits, strict boundary + cycle tests last,
  no allow-list.
- **Core purity**: no `node:*`, `electron` or package runtime imports except `zod`, `yaml`; type-only package
  imports allowed; `posix-path.ts` replaces `node:path`; globs and sha256 via ports; ids via
  `globalThis.crypto.randomUUID()`; tree-sitter runtime behind `SyntaxParser`.
- **Driven adapter folders**: git, fs, pty, docker, process, cdp, sqlite, stinggraph-worker, electron-shell,
  tree-sitter. One git runner (`driven/git/runner.ts`) and one walker (`driven/fs/walk.ts`; options `skipDotDirs`
  and a per-caller entry cap, see [step 7 § 16](2026-11-23-07-audit-fixes-design.md#finding-16--one-file-walker-one-git-runner)).
- **Feature name stinggraph**: the code-graph feature is renamed `codegraph` → `stinggraph` in commit 4 (folders,
  file names, contract, channels, tests, fakes), behaviour-free. The npm package `@colbymchenry/codegraph` and its
  imports, the `.codegraph` cache dir and other on-disk names, `dist-electron/` output names, exported symbols and
  the flat renderer API names stay unchanged.
- **Dependencies (OQ7 A)**: one-way core edges with a cycle test; back-edges via `WorkspaceLifecycle` and ports.
- **Failure isolation**: the four rules above, each with a test using fake adapters.
- **Removal isolation (rule 3, refined)**: listeners run independently (`allSettled`); blocking only for terminals
  closed and the stinggraph release; a failed stinggraph release kills the worker serving the workspace and blocks
  removal only if the kill also fails; a views release failure never blocks (logged).
- **Renderer (H2, OQ11)**: `src/features/<f>/` per backend feature; `WorkspaceStatus.tsx` in `src/features/git`.
- **Cross-process pure code** lives in `shared/views/`; `src/` never imports `electron/`.
- **Tests (OQ3)**: existing tests change only import paths and path strings; compatibility wiring keeps their APIs.
