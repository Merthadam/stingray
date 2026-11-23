# Modular restructure — umbrella design

Status: draft (decisions final)

Step specs:

1. [Dev tooling](2026-11-23-01-dev-tooling-design.md)
2. [Dead code](2026-11-23-02-dead-code-design.md)
3. [IPC contracts](2026-11-23-03-ipc-contracts-design.md)
4. [Hexagonal modules](2026-11-23-04-hexagonal-modules-design.md) (moves, per-feature extraction, boundary + cycle tests)
5. [Composition root](2026-11-23-05-composition-root-design.md)
6. [Repo map sync](2026-11-23-06-repo-map-sync-design.md)
7. [Audit fixes](2026-11-23-07-audit-fixes-design.md)

## Goal

Make Stingray easy to navigate and change by feature, with one logic layer that everything connects to
(hexagonal architecture):

- `electron/core/<feature>/`: pure logic plus port interfaces. No Node built-ins, no Electron, no native packages,
  no adapters. Unit-tested with fake adapters.
- `electron/adapters/driving/` (IPC, CLI, agent hooks) call core; `electron/adapters/driven/` implement core's ports
  (git, file system, PTY, Docker, SQLite, CodeGraph worker, Electron shell, tree-sitter, processes, CDP).
- `electron/app/`: the composition root. `electron/main.ts` is a thin entry that calls it.
- `shared/contracts/<feature>.ts`: zod contracts for every IPC call and event, imported by both processes; preload
  and the `DesktopAPI` type are derived from them.
- `src/features/<feature>/` mirrors the backend feature names; `src/app/` is the shell; `src/shared/` generic UI.
- One Git-state clock that the sidebar and Repo Map share; the open audit findings fixed, each with a test.
- Failures stay inside the feature and entry point where they happen (failure-isolation rules, step 4).

## Non-goals

- No new product features or UI redesign. Behaviour changes are limited to the listed audit fixes, the repo-map
  sync, the IPC error envelope (step 3) and the demo/bridge rule (step 3).
- No ESLint, no new runtime dependencies, no new test framework (node:test + Playwright stay).
- `agents/` stays top-level; only its import paths change.
- No packaging or signing changes. CI changes: the double typecheck and the `pi-activity` suite (step 7).

## Delivery

One branch and one PR: `chore/modular-restructure`. Commits in this order; every commit passes `npm run check`.

