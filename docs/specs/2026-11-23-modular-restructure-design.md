# Modular restructure — umbrella design

Status: draft

Step specs (one commit each, in this order):

1. [Dev tooling](2026-11-23-01-dev-tooling-design.md)
2. [Dead code](2026-11-23-02-dead-code-design.md)
3. [IPC contracts](2026-11-23-03-ipc-contracts-design.md)
4. [Feature modules](2026-11-23-04-feature-modules-design.md)
5. [Slim main](2026-11-23-05-slim-main-design.md)
6. [Repo map sync](2026-11-23-06-repo-map-sync-design.md)
7. [Audit fixes](2026-11-23-07-audit-fixes-design.md)

## Goal

Make the Stingray repo easy to navigate and change by feature:

- one folder per feature, in both processes (`electron/features/<x>/`, `src/features/<x>/`), each with a public `index.ts`;
- one typed IPC contract per feature that main, preload, the renderer API type and the browser demo all derive from;
- a `main.ts` that only starts the app and wires services together;
- a single Git-state clock that the sidebar and Repo Map share;
- the open audit findings fixed, each with a test where it can be tested.

## Non-goals

- No new product features, UI redesign or behaviour changes other than the listed audit fixes and the repo-map sync.
- No ESLint, no new runtime dependencies, no new test framework (node:test + Playwright stay).
- No split of `src/shared.ts` domain types into features (it moves whole; see step 4).
- No change to `agents/` beyond import paths (it stays top-level).
- No packaging, signing or CI-pipeline redesign (only the double typecheck and the `pi-activity` suite are touched).

## Delivery

One branch and one PR: `chore/modular-restructure`. Seven commits in the order above. Every commit must pass
`npm run check`; steps 4 and 5 must also pass all e2e suites, because they claim no behaviour change.

Rules for the order:

- Step 2 runs before step 3 so dead routes are not given contracts.
- Step 3 runs before step 4 so contracts are written once, then moved with their feature.
- Step 4 (moves) is behaviour-free: only `git mv` plus import-path, build-entry, glob and path-string edits.
  Tests pass unchanged apart from import paths and paths to fixtures/entry files.
- Step 5 runs after step 4 so extracted services land directly in their feature folder.
- Steps 6 and 7 change behaviour and add tests.

## Final folder map

```
electron/
  app/                 startup and composition root (the "app" feature on the main side)
    main.ts            startup + wiring only (step 5)
    preload.ts         builds window.stingray from contracts (step 3)
    ipc.ts             the single handle() with the trusted-sender check (step 3)
    window.ts          BrowserWindow, webview hardening, close guard (step 5)
    store.ts, database.ts, editors.ts
  shared/              Node-only helpers used by several features (git runner, file walker; step 7)
  features/
    git/               git, git-state, git-lines, git-exclude, clone, worktree-removal, pull-requests
    repo-map/          repo-map, repo-map-size
    terminals/         terminals, terminal-mirror, terminal-serialize, terminal-links
    activity/          activity, activity-shell, activity-history, harnesses
    codegraph/         codegraph, codegraph-process, codegraph-worker, codegraph-overlay, codegraph-settings
    views/             today's electron/views/**, view-state, views-cli (save-view is already in views/)
    db-schema/         db-schema, sql-schema, sql-ddl, tree-sitter-python.wasm
    runtime/           ports, containers, live-view, chrome-inspect
src/
  app/                 main.tsx, App.tsx, api.ts, desktop-api.ts, demo.ts, ProjectHome, project-navigation, app CSS
  shared/              index.ts (today's shared.ts), Modal.tsx, highlight.ts, prism.d.ts
  features/<x>/        same feature names as electron/features, plus contract.ts, demo.ts, index.ts
agents/                unchanged location
tests/<feature>/       tests mirrored by feature; tests/app/, tests/shared/, tests/agents/; tests/fixtures/ stays
docs/specs/            these specs; docs/archive/ for retired plans (step 7, finding 18)
```

The exact file-to-destination table is in the step 4 spec.

## Features

