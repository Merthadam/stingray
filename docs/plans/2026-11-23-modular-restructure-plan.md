# Modular restructure — implementation plan index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):**
> - The executor runs the plans **sequentially, one plan at a time**, in the order below; a plan starts only after the previous plan's commit exists.
> - **Every commit passes `npm run check`** (typecheck, build, unit tests) and the plan's e2e gate.
> - **Never edit or delete an existing test assertion except those the spec lists.** Allowed edits to existing tests: import paths, fixture/entry path strings (plan 04), raw IPC channel names (plan 03), and the listed replacements. Every non-path test edit is recorded, old vs new, in [`2026-11-23-test-edit-ledger.md`](2026-11-23-test-edit-ledger.md) (created by plan 01) in the same commit.
> - Branch `chore/modular-restructure` (already checked out). No push and no PR before the "Done bar" below. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`. Do not replace the installed app.

**Goal:** deliver the approved modular restructure ([umbrella spec](../specs/2026-11-23-modular-restructure-design.md)) as one PR of
ordered, individually green commits: hexagonal `electron/` (core + ports, driving/driven adapters, composition root),
zod contracts in `shared/contracts/`, per-feature renderer folders, one Git clock for sidebar and Repo Map, the open
audit fixes with tests, strict boundary and cycle tests, short docs.

**Architecture:** see the umbrella spec "Final folder tree" and [spec 04 § Layers and rules](../specs/2026-11-23-04-hexagonal-modules-design.md#layers-and-rules).

**Tech Stack:** Electron 45, React 19, TypeScript 7, zod 4, esbuild, Vite, node:test (`tsx --test`), Playwright e2e, GitHub Actions.

---

## Order, dependencies, commits, gates

| # | Plan | Depends on | Commit message | Gate (besides `npm run check`) |
|---|---|---|---|---|
| 1 | [01 dev tooling](2026-11-23-01-dev-tooling-plan.md) | — | `chore(dev): separate dev data dir, watch+restart, fresh npm start, loud single-instance failure` | `node tests/launch.mjs`; `node tests/single-instance.mjs`; manual `npm run dev` checks |
| 2 | [02 dead code](2026-11-23-02-dead-code-plan.md) | 01 | `chore: remove dead db-schema route, project-home prototype and PullRequestService.status` | `npm run test:e2e -- desktop pull-requests worktree-removal views-tab` |
| 3 | [03 IPC contracts](2026-11-23-03-ipc-contracts-plan.md) | 02 | `feat(ipc): zod contracts in shared/contracts drive main, preload, DesktopAPI and per-feature demos` | `npm run test:e2e` (all) + manual bridge/demo checks |
| 4 | [04 moves](2026-11-23-04-moves-plan.md) | 03 | `refactor: move files into the hexagonal layout (git mv + paths only; codegraph feature renamed stinggraph)` | `npm run test:e2e` (all); same unit count; same `dist-electron` listing; same suite list |
| 5a | [05a git](2026-11-23-05a-git-extraction-plan.md) | 04 | `refactor(git): extract git core behind ports; one git runner; removal consent fingerprint` | `npm run test:e2e -- worktree-removal add-project pull-requests desktop repo-map` |
| 5b | [05b activity](2026-11-23-05b-activity-extraction-plan.md) | 05a | `refactor(activity): pure activity core, socket driving adapter; keep long Claude turns working` | `npm run test:e2e -- desktop terminal-links worktree-removal`; `node tests/activity/pi-activity.mjs` |
| 5c | [05c terminals](2026-11-23-05c-terminals-extraction-plan.md) | 05b | `refactor(terminals): pure terminals core; PTY flow control; lifecycle tests; unique titles` | `npm run test:e2e -- terminal-links desktop worktree-removal` |
| 5d | [05d stinggraph](2026-11-23-05d-stinggraph-extraction-plan.md) | 05c | `refactor(stinggraph): restart policy, workspace release with kill fallback, overlay cleanup` | `npm run test:e2e -- views-tab worktree-removal desktop` |
| 5e | [05e repo-map](2026-11-23-05e-repo-map-extraction-plan.md) | 05d | `refactor(repo-map): RepoMapService in core behind inventory and working-file ports` | `npm run test:e2e -- repo-map desktop workspace-status` |
| 5f | [05f views](2026-11-23-05f-views-extraction-plan.md) | 05e | `refactor(views): pure views core behind ports; one file walker; engine listing guard` | `npm run test:e2e -- views-tab desktop`; `node dist-electron/views-cli.cjs --version` |
| 5g | [05g db-schema](2026-11-23-05g-db-schema-extraction-plan.md) | 05f | `refactor(db-schema): schema extraction on syntax trees; parsing in the worker process` | `npm run test:e2e -- views-tab desktop` |
| 5h | [05h runtime](2026-11-23-05h-runtime-extraction-plan.md) | 05g | `refactor(runtime): pure runtime core behind process, docker and CDP ports; CDP call timeout` | `npm run test:e2e -- workspace-status desktop` |
| 6 | [06 composition root](2026-11-23-06-composition-root-plan.md) | 05h | `refactor(app): composition root in electron/app; thin main; clear webview storage on removal` | `npm run test:e2e` (all); `node tests/app/launch.mjs` |
| 7 | [07 repo-map sync](2026-11-23-07-repo-map-sync-plan.md) | 06 | `feat(repo-map): one git-state clock for sidebar and Repo Map; open-file check; degraded sizes` | `npm run test:e2e -- repo-map desktop workspace-status pull-requests` |
| 8 | [08 remaining audit fixes](2026-11-23-08-remaining-audit-fixes-plan.md) | 07 | `fix: flow layout persists only after user action; pi-activity in e2e and CI; one terminal-event dispatcher; CI and deps cleanups` | `npm run test:e2e` (all 9 incl. `pi-activity`) |
| 9 | [09 boundary + cycle tests](2026-11-23-09-boundary-and-cycle-tests-plan.md) | 08 | `test(architecture): strict import-boundary and core-cycle tests` | `npm run test:e2e` (all); manual bite check |
| 10 | [10 docs](2026-11-23-10-docs-plan.md) | 09 | `docs: short README, usage guide, history in STATUS.md, archive old plans` | every README command once |

Umbrella mapping: commits 1-4 = plans 01-04; umbrella commit 5 = plans 05a-05h (eight commits, order git, activity,
terminals, stinggraph, repo-map, views, db-schema, runtime); 6-10 = plans 06-10.

e2e runs need a build (`npm run build`, included in `npm run check`). Linux: run e2e via `scripts/test-env.sh test e2e <suites>`.

## Plan-level clarifications (approved by the supervisor during planning)

1. `Hasher`, `GlobMatcher` (and 7: `SyntaxParser`) are module-level slots in `electron/core/shared/ports.ts` (`provide*`, `resetCorePorts`), filled only by `electron/app/**` (via `electron/app/wiring/core-ports.ts`) and tests; plan 09 enforces that rule. Existing tests that import runtime values needing them switch their import path to `electron/app/wiring/<feature>.ts` (path-only edit).
2. `registerContract(ctx, contract, handlers: Handlers<C>)`: `Handlers<C>` (sync-or-Promise, main side) next to `Invoke<C>` (Promise, renderer/demo side), same flat keys.
3. `pickApi` + `BridgeMissingError` live in `src/app/pick-api.ts` (node-testable); `DemoBadge` takes a `mode` prop.
4. The stinggraph port is `GraphReleaseHost { close, kill }`; views keeps its `GraphHost`.
5. Audit 3 has no legacy path: the fingerprint is required everywhere; 16 existing unit-test calls pass `(await service.reviewRemoval(id)).fingerprint` (ledger, at least as strict) and a new test proves a consent without fingerprint is refused.
6. The `editors.ts` split (app feature) happens in plan 06.
7. `SyntaxParser` is declared once in `electron/core/shared/ports.ts` with the same slot pattern (also `SettingsRepository`, shared by stinggraph and app, lives there as a plain interface).
8. README's "Use" and "State and safety boundaries" move verbatim to `docs/usage.md`, linked from the README overview and Links.

## Spec gaps found while planning (handled as noted; specs unchanged except two Decisions notes in spec 04)

- `src/views.ts` type-imports `src/infra/catalog`; in commit 3 `shared/contracts/views.ts` keeps that as a temporary type-only import, rewritten in commit 4 when the catalog moves to `shared/views/` (plan 03 T2 S8, plan 04 T6).
- `EditorId`/`EditorSettings` are declared in `src/views.ts` (not `electron/editors.ts`); both go to `shared/contracts/app.ts` with `EDITOR_IDS` (plan 03).
- Commit-4 path strings also include `tests/db-schema/db-schema.test.ts:11` and `tests/views/view-service.test.ts:11` (wasm path) and `.github/workflows/ci.yml` (`tests/package-launch.mjs`); `tsconfig` needs `"exclude": ["tests/fixtures"]` (the CDK fixture is TypeScript) (plan 04).
- Spec 04 lists the rule-2 degraded-sizes test under the repo-map extraction, but the behaviour is commit 7 (spec 06): the test lands in plan 07.
- `ViewService.release` closes the graph (an existing test asserts it), so the non-blocking views release and the blocking stinggraph release both close; the process host's `close()` is made idempotent so the stinggraph release awaits the same close (plan 05d).
- `electron/core/runtime/ports.ts` (PortService) clashes with the per-feature `ports.ts` convention: renamed `port-service.ts` inside the feature (plan 05h). `ContainerService` also reads Colima sockets: extra `DockerSocketFiles` port.
- The worker adapters imported other adapter folders (`driven/fs`, `driven/tree-sitter`, `driven/git`): `grammarDir`, `files`, `gitOut`, `exclude` are injected from `electron/app/wiring/stinggraph.ts` (plan 05d). `views-cli`'s `worktreeRoot` spawns git: moved to `electron/app/wiring/views.ts`, `CliDeps` gains `worktreeRoot` (plan 05f).
- db-schema's walker port is named `SchemaFiles` (views' `FileProvider` has another shape) (plan 05g); its core test uses the real tree-sitter adapter with in-memory files instead of a fake syntax tree.
- The walker throws on an unreadable root (db/sql today); the views file provider keeps today's empty result (plan 05f). Spec 06/07's "unreadable root gives a warning" for the worker path is implemented as an explicit degraded result with a warning (plan 05g).
- Rule 1 for the hook socket: malformed frames still close the connection silently (no payload logging today); exceptions from core calls are logged by message only (plan 05b).
- The removal listener order adds two listeners the order spec omits: stinggraph overlay (before the webview session, which stays last) and the repo-map cache clear (after activity) (plans 06, 07).
- The renderer layer rules do not say whether features may import `src/app/` (`api.ts`); the boundary test allows it (every feature uses `api`) and still forbids `src/shared` → app/features.
- The contract test's route count (46) becomes 48 in plan 07 (`selectWorkspace`, `statFile`).

## Done bar (whole PR) — run after plan 10

- [ ] **Step 1: Checks**

```bash
git status --short                      # clean; nothing from release/, artifacts/, dist*/
npm run check 2>&1 | tail -n 12         # # fail 0; tests = baseline (ledger) + new tests
npm run test:e2e                        # all 9 suites PASS, incl. pi-activity
node tests/app/launch.mjs
node tests/app/single-instance.mjs
```

- [ ] **Step 2: New-test inventory** — confirm these exist and pass: audit 3 (`tests/git/git.core.test.ts`, `git.test.ts`, `worktree-removal.mjs`), 4 (`tests/activity/activity.core.test.ts`, `activity.test.ts`), 5 (`tests/stinggraph/restart-policy.test.ts`, `stinggraph-process.test.ts`), 7 (`tests/app/contracts.test.ts`), 9 and 15 (`tests/terminals/terminals.test.ts`), 13 (`tests/views/views-tab.mjs`); core tests with fakes for every feature (`tests/*/*.core.test.ts`, `tests/fakes/*.ts`); one failure-isolation test per rule (contracts, views-cli.core, activity-socket; view-service.core, repo-map.core; workspace-lifecycle; db-schema-worker); `tests/architecture/*`.

- [ ] **Step 3: Docker smoke** — `scripts/test-env.sh up --detach` (prints the CDP endpoint; a `sample` repo is pre-registered). Save as `artifacts/testing/docker-smoke/smoke.mjs` (never committed) and run `node artifacts/testing/docker-smoke/smoke.mjs <port>`:

```js
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2]}`);
const page = browser.contexts()[0].pages().find(p => p.url().includes('index.html')) ?? browser.contexts()[0].pages()[0];
try {
  const state = await page.evaluate(() => window.stingray.state());
  const repo = state.repos.find(r => r.name === 'sample') ?? state.repos[0];
  const created = await page.evaluate(id => window.stingray.createWorkspace(id, 'docker-smoke'), repo.id);
  const w = created.workspaces.find(x => x.branch === 'docker-smoke');
  const terminal = await page.evaluate(id => window.stingray.createTerminal(id), w.id);
  await page.evaluate(id => window.stingray.writeTerminal(id, 'f=$(git ls-files | head -1); printf "docker smoke\\n" >> "$f"\r'), terminal.id);
  await page.reload();
  await page.getByRole('button', { name: `Open project ${repo.name}`, exact: true }).click();
  await page.getByRole('navigation', { name: 'Project workspaces' }).getByRole('button', { name: 'docker-smoke', exact: true }).click();
  await page.getByRole('tab', { name: /Repo Map/ }).click();
  await page.waitForFunction(() => /^[1-9]\d* changes$/.test(document.querySelector('.map-title h2 span')?.textContent ?? ''), null, { timeout: 30000 });
  const shared = await page.evaluate(id => window.stingray.gitState(id), w.id);
  const header = await page.locator('.map-title h2 span').innerText();
  const sidebar = (await page.getByRole('group', { name: 'docker-smoke Git summary', exact: true }).locator('.git-lines').innerText()).replace(/\s+/g, '');
  assert.equal(header, `${shared.status.changes.length} changes`);
  assert.equal(sidebar, `+${shared.status.lines.added}−${shared.status.lines.deleted}`);
  const review = await page.evaluate(id => window.stingray.reviewRemoval(id), w.id);
  const removed = await page.evaluate(([id, fingerprint]) => window.stingray.removeWorkspace(id, { discard: true, deleteBranch: false, fingerprint }), [w.id, review.fingerprint]);
  assert.ok('state' in removed && !removed.state.workspaces.some(x => x.id === w.id));
  console.log('PASS docker smoke: repo, worktree, terminal, Repo Map = sidebar counts, removal');
} finally { await browser.close(); }
```
(Adjust only selector strings if the sample project's names differ.) Then `scripts/test-env.sh down --all`. Record the result in the ledger's `## Manual checks`.

- [ ] **Step 4: PR**

```bash
git push -u origin HEAD
gh pr create --base main --fill
```
Then write the PR body to `/tmp/stingray-pr-body.md`: a short summary (one line per plan), "How tested" (the commands of Steps 1-3 with their results), the **replaced test assertions old vs new** — the full table of `docs/plans/2026-11-23-test-edit-ledger.md` (OQ3; every row says why it is at least as strict), the manual checks, the preload bundle size before/after (spec 03 risk), and the spec-gap list above. Apply it with `gh pr edit --body-file /tmp/stingray-pr-body.md`.

- [ ] **Step 5: CI** — `gh pr checks --watch`: `check`, `e2e (macos)`, `linux (docker test-env)` required steps green; `pi-activity` runs non-blocking on macOS and Linux. Fix and push follow-up commits if red (same rules).

- [ ] **Step 6:** Report the PR URL. Final `git status --short` shows nothing from `release/`, `artifacts/`, `dist*/`.

## Self-review (index)

- Every umbrella delivery row has a plan (1-10, with 5 split into 05a-05h in the umbrella's order); each plan names its spec sections, depends on the previous one, has one commit message and a gate.
- Done bar items of the umbrella: check, all e2e incl. `pi-activity`, tests unchanged except ledger rows, new tests inventory, Docker smoke, CI incl. non-blocking `pi-activity`, PR URL, clean `git status`.
