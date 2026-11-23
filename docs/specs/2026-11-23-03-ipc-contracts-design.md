# Step 3 — IPC contracts (audit 7, 19)

Status: draft (decisions final) · Commit 3 · Umbrella: [modular restructure](2026-11-23-modular-restructure-design.md)

## Goal

One zod contract per feature in `shared/contracts/<feature>.ts` drives every IPC layer:

- main registers handlers from it (argument validation, trusted-sender check and error envelope in one place);
- preload builds `window.stingray` from it;
- the `DesktopAPI` type is derived from it;
- each feature's browser demo (`src/features/<x>/demo.ts`) is typed against it, so a missing demo method fails `tsc`.

And (audit 19, H3): the demo runs in a plain browser, or inside Electron with an explicit `?demo` flag in a dev
build only; otherwise inside Electron a missing bridge is a visible error, not a silent switch to the demo. A
`DEMO` badge is visible whenever demo data is active.

## Non-goals

- No change to what any route does, its argument limits, or the trusted-sender rule.
- No runtime validation of return values or event payloads (types only); main stays the trust boundary.
- No file moves (step 4). This commit creates new files at their final paths (`shared/contracts/**`,
  `electron/app/ipc.ts`, `electron/adapters/driving/ipc/build-api.ts`, `electron/adapters/driven/electron-shell/sender.ts`,
  `src/features/<x>/demo.ts`), moves type/schema declarations into the contracts, and edits main, preload and the
  renderer bridge in place.
- The renderer API stays flat (`window.stingray.createWorkspace`); only channel names change.

## Current behaviour

- `electron/main.ts:68-74`: one local `handle(name, schema, action)`; it rejects any sender that is not the main
  window's main frame at `rendererUrl`, then `schema.parse(args)`, then returns `action(...)`. Errors reach the
  renderer as `Error invoking remote method '<channel>': Error: <message>`; `src/useWorkspacePorts.ts:19` and
  `src/WorkspacePortsChip.tsx:74` strip that prefix by regex.
- `electron/main.ts:123-239`: 47 `handle(...)` calls with inline `z.tuple(...)` schemas (46 after step 2), kebab-case
  channels (`'repo-snapshot'`, `'open-terminal-link'`, …).
- Events are sent ad hoc: `'activity-event'` (main.ts:47), `'terminal-event'` (:50), `'git-state-changed'` (:59),
  `'views-changed'` (:65), `'live-view-event'` (:66).
- `electron/preload.ts:6-80`: hand-written object, one line per route, plus five `on…` listeners
  (`onViewsChanged`, `onActivity`, `onTerminal`, `onGitStateChanged`, `onLiveView`).
- `src/shared.ts:95-165`: hand-written `DesktopAPI`; `:168` declares `window.stingray?`.
- `src/demo.ts:205-314`: one `demoAPI: DesktopAPI` for all features, shared demo state above it.
- `src/api.ts:2`: `window.stingray ?? (await import('./demo')).demoAPI` — a broken preload silently gives the demo.
- Types and schemas both processes need live in renderer files that `electron/` imports (37 files import `src/`):
  `src/shared.ts` (schemas + domain types), `src/views.ts` (types only), `src/db-schema.ts` (types only),
  `src/live-view.ts` (`liveViewInputSchema` + types, plus renderer helpers), `src/activity.ts` (types, plus renderer
  helpers). `agents/hook-client.ts:2` and `agents/pi-observer.ts:3` import `AgentPhase` from `src/activity`.
- Schemas in Node-only modules: `viewLocalStateSchema` (`electron/database.ts:16`), `positionsSchema`
  (`electron/views/rules/schema.ts:104`, file imports `node:path`, `yaml`), `EDITOR_IDS` (`electron/editors.ts:12`,
  file imports `node:child_process`), and inline ones in main.ts (`viewIdSchema` :163, depth options :164,
  container id regex :189-190, `frameSize` :233).
