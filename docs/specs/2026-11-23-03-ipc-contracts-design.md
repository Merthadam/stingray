# Step 3 — IPC contracts (audit 7, 19)

Status: draft · Umbrella: [modular restructure](2026-11-23-modular-restructure-design.md)

## Goal

One declaration per feature drives every IPC layer:

- main registers handlers from it (argument validation included);
- preload builds `window.stingray` from it;
- the `DesktopAPI` type is derived from it;
- the browser demo is typed against it, so a missing demo method fails `tsc`.

And (audit 19): inside Electron, a missing `window.stingray` is a loud error, not a silent switch to the demo.

## Non-goals

- No change to what any route does, its argument limits, or the trusted-sender rule.
- No runtime validation of return values (types only).
- No validation in preload (main stays the trust boundary).
- No moves of existing implementation files (step 4); this step only adds `contract.ts`/`demo.ts` files at their
  final paths and edits main, preload, `src/shared.ts`, `src/api.ts`, `src/demo.ts`.

## Current behaviour

- `electron/main.ts:68-74`: one local `handle(name, schema, action)`; it rejects any sender that is not the main
  window's main frame at `rendererUrl` (`event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || url !== rendererUrl`), then `schema.parse(args)`.
- `electron/main.ts:123-239`: 47 `handle(...)` calls with inline `z.tuple(...)` schemas (46 after step 2).
  Kebab-case channel names (`'repo-snapshot'`, `'open-terminal-link'`, …).
- Events are sent ad hoc: `'activity-event'` (main.ts:47), `'terminal-event'` (:50), `'git-state-changed'` (:59),
  `'views-changed'` (:65), `'live-view-event'` (:66).
- `electron/preload.ts:6-80`: hand-written object, one line per route, plus four `on…` listeners.
- `src/shared.ts:95-165`: hand-written `DesktopAPI` interface; `src/shared.ts:168` declares `window.stingray?`.
- `src/demo.ts:205-314`: one `demoAPI: DesktopAPI` object for all features; shared demo state above it.
- `src/api.ts:2`: `window.stingray ?? (await import('./demo')).demoAPI` — inside Electron, a broken preload
  silently gives the demo.
- Some argument schemas live in Node-only modules the renderer cannot import:
  `viewLocalStateSchema` (`electron/database.ts:16`, re-exported via `electron/view-state.ts:4`),
  `positionsSchema` (`electron/views/rules/schema.ts:104`, file imports `node:path` and `yaml`),
  `EDITOR_IDS` (`electron/editors.ts:12`, file imports `node:child_process`), and inline ones in main.ts
  (`viewIdSchema` :163, `frameSize` :233, container id regex :189-190, depth options :164).
- e2e tests use raw channel names: `tests/repo-map.mjs:95-139,308-336` (`'repo-snapshot'`, `'inspect-file'`),
  `tests/terminal-links.mjs:171` (`'open-terminal-link'`), `tests/worktree-removal.mjs:48` (`'activity-event'`).

## Design

### Contract file

`src/features/<x>/contract.ts` (and `src/app/contract.ts` for the app routes) — renderer-safe: imports only
`zod`, `src/shared`, and renderer-safe modules of its own feature.

```ts
import { z } from 'zod';
import { defineContract, returns, event } from '../../shared/contract';
import { idSchema } from '../../shared';
import type { TerminalEvent, TerminalInfo, TerminalSnapshot } from '../../shared';

export const terminalsContract = defineContract('terminals', {
  invoke: {
    terminals: [z.tuple([]), returns<TerminalInfo[]>()],
    createTerminal: [z.tuple([idSchema]), returns<TerminalInfo>()],
    writeTerminal: [z.tuple([idSchema, z.string().max(65536)]), returns<void>()],
    // …one entry per route, schemas copied verbatim from main.ts
  },
  events: { onTerminal: event<TerminalEvent>() },
});
```