| # | Commit | Spec | Behaviour |
|---|---|---|---|
| 1 | Dev tooling (audit 1, 2, 8) | [01](2026-11-23-01-dev-tooling-design.md) | dev only |
| 2 | Dead code (audit 17) | [02](2026-11-23-02-dead-code-design.md) | none |
| 3 | IPC contracts in `shared/contracts/`, per-feature demos (audit 7, 19) | [03](2026-11-23-03-ipc-contracts-design.md) | error envelope, demo rule |
| 4 | Moves into the hex layout (`git mv` + import/path edits only) | [04 § Moves](2026-11-23-04-hexagonal-modules-design.md#commit-4--moves) | none; existing tests unchanged apart from paths |
| 5 | One extraction commit per feature: git, activity, terminals, codegraph, repo-map, views, db-schema, runtime | [04 § Extraction](2026-11-23-04-hexagonal-modules-design.md#commit-5--per-feature-extraction) | audit fixes that belong to the feature ([07](2026-11-23-07-audit-fixes-design.md#where-each-fix-lands)) |
| 6 | Composition root, thin `main.ts` | [05](2026-11-23-05-composition-root-design.md) | audit 20 |
| 7 | Repo map sync (audit 12) | [06](2026-11-23-06-repo-map-sync-design.md) | yes |
| 8 | Remaining audit fixes | [07](2026-11-23-07-audit-fixes-design.md) | yes |
| 9 | Strict boundary + cycle tests, no allow-list | [04 § Boundary](2026-11-23-04-hexagonal-modules-design.md#commit-9--boundary-and-cycle-tests) | none |
| 10 | Docs: README, `STATUS.md`, `docs/archive/` (audit 18) | [07 § 18](2026-11-23-07-audit-fixes-design.md#finding-18--readme) | none |

Order rules: dead routes are deleted before they get contracts (2 before 3); contracts are written once at their
final path (3 before 4); moves are separate from logic changes (4 before 5); extraction lands code directly in core
and adapters, so the composition root only wires (5 before 6); the boundary test goes strict once nothing violates
it (9 last among code commits).

## Final folder tree

```
shared/                         imported by electron/, src/ and agents/; imports nothing from them
  contracts/
    define.ts                   defineContract, returns<T>(), event<T>(), Invoke/Events types, IpcResult envelope
    common.ts                   idSchema, urlSchema
    index.ts                    list of all contracts + DesktopAPI
    app.ts git.ts repo-map.ts terminals.ts activity.ts codegraph.ts views.ts db-schema.ts runtime.ts
  views/                        pure code both processes run: infra/catalog.ts, views-text.ts, sequence-events.ts, views-database.ts
electron/
  main.ts                       thin entry: start the app
  app/                          composition root
    index.ts                    start(): data dir, single-instance lock, whenReady, compose, window
    compose.ts                  builds driven adapters, core services, lifecycle listeners, registers IPC
    window.ts                   BrowserWindow, webview hardening, close guard, second-instance focus
    ipc.ts                      the single handle(): trusted-sender check, zod parse, error envelope
    views-cli.ts                process entry of the stingray-views CLI (wires driving/cli)
    codegraph-worker.ts         process entry of the CodeGraph worker (wires its adapters)
    wiring/<feature>.ts         core + real adapters behind the names existing tests and compose.ts use
  core/
    shared/                     posix-path.ts, ports.ts (Hasher, GlobMatcher)
    app/                        editors (settings + open-source logic)
    git/                        workspaces/repositories store, GitService, GitStateService, worktree removal,
                                workspace lifecycle, pull requests, clone lock, line stats parsing
    activity/                   ActivityService, history, harnesses, visibility
    terminals/                  Terminals registry, flow control, link resolution, link opener
    codegraph/                  settings, restart policy, GraphHost port
    repo-map/                   snapshot assembly, sizes, inspect
    views/                      rules engine, compute, flowchart, sequence, sets, explain, view files, view state
    db-schema/                  SQLAlchemy + SQL extraction on syntax trees, sql-ddl
    runtime/                    ports, containers, live view, Chrome inspect
      (each: index.ts public API, ports.ts port interfaces, logic files)
  adapters/
    driving/
      ipc/                      preload.ts (built from contracts), <feature>.ts handler objects
      cli/                      views-cli.ts
      hooks/                    activity-socket.ts (agent hook socket)
    driven/
      git/                      runner.ts (one runner, GIT_SAFE_CONFIG), clone, gh, .git watcher, exclude
      fs/                       walk.ts (the one walker), file reads/writes, launcher files, shell integration, glob, hash
      pty/                      node-pty spawner, headless mirror, serializer
      docker/                   docker CLI runner
      process/                  ps/lsof, `open -a`, editor spawn
      cdp/                      live-view fetch + CDP WebSocket
      sqlite/                   database.ts (node:sqlite) + repositories (state, view state, history, settings)
      codegraph-worker/         process host (fork), serve, overlay, graph api
      electron-shell/           dialogs, shell, clipboard, sessions, webContents sender
      tree-sitter/              grammars.ts, SyntaxParser, tree-sitter-python.wasm
src/
  app/                          main.tsx, App.tsx, api.ts, demo.ts (assembly), ProjectHome, project-navigation, app CSS
  shared/                       Modal.tsx, highlight.ts, prism.d.ts
  features/<feature>/           components, hooks, demo.ts (fake adapter typed against shared/contracts), index.ts
agents/                         unchanged location; imports only shared/
tests/
  <feature>/                    unit tests (core with fakes), adapter tests, e2e .mjs of that feature
  app/ shared/ agents/          app shell, shared UI, agent clients
  architecture/                 import-boundaries.test.ts, core-cycles.test.ts
  fakes/<feature>.ts            fake adapters used by core unit tests
  fixtures/                     unchanged
docs/specs/                     these specs; docs/archive/ for retired plans
```

Exact file-to-destination tables are in [step 4](2026-11-23-04-hexagonal-modules-design.md#commit-4--moves).

## Features

| Feature | Core | Renderer | Contract (calls, events) |
|---|---|---|---|
| app | `electron/core/app/`, `electron/app/` | `src/app/` | state, preview, editorSettings, setEditor, openSource |
| git | `core/git/` | `src/features/git/` | pickRepository, openRepository, pickCloneParent, cloneRepository, createWorkspace, reviewRemoval, removeWorkspace, gitState, refreshGitState, selectWorkspace (step 6); event onStatusChanged |
| repo-map | `core/repo-map/` | `src/features/repo-map/` | repoSnapshot, inspectFile, statFile (step 6) |
| terminals | `core/terminals/` | `src/features/terminals/` | terminals, terminalSnapshot, createTerminal, writeTerminal, openTerminalLink, resizeTerminal, closeTerminal; event onTerminal |
| activity | `core/activity/` | `src/features/activity/` | activity, activityView, acknowledgeActivity, dismissActivity; event onActivity |
| codegraph | `core/codegraph/` | `src/features/codegraph/` (demo + index) | codegraphSettings, setCodegraphSharedBase, codegraphConflicts |
| views | `core/views/` | `src/features/views/` | views, view, viewState, saveViewState, saveViewAs, openServiceDocs; event onViewsChanged |
| db-schema | `core/db-schema/` | `src/features/db-schema/` (demo data + index) | none (types only; route removed in step 2) |
| runtime | `core/runtime/` | `src/features/runtime/` | containers, stopContainer, containerLogs, inspectCdp, ports, liveViewStart, liveViewInput, liveViewResize, liveViewStop, liveViewAck; event onLiveView |

Channels are `<feature>.<member>` (e.g. `git.createWorkspace`, `terminals.onTerminal`, `git.onStatusChanged`).
The renderer API stays flat (`window.stingray.createWorkspace`), so existing e2e calls keep working.

## Architecture rules (summary)

Full rules and tests in [step 4](2026-11-23-04-hexagonal-modules-design.md).

- Core imports only core and `shared/`, plus the pure packages `zod` and `yaml` at runtime; type-only imports from
  any package are allowed (erased at build). Core features import each other only via `index.ts`, one-way, no cycles.
- Back-edges (e.g. features reacting to workspace create/remove) go through ports and listeners, not imports.
- Driving adapters call core; driven adapters implement ports; neither imports the other; only `electron/app/`
  imports adapters.
- `shared/` imports nothing from `electron/`, `src/`, `agents/`. `src/` never imports `electron/`.
- Failure isolation: one error boundary per driving entry; degraded results across features; lifecycle listeners
  run independently (only "terminals closed" may block removal); crash-prone parsing runs in the worker process.

## Done bar (whole PR)

- [ ] `npm run check` passes (typecheck, build, unit tests).
- [ ] All e2e suites pass, including `pi-activity` (`npm run test:e2e`).
- [ ] All existing tests pass unchanged. Allowed edits: import paths and fixture/entry path strings (step 4), raw
      IPC channel names (step 3), and the assertion replacements listed in the PR description (old vs new, each at
      least as strict). No existing test is deleted or weakened.
- [ ] New tests: audit 3, 4, 5, 7, 9, 13, 15; core unit tests with fake adapters for every feature; one
      failure-isolation test per rule; boundary and cycle tests (strict, no allow-list).
- [ ] Docker smoke: `scripts/test-env.sh up --detach`, then through CDP: open a repo, create a worktree, open a
      terminal, check Repo Map change count and sidebar `+/−` counts match, remove the worktree;
      `scripts/test-env.sh down --all`.
- [ ] CI green on the PR (`gh pr checks --watch`); `pi-activity` runs non-blocking on macOS and Linux.
- [ ] PR URL reported.
- [ ] `git status` clean of `release/`, `artifacts/`, `dist*/`.

## Decisions

- **Architecture: hexagonal.** `electron/core/<feature>/` (pure logic + ports), `electron/adapters/driving/{ipc,cli,hooks}/`,
  `electron/adapters/driven/{git,fs,pty,docker,process,cdp,sqlite,codegraph-worker,electron-shell,tree-sitter}/`,
  `electron/app/` composition root, thin `electron/main.ts`.
- **App layer (OQ1):** `electron/app/` + `src/app/`; app-level logic that needs ports lives in `electron/core/app/`.
- **Contracts (H1, OQ10):** top-level `shared/contracts/<feature>.ts`; calls `feature.action`, events `feature.onThing`.
- **Renderer (H2, OQ11):** `src/features/<feature>/` mirrors backend names; cross-feature imports via `index.ts`;
  `WorkspaceStatus.tsx` goes to `src/features/git`.
- **Demo (H3):** per-feature `demo.ts` typed against the contracts; demo only in a plain browser or with `?demo`;
  inside Electron a missing bridge is a visible error.
- **Depth (Hex-B):** full extraction in this PR, staged as in the delivery table.
- **Dependencies and failure isolation (OQ7 A):** one-way core imports with a cycle test; back-edges via ports and
  listeners; the four isolation rules, each with an "X fails, Y still works" test.
- **Tests (OQ3):** replaced assertions only if listed old-vs-new in the PR description and at least as strict.
- **Removal identity (OQ4):** kept; the upstream tip is part of the removal consent fingerprint.
- **pi-activity (OQ5):** in CI, non-blocking on macOS and Linux, documented in `docs/ci.md`.
- **Walker (OQ6):** one walker, union of skip lists, 200 000 list limit, 5000 parse cap, sorted results.
- **Repo map (OQ8):** one git-state poller; Repo Map reloads on revision bump; cheap 5 s check of the open file.
- **`npm start` (OQ9):** full build incl. `tsc` typecheck, then launch.
- **Core purity details:** `node:path` replaced by `core/shared/posix-path.ts`; glob matching and sha256 through
  ports; ids via `globalThis.crypto.randomUUID()`; tree-sitter runtime behind a `SyntaxParser` port.
- **Extra driven adapters:** `driven/process/` (ps/lsof, `open -a`, editor spawn) and `driven/cdp/` (live view);
  clipboard/dialogs/session/shell in `electron-shell`; xterm headless mirror in `pty`.