- e2e tests use raw channel names: `tests/repo-map.mjs` (`'repo-snapshot'`, `'inspect-file'`),
  `tests/terminal-links.mjs:171` (`'open-terminal-link'`), `tests/worktree-removal.mjs:48` (`'activity-event'`).

## Design

### Contract files

`shared/contracts/<feature>.ts` for app, git, repo-map, terminals, activity, stinggraph, views, db-schema (types
only, no routes), runtime. They import only `zod`, other `shared/` files and type-only package imports
(e.g. `OverlayConflicts` from `@colbymchenry/codegraph`).

```ts
import { z } from 'zod';
import { defineContract, returns, event } from './define';
import { idSchema } from './common';

export type TerminalInfo = { /* moved verbatim from src/shared.ts:89 */ };
export const terminalsContract = defineContract('terminals', {
  invoke: {
    terminals: [z.tuple([]), returns<TerminalInfo[]>()],
    createTerminal: [z.tuple([idSchema]), returns<TerminalInfo>()],
    writeTerminal: [z.tuple([idSchema, z.string().max(65536)]), returns<void>()],
    // one entry per route, schemas copied verbatim from main.ts
  },
  events: { onTerminal: event<TerminalEvent>() },
});
```

- `shared/contracts/define.ts`: `defineContract(feature, spec)`, `returns<T>()`, `event<T>()` (identity helpers
  carrying the type), and the types `Invoke<C>`, `Events<C>`, `IpcResult<T> = { ok: true; value: T } | { ok: false; error: { message: string } }`.
- `shared/contracts/common.ts`: `idSchema`, `urlSchema` and other cross-feature schemas from `src/shared.ts:8-24`.
- `shared/contracts/index.ts`: `contracts` (array of all), `DesktopAPI = { mode: 'desktop' | 'demo' } & Invoke<…> & Events<…>`.
- Channel name = `` `${feature}.${member}` ``: calls `feature.action` (`git.createWorkspace`), events
  `feature.onThing` (`terminals.onTerminal`). Member names are clean feature-local names; where the existing flat
  renderer name differs, the entry declares it explicitly (`renderer: 'codegraphSettings'`) and preload exposes that
  name on `window.stingray`, so e2e calls are unchanged. The contract test checks flat names are unique. The git event is renamed
  `onGitStateChanged` → `onStatusChanged` (channel `git.onStatusChanged`; three renderer call sites). All other
  member names stay, so `window.stingray.*` calls in e2e tests are unchanged. The code-graph feature is named
  `stinggraph` (umbrella decision), so its channels are `stinggraph.settings`,
  `stinggraph.setSharedBase` and `stinggraph.conflicts`, mapped to the flat renderer names `codegraphSettings`,
  `setCodegraphSharedBase` and `codegraphConflicts`; the contract file is `shared/contracts/stinggraph.ts` (`stinggraphContract`).