- `src/shared/contract.ts` (new, small): `defineContract(feature, spec)`, `returns<T>()` and `event<T>()` are
  identity helpers that carry the TypeScript type only. Types:
  `Invoke<C>` = `{ [m in keyof C['invoke']]: (...args: z.input<Tuple>) => Promise<Return> }`,
  `Events<C>` = `{ [e in keyof C['events']]: (listener: (payload: T) => void) => () => void }`.
- Channel name = `` `${feature}.${member}` `` for both routes and events, where `member` is the `DesktopAPI`
  member name (e.g. `terminals.createTerminal`, `terminals.onTerminal`). One rule, no exceptions.
- Optional trailing arguments (today only `view`'s `options`, main.ts:164) stay optional in the tuple
  (`.optional()` element), and preload drops a trailing `undefined` like preload.ts:20 does today.
- Route-to-feature assignment: see the umbrella feature table.

### Schemas that must move to the renderer side

Moved into the owning feature's renderer-safe file and re-imported by the Node module (so behaviour is identical):

- `positionsSchema` (+ `point`) → `src/features/views/schemas.ts`; `electron/views/rules/schema.ts` and
  `electron/database.ts` import it from there.
- `viewLocalStateSchema` → `src/features/views/schemas.ts`; `electron/database.ts` re-exports it so existing
  imports keep working until step 4.
- `EDITOR_IDS` → `src/app/contract.ts` (editors are app); `electron/editors.ts` imports it.
- Inline main.ts schemas move verbatim into the contracts.

### Main: `electron/app/ipc.ts`

```ts
export function handle(win: () => BrowserWindow, rendererUrl: string, channel: string, schema: z.ZodType, action: (...a: any[]) => unknown)
export function registerContract<C>(contract: C, handlers: Invoke<C>, ctx: { win; rendererUrl })
export function sender<C>(contract: C, win: () => BrowserWindow): Emit<C>   // typed webContents.send for events
```

- `handle` is main.ts:68-74 moved verbatim (same three sender checks, same `schema.parse(args)`).
- `registerContract` loops over `contract.invoke` and calls `handle` per route. `handlers` must have every route
  (missing → `tsc` error; extra → `tsc` error via exact-key check).
- `sender(contract, …).onTerminal(payload)` replaces the ad-hoc `win.webContents.send('terminal-event', …)` with
  the same `!win.isDestroyed()` guard.
- This step creates `electron/app/ipc.ts` at its final path (only `ipc.ts`; the rest of `electron/app/` arrives in
  step 4). main.ts stays where it is and registers one handler object per contract; the handler bodies are the
  existing lambdas, unchanged.

### Preload

`electron/preload.ts` imports every contract (via `src/app/contracts.ts`, a list of all contracts) and builds:

```ts
for (const c of contracts) {
  for (const m of Object.keys(c.invoke)) api[m] = (...args) => ipcRenderer.invoke(`${c.feature}.${m}`, ...trimTrailingUndefined(args));
  for (const e of Object.keys(c.events)) api[e] = listener => { const h = (_: unknown, p: unknown) => listener(p); ipcRenderer.on(`${c.feature}.${e}`, h); return () => ipcRenderer.removeListener(`${c.feature}.${e}`, h); };
}
api.mode = 'desktop';
contextBridge.exposeInMainWorld('stingray', api);
```

- Preload runs sandboxed (`sandbox: true`, main.ts:103): it can only `require('electron')` and a few built-ins.
  esbuild already bundles preload with only `electron` external (`scripts/build-electron.mjs:3`), so zod and the
  contracts are inlined. Contracts must not import Node modules; the contract test (below) checks the built
  `dist-electron/preload.cjs` has no `require(` other than `"electron"`.
- Member names collide only if two contracts declare the same name; the contract test checks uniqueness.

### `DesktopAPI` type

`src/app/desktop-api.ts`: `export type DesktopAPI = { mode: 'desktop' | 'demo' } & Invoke<…> & Events<…>` for all
contracts, plus `declare global { interface Window { stingray?: DesktopAPI } }`. `src/shared.ts` re-exports
`DesktopAPI` from there so existing imports keep compiling until step 4 rewrites paths. The hand-written interface
(`src/shared.ts:95-165`) is deleted; its doc comments move to the contract entries.

### Demo split

- `src/features/<x>/demo.ts` exports `createXDemo(ctx): Invoke<XContract> & Events<XContract>`.
- `ctx` is the shared demo state (`state`, `save()`, `terminalList`, terminal listeners) now at the top of
  `src/demo.ts`; it moves to `src/app/demo.ts`, which assembles `demoAPI` from all feature demos.
- Each feature demo is typed against its own contract, so a route without a demo fails `tsc`.
- Bodies are moved verbatim from today's `demoAPI`.

### Audit 19: `src/api.ts`

```ts
const inElectron = navigator.userAgent.includes('Electron');
if (inElectron && !window.stingray) throw new Error('Stingray desktop bridge is missing: the preload script did not load. Check the main-process log.');
export const api: DesktopAPI = window.stingray ?? (await import('./demo')).demoAPI;
```

The pure decision is a small exported function `pickApi(bridge, userAgent, loadDemo)` so it can be unit-tested.

### Raw channel names in e2e tests

Update the four e2e files above to the new names (`'repo-map.repoSnapshot'`, `'repo-map.inspectFile'`,
`'terminals.openTerminalLink'`, `'activity.onActivity'`). Pure string renames; assertions unchanged.

## Acceptance criteria

- [ ] Every route in today's main.ts (minus `db-schema`) is in exactly one contract with an identical argument schema.
- [ ] `electron/main.ts` contains no `ipcMain.handle` and no inline `z.tuple`.
- [ ] `electron/preload.ts` has no per-route lines.
- [ ] Removing any route from a feature demo, or any handler from main's handler object, fails `npm run typecheck`.
- [ ] Channel names all match `/^[a-z-]+\.[a-zA-Z]+$/` and are unique.
- [ ] The trusted-sender check is unchanged (`tests/terminal-links.mjs:170-178` "untrusted IPC sender" check passes).
- [ ] In Electron without a preload, the renderer throws the bridge-missing error; in a plain browser
      (`npm run dev:ui`) the demo still loads.

## Verification

- `npm run check`; `npm run test:e2e` (all suites).
- New `tests/contracts.test.ts` (moved to `tests/app/` in step 4):
  - every contract: channel names unique and well-formed; `invoke` values are `ZodTuple`s;
  - `buildPreloadApi(contracts, fakeIpcRenderer)` (the preload loop, exported from a renderer-safe module) creates
    one function per route/event and invokes the right channel with the given args (trailing `undefined` dropped);
  - `demoAPI` has exactly the keys of `DesktopAPI` (runtime keys check, complements `tsc`);
  - `handle()` with a fake event from another frame / URL throws `Untrusted IPC sender.` and does not call the action;
    with the right sender it parses args (bad args throw a ZodError, action not called);
  - `pickApi`: bridge present → bridge; Electron UA and no bridge → throws; browser UA → demo.
  - after `npm run build`: `dist-electron/preload.cjs` contains no `require("` other than `require("electron")`.

## Risks & rollback

- Channel rename breaks anything outside the repo that calls `ipcMain._invokeHandlers` by name. Only tests do.
- Bundling zod into preload grows it (~tens of KB). Acceptable; measured in the PR.
- Type-level helpers can make errors hard to read. Keep them to the few types above.
- Rollback: revert the commit (no data or format changes).

## Open questions

- `onX` event channels end up named `terminals.onTerminal` (member name). If you prefer noun channels
  (`terminals.event`), that breaks the "one rule" naming; this spec keeps one rule.
