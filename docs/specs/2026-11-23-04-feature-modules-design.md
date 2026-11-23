# Step 4 — Feature modules

Status: draft · Umbrella: [modular restructure](2026-11-23-modular-restructure-design.md)

## Goal

Every source file lives in its feature folder, mirrored between processes; each feature has a public `index.ts`;
cross-feature imports go through it; a node:test enforces that; tests are mirrored by feature.

## Non-goals

- No behaviour change. No code edits other than import specifiers, new `index.ts` re-export files, build/test
  config, and path strings that point at moved files (entry points, fixtures, workers).
- No renaming of files (except `src/shared.ts` → `src/shared/index.ts`), symbols or exports.
- No splitting of `src/shared.ts` into per-feature types.
- `agents/` stays where it is.

## Current behaviour

- Flat folders: 37 files in `electron/` plus 40 in `electron/views/**`; 49 files directly in `src/` (52 today; step 2
  removes the three prototype files), 22 in `src/views-ui/`, 2 in `src/infra/`, 151 SVGs in `src/assets/infra-icons/`.
- 60 `tests/*.test.ts`, 12 `tests/*.mjs`, `tests/sequence-helpers.ts`, `tests/pi-smoke.ts`, `tests/fixtures/`.
- `package.json:17` `"test": "tsx --test tests/*.test.ts"`; `tsconfig.json` includes `tests/*.ts`.
- `scripts/run-e2e.mjs:12` runs `tests/${suite}.mjs`.
- `tests/verify-activity.mjs:30` lists unit tests with `readdir('tests')` (not recursive); lines 34-42 hard-code
  `tests/<name>.mjs` paths.
- `scripts/build-electron.mjs:3` uses an entry-point array; esbuild names outputs relative to the entries' common
  ancestor, so moving entries into different folders would change output paths. `package.json:7` (`main`),
  `electron/main.ts:64,87,93,103` and `codegraph-process.ts:44` rely on flat `dist-electron/*.cjs` names.
  `build-electron.mjs:6` copies `electron/tree-sitter-python.wasm`.
- `index.html` loads `/src/main.tsx`.
- `src/infra/icons.ts:4` globs `../assets/infra-icons/*/*.svg` relative to itself.
- Path strings in tests: `tests/codegraph-process.test.ts:16` (worker entry), `tests/infra-catalog.test.ts:8`
  (icons dir), `tests/langgraph-routers.test.ts:14` and `tests/sets-builtin.test.ts:13` (`fixtures/views`),
  `tests/views-tab.mjs:36` (`./fixtures/...`). `tests/hook-client.test.ts:11` is cwd-relative and does not change.
- `agents/skills/stingray-views/SKILL.md:91` names `src/infra/catalog.ts`.
- Existing cross-feature cycles (work today, file-level): `git.ts` ↔ `repo-map.ts`;
  `views/service.ts` → `db-schema.ts` → `views/rules/grammars.ts`; `codegraph*.ts` → `views/**` and
  `views/service.ts` uses the codegraph host only through the `GraphHost` interface.

## Design

### Moves

All with `git mv` so history follows. Files created in step 3 (`contract.ts`, `demo.ts`, `src/app/desktop-api.ts`,
`src/app/contracts.ts`, `src/app/contract.ts`, `src/shared/contract.ts`, `electron/app/ipc.ts`) are already at
their final paths.

#### electron/