- Optional trailing arguments (today only `view`'s `options`, main.ts:164) stay optional; preload drops a trailing
  `undefined` like preload.ts:20 does today.
- Route-to-feature assignment: umbrella feature table.

### Types and schemas that move into `shared/contracts/`

Declarations move verbatim; every importer (in `electron/`, `src/`, `agents/`, `tests/`) gets an import-path edit.
No re-export shims.

| From | To |
|---|---|
| `src/shared.ts` workspace/repository/state schemas + types, `Change`, `GitStatus`, `GitLineStats`, `RemovalReview`, `RemovalResult`, `removalConsentSchema`, `PullRequestStatus`, `WorkspaceGitState`, `repoPathSchema`, `repositoryUrlSchema`, `cloneDestinationSchema` | `shared/contracts/git.ts` |
| `src/shared.ts` `LineStats`, `FileSize`, `RepoFile`, `RepoSnapshot`, `FileInspection` | `shared/contracts/repo-map.ts` |
| `src/shared.ts` `TerminalInfo`, `TerminalSnapshot`, `TerminalEvent`, `terminalScrollback` | `shared/contracts/terminals.ts` |
| `src/shared.ts` `ContainerInfo`, `WorkspacePort`, `LiveViewTarget`; `src/live-view.ts` `liveViewInputSchema`, `LiveViewInput`, `LiveViewSession`, `LiveViewEvent` | `shared/contracts/runtime.ts` |
| `src/shared.ts` `idSchema`, `urlSchema` | `shared/contracts/common.ts` |
| `src/shared.ts` `DesktopAPI`, `window.stingray` declaration | deleted; derived in `shared/contracts/index.ts`, `Window` augmentation in `src/app/api.ts` |
| `src/views.ts` (all types), `positionsSchema` + `point`, `viewLocalStateSchema`, `VIEW_KINDS` | `shared/contracts/views.ts` |
| `src/db-schema.ts` (all types) | `shared/contracts/db-schema.ts` |
| `src/activity.ts` `AgentPhase`, `HarnessId`, `AgentActivity`, `ActivitySnapshot` | `shared/contracts/activity.ts` |
| `electron/editors.ts` `EDITOR_IDS`, `EditorId`, `EditorSettings` | `shared/contracts/app.ts` |
| inline main.ts schemas | the owning contract |

`src/shared.ts`, `src/views.ts` and `src/db-schema.ts` become empty and are deleted. `src/live-view.ts` and
`src/activity.ts` keep their renderer helpers (`framePoint`, `keyInput`, `activityLabel`, …).
`electron/views/rules/schema.ts`, `electron/database.ts`, `electron/editors.ts` import the moved schemas, so
validation is identical.

### Main: `electron/app/ipc.ts`

```ts
export function handle(ctx: IpcContext, channel: string, schema: z.ZodType, action: (...a: any[]) => unknown): void
export function registerContract<C>(ctx: IpcContext, contract: C, handlers: Invoke<C>): void
```

- `handle` is main.ts:68-74 moved: same three sender checks and `schema.parse(args)`; both still **throw** (trust
  boundary; `tests/terminal-links.mjs:170-178` calls the handler directly and expects a throw).
- Error envelope (failure-isolation rule 1, [step 4](2026-11-23-04-hexagonal-modules-design.md#failure-isolation)):
  the action runs inside try/catch; success → `{ ok: true, value }`, failure → `{ ok: false, error: { message } }`
  and a `console.error` with the channel. A failing handler never leaves an unhandled rejection in main.
- `registerContract` calls `handle` per route. `handlers` must have exactly the contract's keys (`tsc`).
- `electron/adapters/driven/electron-shell/sender.ts`: `sender(contract, win)` returns typed emitters
  (`.onTerminal(payload)`) that send on the contract channel with today's `!win.isDestroyed()` guard. Core services
  receive these emitters as their publish ports.
- main.ts keeps its place in this commit and registers one handler object per contract; handler bodies are the
  existing lambdas. They move to `electron/adapters/driving/ipc/<feature>.ts` in the feature's extraction commit.

### Preload

`electron/adapters/driving/ipc/build-api.ts` exports the pure loop; `electron/preload.ts` (moved in step 4) calls it:

```ts
export function buildPreloadApi(contracts: Contract[], ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>) {
  const api: Record<string, unknown> = { mode: 'desktop' };
  for (const c of contracts) {
    for (const m of Object.keys(c.invoke)) api[m] = async (...args: unknown[]) => {
      const result = await ipc.invoke(`${c.feature}.${m}`, ...trimTrailingUndefined(args)) as IpcResult<unknown>;
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    for (const e of Object.keys(c.events)) api[e] = (listener: (p: unknown) => void) => {
      const h = (_: unknown, p: unknown) => listener(p);
      ipc.on(`${c.feature}.${e}`, h); return () => ipc.removeListener(`${c.feature}.${e}`, h);
    };
  }
  return api;
}
```

- The renderer now sees the bare message; the two prefix-stripping regexes become no-ops and stay (removed only if
  unused after review; not required).
- Preload is sandboxed (`sandbox: true`, main.ts:103); esbuild bundles it with only `electron` external, so zod and
  the contracts are inlined. The contract test checks the built `dist-electron/preload.cjs` has no `require(` other
  than `"electron"`.

### Demo split (H3)

- `src/features/<x>/demo.ts` exports `createXDemo(ctx): Invoke<XContract> & Events<XContract>`, typed against
  `shared/contracts/<x>.ts`; a route without a demo fails `tsc`. Bodies move verbatim from today's `demoAPI`.
- `ctx` is the shared demo state (`state`, `save()`, `terminalList`, terminal listeners), which stays in
  `src/demo.ts` (moved to `src/app/demo.ts` in step 4) together with the assembly of `demoAPI`.
- `demoDbSchema` goes to `src/features/db-schema/demo.ts` (data only; the feature has no routes).

### Audit 19: bridge selection (`src/api.ts`, `src/main.tsx`)

```ts
export function pickApi(o: { bridge?: DesktopAPI; userAgent: string; search: string; dev: boolean; loadDemo: () => Promise<DesktopAPI> }) {
  if (!o.userAgent.includes('Electron')) return o.loadDemo();                    // plain browser: always demo
  if (o.dev && new URLSearchParams(o.search).has('demo')) return o.loadDemo();   // explicit demo, dev builds only
  if (o.bridge) return Promise.resolve(o.bridge);
  throw new BridgeMissingError();                                                // inside Electron: visible error
}
```

`src/api.ts` passes `dev: import.meta.env.DEV`. Only the Vite dev server build (`npm run dev`, unpackaged) has it
set; every production renderer build (the packaged app, `npm start`) ignores `?demo` and uses the bridge, or shows
the missing-bridge error when there is none.

Demo badge: `src/app/DemoBadge.tsx` renders a visible `DEMO` badge (`role="status"`, `aria-label="Demo data"`)
when `api.mode === 'demo'` and nothing otherwise. `App.tsx` shows it in the always-visible app chrome (next to the
existing status bar text), so it stays on screen on every page, in addition to the existing
`demo-banner`.

`src/main.tsx` imports `App` dynamically; if loading the API throws `BridgeMissingError`, it renders a full-window
message with plain DOM: "Stingray desktop bridge is missing: the preload script did not load. Check the
main-process log." No demo data is shown.

### Raw channel names in e2e tests

`tests/repo-map.mjs` → `'repo-map.repoSnapshot'`, `'repo-map.inspectFile'`; `tests/terminal-links.mjs:171` →
`'terminals.openTerminalLink'`; `tests/worktree-removal.mjs:48` → `'activity.onActivity'`. String renames only.
Handler wrappers in these tests pass the envelope through unchanged (`await original(...args)`); handlers that
throw still reject the renderer call.

## Acceptance criteria

- [ ] Every route of today's main.ts (minus `db-schema`) is in exactly one contract with an identical argument schema.
- [ ] `electron/main.ts` contains no `ipcMain.handle` and no inline `z.tuple`; `electron/preload.ts` has no per-route lines.
- [ ] Removing a route from a feature demo, or a handler from main's handler object, fails `npm run typecheck`.
- [ ] Channel names match `/^[a-z-]+\.[a-zA-Z]+$/`, are unique, and member names are unique across contracts.
- [ ] Trusted-sender check unchanged (`tests/terminal-links.mjs` "untrusted IPC sender" check passes).
- [ ] `src/shared.ts`, `src/views.ts`, `src/db-schema.ts` are gone; no `electron/` or `agents/` file imports
      `src/` types that now live in `shared/contracts/`.
- [ ] Electron without preload shows the bridge-missing screen; `npm run dev:ui` in a browser loads the demo;
      `?demo` loads the demo inside Electron only in a dev build; a production build ignores `?demo`.
- [ ] The `DEMO` badge is visible whenever demo data is active and absent in desktop mode.

## Verification

- `npm run check`; `npm run test:e2e` (all suites).
- New `tests/contracts.test.ts` (moved to `tests/app/` in step 4):
  - channel names unique and well-formed; member names unique; `invoke` values are `ZodTuple`s;
  - `buildPreloadApi(contracts, fakeIpc)` makes one function per route/event, invokes the right channel, drops a
    trailing `undefined`, unwraps `{ ok: true }` and throws the message of `{ ok: false }`;
  - `demoAPI` has exactly the keys of `DesktopAPI` (runtime check, complements `tsc`);
  - `handle()` with a sender from another frame / URL throws `Untrusted IPC sender.` and does not call the action;
    bad args throw a ZodError, action not called;
  - failure-isolation rule 1: with two handlers registered, one whose action throws returns `{ ok: false }` and
    logs; the other still returns `{ ok: true }` afterwards;
  - `pickApi` (table): browser, with or without `?demo` → demo; Electron + `dev` + `?demo` (with or without bridge)
    → demo; Electron + production + `?demo` + bridge → bridge; Electron + production + `?demo`, no bridge →
    `BridgeMissingError`; Electron + bridge → bridge; Electron without bridge → `BridgeMissingError`;
  - `DemoBadge` via `react-dom/server` `renderToStaticMarkup` (no new dependency): mode `demo` → markup contains
    `DEMO`; mode `desktop` → empty;
  - after `npm run build`: `dist-electron/preload.cjs` contains no `require("` other than `require("electron")`.
- `tests/desktop.mjs` (moved to `tests/app/` in step 4) gains one check: no `DEMO` badge in desktop mode. That a
  production build ignores `?demo` is covered by the `pickApi` table (the window cannot navigate to another URL:
  `will-navigate` and the trusted-sender check pin `rendererUrl`).

## Risks & rollback

- Channel rename breaks anything outside the repo that addresses `ipcMain` handlers by name. Only tests do.
- Bundling zod into preload grows it (~tens of KB); measured in the PR.
- Error messages lose Electron's prefix; any UI that displayed the prefix now shows the plain message (intended).
- Rollback: revert the commit (no data or format changes).

## Decisions

- **Contract location (H1):** top-level `shared/contracts/<feature>.ts`; `shared/` imports nothing from
  `electron/`, `src/` or `agents/`.
- **Naming (OQ10):** channels `feature.action` and `feature.onThing`; the git event becomes `git.onStatusChanged`.
  The renderer API stays flat.
- **Preload and `DesktopAPI`:** both derived from the contracts; no hand-written route lists remain.
- **Error envelope:** action failures return `{ ok: false, error }` (rule 1); sender and argument checks still throw.
- **Demo (H3):** per-feature `demo.ts` typed against the contracts; demo only in a plain browser or with `?demo`;
  inside Electron a missing bridge renders a visible error (audit 19).
- **Demo flag scope:** plain browser always demo; inside Electron `?demo` is honoured only in a dev build
  (`import.meta.env.DEV`, unpackaged `npm run dev`); production builds ignore it and show the missing-bridge error
  without a bridge. A `DEMO` badge is visible whenever demo data is active.
- **stinggraph contract:** `shared/contracts/stinggraph.ts`, clean channels `stinggraph.settings`,
  `stinggraph.setSharedBase`, `stinggraph.conflicts`, each mapped to its existing flat renderer name
  (`codegraphSettings`, `setCodegraphSharedBase`, `codegraphConflicts`); the type-only import from
  `@colbymchenry/codegraph` is unchanged.
- **Test edits:** only the raw channel strings listed above; no assertion changes.