| Feature | Main side | Renderer side | Contract routes (step 3) |
|---|---|---|---|
| app | `electron/app/` | `src/app/` | state, preview, editorSettings, setEditor, openSource |
| git | `electron/features/git/` | `src/features/git/` | pickRepository, openRepository, pickCloneParent, cloneRepository, createWorkspace, reviewRemoval, removeWorkspace, gitState, refreshGitState, selectWorkspace (step 6), event onGitStateChanged |
| repo-map | `electron/features/repo-map/` | `src/features/repo-map/` | repoSnapshot, inspectFile |
| terminals | `electron/features/terminals/` | `src/features/terminals/` | terminals, terminalSnapshot, createTerminal, writeTerminal, openTerminalLink, resizeTerminal, closeTerminal, event onTerminal |
| activity | `electron/features/activity/` | `src/features/activity/` | activity, activityView, acknowledgeActivity, dismissActivity, event onActivity |
| codegraph | `electron/features/codegraph/` | `src/features/codegraph/` (contract + demo only) | codegraphSettings, setCodegraphSharedBase, codegraphConflicts |
| views | `electron/features/views/` | `src/features/views/` | views, view, viewState, saveViewState, saveViewAs, openServiceDocs, event onViewsChanged |
| db-schema | `electron/features/db-schema/` | `src/features/db-schema/` (types only) | none (the `db-schema` route is removed in step 2) |
| runtime | `electron/features/runtime/` | `src/features/runtime/` | containers, stopContainer, containerLogs, inspectCdp, ports, liveViewStart, liveViewInput, liveViewResize, liveViewStop, liveViewAck, event onLiveView |

## Boundaries

Enforced by `tests/app/import-boundaries.test.ts` (step 4), which scans `electron/`, `src/` and `agents/`:

- Inside a feature, any import is allowed. `electron/features/<x>` and `src/features/<x>` count as the same feature.
- Another feature is reached only through its `index.ts` (same process) or `src/features/<y>/contract.ts` (from the
  other process, or from `agents/`).
- `src/shared/` and `electron/shared/` import no feature and no app code.
- `electron/app/` and `src/app/` may import any feature's `index.ts` or `contract.ts`, never feature internals.
- Features may import exactly two app files: `electron/app/database.ts` (settings/history tables) and
  `src/app/api.ts` (the renderer bridge). The test holds this allowlist; growing it needs a reviewed edit.
- Type-only imports follow the same rules.

## Done bar (whole PR)

- [ ] `npm run check` passes (typecheck, build, unit tests).
- [ ] All e2e suites pass on macOS: `npm run test:e2e` with `pi-activity` added to the suite list.
- [ ] No existing test deleted or weakened. Where a test has to change because behaviour changed on purpose
      (step 6 repo-map polling, step 7 finding 5, step 3 channel names), the PR description lists each changed
      assertion and why it is not weaker.
- [ ] New tests exist for findings 3, 4, 5, 7 (import boundaries/contracts), 9, 13, 15 and for the repo-map sync.
- [ ] Docker smoke: `scripts/test-env.sh up --detach`, then through CDP: open a repo, create a worktree, open a
      terminal, check Repo Map change count and sidebar `+/−` counts match, remove the worktree;
      `scripts/test-env.sh down --all`.
- [ ] CI green on the PR (`gh pr checks --watch`).
- [ ] PR URL reported.
- [ ] `git status` clean of `release/`, `artifacts/`, `dist*/`.

## Open questions (cross-step)

- **Meaning of the "app" feature.** These specs read it as `electron/app/` + `src/app/` (composition root plus
  app-level services). There is no `electron/features/app/`. Confirm.
- **`electron/shared/`.** Not in the agreed map, but the shared git runner and file walker (step 7, findings 6
  and 16) are used by several features and must not live in a feature or in `app/`. These specs add
  `electron/shared/`. Confirm, or name another home.
- **Tests that change on purpose.** Several existing assertions conflict with agreed changes (listed in steps 3,
  6 and 7). The done bar says "no test weakened"; these specs re-target them instead. Confirm that is acceptable.