| From | To |
|---|---|
| `electron/main.ts` | `electron/app/main.ts` |
| `electron/preload.ts` | `electron/app/preload.ts` |
| `electron/store.ts` | `electron/app/store.ts` |
| `electron/database.ts` | `electron/app/database.ts` |
| `electron/editors.ts` | `electron/app/editors.ts` |
| `electron/git.ts` | `electron/features/git/git.ts` |
| `electron/git-state.ts` | `electron/features/git/git-state.ts` |
| `electron/git-lines.ts` | `electron/features/git/git-lines.ts` |
| `electron/git-exclude.ts` | `electron/features/git/git-exclude.ts` |
| `electron/clone.ts` | `electron/features/git/clone.ts` |
| `electron/worktree-removal.ts` | `electron/features/git/worktree-removal.ts` |
| `electron/pull-requests.ts` | `electron/features/git/pull-requests.ts` |
| `electron/repo-map.ts` | `electron/features/repo-map/repo-map.ts` |
| `electron/repo-map-size.ts` | `electron/features/repo-map/repo-map-size.ts` |
| `electron/terminals.ts` | `electron/features/terminals/terminals.ts` |
| `electron/terminal-mirror.ts` | `electron/features/terminals/terminal-mirror.ts` |
| `electron/terminal-serialize.ts` | `electron/features/terminals/terminal-serialize.ts` |
| `electron/terminal-links.ts` | `electron/features/terminals/terminal-links.ts` |
| `electron/activity.ts` | `electron/features/activity/activity.ts` |
| `electron/activity-shell.ts` | `electron/features/activity/activity-shell.ts` |
| `electron/activity-history.ts` | `electron/features/activity/activity-history.ts` |
| `electron/harnesses.ts` | `electron/features/activity/harnesses.ts` |
| `electron/codegraph.ts` | `electron/features/codegraph/codegraph.ts` |
| `electron/codegraph-process.ts` | `electron/features/codegraph/codegraph-process.ts` |
| `electron/codegraph-worker.ts` | `electron/features/codegraph/codegraph-worker.ts` |
| `electron/codegraph-overlay.ts` | `electron/features/codegraph/codegraph-overlay.ts` |
| `electron/codegraph-settings.ts` | `electron/features/codegraph/codegraph-settings.ts` |
| `electron/view-state.ts` | `electron/features/views/view-state.ts` |
| `electron/views-cli.ts` | `electron/features/views/views-cli.ts` |
| `electron/db-schema.ts` | `electron/features/db-schema/db-schema.ts` |
| `electron/sql-schema.ts` | `electron/features/db-schema/sql-schema.ts` |
| `electron/sql-ddl.ts` | `electron/features/db-schema/sql-ddl.ts` |
| `electron/tree-sitter-python.wasm` | `electron/features/db-schema/tree-sitter-python.wasm` |
| `electron/ports.ts` | `electron/features/runtime/ports.ts` |
| `electron/containers.ts` | `electron/features/runtime/containers.ts` |
| `electron/live-view.ts` | `electron/features/runtime/live-view.ts` |
| `electron/chrome-inspect.ts` | `electron/features/runtime/chrome-inspect.ts` |
| `electron/views/compute.ts` | `electron/features/views/compute.ts` |
| `electron/views/database.ts` | `electron/features/views/database.ts` |
| `electron/views/explain.ts` | `electron/features/views/explain.ts` |
| `electron/views/explanation.ts` | `electron/features/views/explanation.ts` |
| `electron/views/flowchart/build.ts` | `electron/features/views/flowchart/build.ts` |
| `electron/views/flowchart/cfg.ts` | `electron/features/views/flowchart/cfg.ts` |
| `electron/views/flowchart/index.ts` | `electron/features/views/flowchart/index.ts` |
| `electron/views/flowchart/labels.ts` | `electron/features/views/flowchart/labels.ts` |
| `electron/views/flowchart/python.ts` | `electron/features/views/flowchart/python.ts` |
| `electron/views/flowchart/typescript.ts` | `electron/features/views/flowchart/typescript.ts` |
| `electron/views/graph.ts` | `electron/features/views/graph.ts` |
| `electron/views/index.ts` | `electron/features/views/index.ts` (becomes the feature's public index) |
| `electron/views/infra.ts` | `electron/features/views/infra.ts` |
| `electron/views/launcher.ts` | `electron/features/views/launcher.ts` |
| `electron/views/rules/callees.ts` | `electron/features/views/rules/callees.ts` |
| `electron/views/rules/codegraph-api.ts` | `electron/features/views/rules/codegraph-api.ts` |
| `electron/views/rules/engine.ts` | `electron/features/views/rules/engine.ts` |
| `electron/views/rules/files.ts` | `electron/features/views/rules/files.ts` |
| `electron/views/rules/grammars.ts` | `electron/features/views/rules/grammars.ts` |
| `electron/views/rules/graph-steps.ts` | `electron/features/views/rules/graph-steps.ts` |
| `electron/views/rules/layers.ts` | `electron/features/views/rules/layers.ts` |
| `electron/views/rules/schema.ts` | `electron/features/views/rules/schema.ts` |
| `electron/views/rules/template.ts` | `electron/features/views/rules/template.ts` |
| `electron/views/rules/types.ts` | `electron/features/views/rules/types.ts` |
| `electron/views/save-view.ts` | `electron/features/views/save-view.ts` |
| `electron/views/sequence/auth-links.ts` | `electron/features/views/sequence/auth-links.ts` |
| `electron/views/sequence/event-links.ts` | `electron/features/views/sequence/event-links.ts` |
| `electron/views/sequence/externals.ts` | `electron/features/views/sequence/externals.ts` |
| `electron/views/sequence/index.ts` | `electron/features/views/sequence/index.ts` |
| `electron/views/sequence/langgraph-links.ts` | `electron/features/views/sequence/langgraph-links.ts` |
| `electron/views/sequence/links.ts` | `electron/features/views/sequence/links.ts` |
| `electron/views/sequence/walk.ts` | `electron/features/views/sequence/walk.ts` |
| `electron/views/service.ts` | `electron/features/views/service.ts` |
| `electron/views/sets/alembic.ts` | `electron/features/views/sets/alembic.ts` |
| `electron/views/sets/cdk.ts` | `electron/features/views/sets/cdk.ts` |
| `electron/views/sets/index.ts` | `electron/features/views/sets/index.ts` |
| `electron/views/sets/langgraph-routers.ts` | `electron/features/views/sets/langgraph-routers.ts` |
| `electron/views/sets/langgraph.ts` | `electron/features/views/sets/langgraph.ts` |
| `electron/views/sets/terraform.ts` | `electron/features/views/sets/terraform.ts` |
| `electron/views/view-file.ts` | `electron/features/views/view-file.ts` |

#### src/

| From | To |
|---|---|
| `src/main.tsx` | `src/app/main.tsx` |
| `src/App.tsx` | `src/app/App.tsx` |
| `src/api.ts` | `src/app/api.ts` |
| `src/demo.ts` | `src/app/demo.ts` (after step 3 only the shared demo state + assembly) |
| `src/ProjectHome.tsx` | `src/app/ProjectHome.tsx` |
| `src/project-home.css` | `src/app/project-home.css` |
| `src/project-navigation.ts` | `src/app/project-navigation.ts` |
| `src/styles.css` | `src/app/styles.css` |
| `src/workspace-chrome.css` | `src/app/workspace-chrome.css` |
| `src/shared.ts` | `src/shared/index.ts` |
| `src/Modal.tsx` | `src/shared/Modal.tsx` (used by app, runtime and views) |
| `src/highlight.ts` | `src/shared/highlight.ts` (used by repo-map and views) |
| `src/prism.d.ts` | `src/shared/prism.d.ts` |
| `src/AddProjectForm.tsx` | `src/features/git/AddProjectForm.tsx` |
| `src/add-project.css` | `src/features/git/add-project.css` |
| `src/RemoveWorktreeForm.tsx` | `src/features/git/RemoveWorktreeForm.tsx` |
| `src/worktree-removal.css` | `src/features/git/worktree-removal.css` |
| `src/WorkspaceStatus.tsx` | `src/features/git/WorkspaceStatus.tsx` |
| `src/workspace-git.css` | `src/features/git/workspace-git.css` |
| `src/useGitState.ts` | `src/features/git/useGitState.ts` |
| `src/RepoMap.tsx` | `src/features/repo-map/RepoMap.tsx` |
| `src/RepoMapCanvas.tsx` | `src/features/repo-map/RepoMapCanvas.tsx` |
| `src/RepoMapCodeView.tsx` | `src/features/repo-map/RepoMapCodeView.tsx` |
| `src/LineCounts.tsx` | `src/features/repo-map/LineCounts.tsx` |
| `src/repo-map-layout.ts` | `src/features/repo-map/repo-map-layout.ts` |
| `src/repo-map-model.ts` | `src/features/repo-map/repo-map-model.ts` |
| `src/repo-map.css` | `src/features/repo-map/repo-map.css` |
| `src/TerminalPane.tsx` | `src/features/terminals/TerminalPane.tsx` |
| `src/terminal-links.ts` | `src/features/terminals/terminal-links.ts` |
| `src/activity.ts` | `src/features/activity/activity.ts` |
| `src/useActivity.ts` | `src/features/activity/useActivity.ts` |
| `src/WorkspaceActivity.tsx` | `src/features/activity/WorkspaceActivity.tsx` |
| `src/workspace-activity.css` | `src/features/activity/workspace-activity.css` |
| `src/views.ts` | `src/features/views/views.ts` |
| `src/ViewsTab.tsx` | `src/features/views/ViewsTab.tsx` |
| `src/views-tab.css` | `src/features/views/views-tab.css` |
| `src/views-tab-model.ts` | `src/features/views/views-tab-model.ts` |
| `src/views-text.ts` | `src/features/views/views-text.ts` |
| `src/views-database.ts` | `src/features/views/views-database.ts` |
| `src/sequence-events.ts` | `src/features/views/sequence-events.ts` |
| `src/infra/catalog.ts` | `src/features/views/infra/catalog.ts` |
| `src/infra/icons.ts` | `src/features/views/infra/icons.ts` (its `../assets/...` glob still resolves) |
| `src/assets/infra-icons/**` (151 SVGs, `aws/`, `azure/`, `gcp/`) | `src/features/views/assets/infra-icons/**` (one `git mv` of the folder) |
| `src/views-ui/DiagnosticsDrawer.tsx` | `src/features/views/views-ui/DiagnosticsDrawer.tsx` |
| `src/views-ui/EditorPicker.tsx` | `src/features/views/views-ui/EditorPicker.tsx` |
| `src/views-ui/ErDiagram.tsx` | `src/features/views/views-ui/ErDiagram.tsx` |
| `src/views-ui/FlowDiagram.tsx` | `src/features/views/views-ui/FlowDiagram.tsx` |
| `src/views-ui/FlowEdge.tsx` | `src/features/views/views-ui/FlowEdge.tsx` |
| `src/views-ui/FlowNode.tsx` | `src/features/views/views-ui/FlowNode.tsx` |
| `src/views-ui/Inspector.tsx` | `src/features/views/views-ui/Inspector.tsx` |
| `src/views-ui/SaveViewDialog.tsx` | `src/features/views/views-ui/SaveViewDialog.tsx` |
| `src/views-ui/SequenceDiagram.tsx` | `src/features/views/views-ui/SequenceDiagram.tsx` |
| `src/views-ui/TableNode.tsx` | `src/features/views/views-ui/TableNode.tsx` |
| `src/views-ui/TablesPopover.tsx` | `src/features/views/views-ui/TablesPopover.tsx` |
| `src/views-ui/TextViewFallback.tsx` | `src/features/views/views-ui/TextViewFallback.tsx` |
| `src/views-ui/elk-client.ts` | `src/features/views/views-ui/elk-client.ts` |
| `src/views-ui/er-diagram.css` | `src/features/views/views-ui/er-diagram.css` |
| `src/views-ui/er-diff.ts` | `src/features/views/views-ui/er-diff.ts` |
| `src/views-ui/er-filter.ts` | `src/features/views/views-ui/er-filter.ts` |
| `src/views-ui/er-layout.ts` | `src/features/views/views-ui/er-layout.ts` |
| `src/views-ui/flow-diagram.css` | `src/features/views/views-ui/flow-diagram.css` |
| `src/views-ui/flow-layout.ts` | `src/features/views/views-ui/flow-layout.ts` |
| `src/views-ui/sequence-diagram.css` | `src/features/views/views-ui/sequence-diagram.css` |
| `src/views-ui/sequence-layout.ts` | `src/features/views/views-ui/sequence-layout.ts` |
| `src/views-ui/types.ts` | `src/features/views/views-ui/types.ts` |
| `src/db-schema.ts` | `src/features/db-schema/db-schema.ts` |
| `src/live-view.ts` | `src/features/runtime/live-view.ts` |
| `src/LiveView.tsx` | `src/features/runtime/LiveView.tsx` |
| `src/live-view.css` | `src/features/runtime/live-view.css` |
| `src/BrowserPane.tsx` | `src/features/runtime/BrowserPane.tsx` |
| `src/WorkspacePortsChip.tsx` | `src/features/runtime/WorkspacePortsChip.tsx` |
| `src/workspace-ports.css` | `src/features/runtime/workspace-ports.css` |
| `src/workspace-status.ts` | `src/features/runtime/workspace-status.ts` (port/container matching, despite the name) |
| `src/useWorkspacePorts.ts` | `src/features/runtime/useWorkspacePorts.ts` |
| `src/project-home.prototype.{tsx,css,html}` | deleted in step 2 |

#### tests/

| Feature folder | Files moved into it |
|---|---|
| `tests/app/` | `database.test.ts`, `editors.test.ts`, `project-navigation.test.ts`, `desktop.mjs`, `launch.mjs`, `package-launch.mjs`, `contracts.test.ts` (step 3), `single-instance.mjs` (step 1), new `import-boundaries.test.ts` |
| `tests/shared/` | `highlight.test.ts` |
| `tests/agents/` | `hook-client.test.ts`, `pi-observer.test.ts`, `pi-smoke.ts` |
| `tests/git/` | `git.test.ts`, `git-state.test.ts`, `git-lines.test.ts`, `git-exclude.test.ts`, `clone.test.ts`, `worktree-removal.test.ts`, `pull-requests.test.ts`, `pull-requests.mjs`, `worktree-removal.mjs`, `add-project.mjs` |
| `tests/repo-map/` | `repo-map.test.ts`, `repo-map.mjs` |
| `tests/terminals/` | `terminal-links.test.ts`, `terminal-mirror.test.ts`, `terminal-links.mjs` |
| `tests/activity/` | `activity.test.ts`, `activity-shell.test.ts`, `activity-history.test.ts`, `pi-activity.mjs`, `verify-activity.mjs` |
| `tests/codegraph/` | `codegraph.test.ts`, `codegraph-process.test.ts`, `codegraph-overlay.test.ts`, `codegraph-engine.test.ts` |
| `tests/views/` | `views.test.ts`, `view-service.test.ts`, `view-state.test.ts`, `view-file.test.ts`, `views-cli.test.ts`, `views-tab-model.test.ts`, `save-view.test.ts`, `launcher.test.ts`, `rules-engine.test.ts`, `rules-schema.test.ts`, `rule-files.test.ts`, `graph-steps.test.ts`, `callees.test.ts`, `codegraph-api.test.ts`, `layers.test.ts`, `explain.test.ts`, `explanation.test.ts`, `explanation-title.test.ts`, `flowchart.test.ts`, `flowchart-labels.test.ts`, `flow-layout.test.ts`, `er-diff.test.ts`, `er-filter.test.ts`, `er-layout.test.ts`, `sequence.test.ts`, `sequence-links.test.ts`, `sequence-layout.test.ts`, `sequence-helpers.ts`, `sets-builtin.test.ts`, `langgraph-routers.test.ts`, `text-diagram.test.ts`, `infra-catalog.test.ts`, `views-tab.mjs` |
| `tests/db-schema/` | `db-schema.test.ts`, `sql-schema.test.ts`, `sql-ddl.test.ts` |
| `tests/runtime/` | `ports.test.ts`, `live-view.test.ts`, `workspace-status.test.ts`, `workspace-status.mjs` |
| `tests/fixtures/` | stays |

Rule: a test goes to the feature of the code it tests (`codegraph-api.test.ts` tests
`electron/views/rules/codegraph-api.ts`, so it goes to views).

### Public `index.ts`

- One per feature folder per process (`electron/features/<x>/index.ts`, `src/features/<x>/index.ts`), re-exporting
  exactly what other features and `app/` import today (named re-exports, no `export *`). `electron/views/index.ts`
  already exists and grows.
- Expected cross-feature exports (derived from today's imports; the boundary test is the final word):
  - git: `GitService`, `GitStateService`, `PullRequestService`, `git` (runner), `excludeCodeGraphCache`.
  - repo-map: `repoSnapshot`, `inspectFile`, `inventoryGit`.
  - activity: `ActivityService`, `ActivityShell`, `ActivityHistory`, `shellQuote`.
  - views: `ViewService`, `installLauncher`, `saveViewAs`, `ViewStateStore`, plus for codegraph: `graph` types,
    `rules/types`, `evaluate` (engine), `grammars`, `createFileProvider`, `createGraphApi`, callees helpers.
  - db-schema: `extractDbSchema`, `extractSqlSchema`.
  - codegraph: `createCodeGraphProcessHost`, settings functions.
  - terminals: `Terminals`, `openTerminalLink`. runtime: `PortService`, `ContainerService`, `LiveViews`, `inspectCdp`.
  - renderer: each feature exports its top components/hooks used by `App.tsx`, e.g. `RepoMap`, `TerminalPane`,
    `ViewsTab`, `WorkspaceStatus`, `useGitState`, `useActivity`, `LiveView`, `BrowserPane`, `WorkspacePortsChip`.

### Import-boundary test

`tests/app/import-boundaries.test.ts` (node:test, no new dependency):

- Walk `electron/`, `src/`, `agents/` for `.ts`/`.tsx`. Extract specifiers with a regex over
  `import … from '…'`, `export … from '…'`, `import '…'` and `import('…')`. Resolve relative specifiers to a file
  (try `.ts`, `.tsx`, `/index.ts`, `/index.tsx`, exact for `.css`/`.wasm`).
- Classify each file: `app` (`electron/app`, `src/app`), `shared` (`src/shared`, `electron/shared`), `agents`,
  or `feature:<x>` (`electron/features/<x>`, `src/features/<x>`).
- Rules (umbrella "Boundaries"): same feature → ok; other feature → target must be that feature's `index.ts` in the
  same process or `src/features/<y>/contract.ts`; `shared` → only `shared` and packages; `app` → any feature's
  `index.ts`/`contract.ts`; features → app only `electron/app/database.ts` and `src/app/api.ts`.
- The failure message lists `file:line → target (rule)`.
- A self-check case: a fixture list of (from, to, allowed?) pairs run through the classifier, so the test itself
  is tested.

### Build, config, scripts

- `scripts/build-electron.mjs`: entry points as an object so output names stay flat:
  `{ main: 'electron/app/main.ts', preload: 'electron/app/preload.ts', 'codegraph-worker': 'electron/features/codegraph/codegraph-worker.ts', 'views-cli': 'electron/features/views/views-cli.ts' }`;
  wasm copy from `electron/features/db-schema/tree-sitter-python.wasm`. `dist-electron/` layout unchanged.
- `package.json`: `"test": "tsx --test \"tests/**/*.test.ts\""` (quoted; Node 24's test runner expands the glob);
  `test:*` scripts point at the new `.mjs` paths.
- `tsconfig.json`: include `tests/**/*.ts`.
- `index.html`: `/src/app/main.tsx`.
- `scripts/run-e2e.mjs`: `const suites = { desktop: 'app', 'repo-map': 'repo-map', … }` and run
  `tests/${suites[suite]}/${suite}.mjs`; `--list` prints the keys. Same suite names as before.
- `tests/verify-activity.mjs`: recursive `readdir('tests', { recursive: true })` for unit files; update the `.mjs` paths.
- Path strings in moved tests: `codegraph-process.test.ts:16` → new worker path; `infra-catalog.test.ts:8` →
  `../../src/features/views/assets/infra-icons`; `langgraph-routers.test.ts:14`, `sets-builtin.test.ts:13` →
  `../fixtures/views`; `views-tab.mjs:36` → `../fixtures/...`.
- `agents/skills/stingray-views/SKILL.md:91` → new catalog path.
- vite: no change expected (root stays the repo; `index.html` path updated).

### Order inside the commit

Move, fix imports until `npm run typecheck` passes, add `index.ts` files and switch cross-feature imports to them,
add the boundary test, update build/test config, run everything. One commit.

## Acceptance criteria

- [ ] `ls electron` shows only `app/`, `features/` (and `shared/` from step 7 later); `ls src` shows only `app/`,
      `features/`, `shared/`.
- [ ] Every row of the tables above is done; `git log --follow` works on a moved file.
- [ ] `git diff -M --stat` for this commit shows renames with only import/path-line edits; no other lines changed
      (reviewer check: `git diff -M` shows no non-import hunks except new `index.ts` files, config and path strings).
- [ ] `dist-electron/` file names unchanged after `npm run build` (`ls dist-electron` before/after identical).
- [ ] `tests/app/import-boundaries.test.ts` passes and fails when a deliberate bad import is added (checked once by hand).
- [ ] `npm test` runs all 60+ unit test files (count printed by node:test equals before + new tests).

## Verification

```
npm run check
npm run test:e2e            # all suites, same names
node scripts/run-e2e.mjs --list
ls dist-electron            # compare with pre-move listing
```

## Risks & rollback

- **Cycles through barrels.** `git` ↔ `repo-map` and `views` ↔ `db-schema` ↔ `codegraph` become cycles between
  `index.ts` files. esbuild handles ESM cycles, but a top-level value read before its module initialised
  (TDZ) would crash at startup. Mitigation: named re-exports only, run the built app (e2e) in this step. If a
  cycle bites, the fix is a design decision (see open questions), not a silent move.
- Missed path strings show up as test failures, not silent behaviour change.
- Rollback: revert the commit; no data touched.

## Open questions

- If a barrel cycle breaks startup, which way to cut it? Proposal: move `rules/grammars.ts` (used by views,
  db-schema, codegraph) and the git runner into `electron/shared/` in this step instead of step 7.
- `WorkspaceStatus.tsx` mixes git and activity UI; placed in git (it is the branch/PR card). Confirm.
- `src/workspace-status.ts` keeps its misleading name to keep the move behaviour-free; rename later if wanted.
