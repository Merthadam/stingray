# 03 · IPC contracts and per-feature demos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** one zod contract per feature in `shared/contracts/` drives main's handler registration (sender check, argument
parse, error envelope), preload's `window.stingray`, the `DesktopAPI` type and per-feature browser demos; inside
Electron a missing bridge is a visible error and demo data always shows a `DEMO` badge (audit 7, 19; `VIEW_KINDS`).

**Architecture:** `shared/contracts/define.ts` provides `defineContract`, `returns<T>()`, `event<T>()` and the mapped
types `Invoke<C>` (renderer, Promise-returning, keyed by flat renderer name), `Handlers<C>` (main, sync-or-Promise,
same keys), `Events<C>`, `Publishers<C>`, `IpcResult<T>`. Main registers contracts through `electron/app/ipc.ts`;
preload is a loop in `electron/adapters/driving/ipc/build-api.ts`; events go out through
`electron/adapters/driven/electron-shell/sender.ts`. Files stay where they are except the new files, which are created
at their final paths.

**Tech Stack:** zod 4 (tuple schemas with optional trailing elements), TypeScript 7, Electron `ipcMain`/`ipcRenderer`/`contextBridge`, React 19 (`react-dom/server` for the badge test), node:test.

**Spec:** [`docs/specs/2026-11-23-03-ipc-contracts-design.md`](../specs/2026-11-23-03-ipc-contracts-design.md); `VIEW_KINDS` from [07 § Small fixes](../specs/2026-11-23-07-audit-fixes-design.md#small-fixes).

**Plan-level clarifications (approved by the supervisor, recorded in the index):**
- `registerContract(ctx, contract, handlers: Handlers<C>)` — `Handlers<C>` is the main-side type (returns `R | Promise<R>`); `Invoke<C>` stays the renderer/demo type.
- `pickApi` and `BridgeMissingError` live in `src/app/pick-api.ts` (node-importable); `src/api.ts` calls it. `DemoBadge` takes a `mode` prop.

**Depends on:** plan 02 committed. **Commit:** one, `feat(ipc): zod contracts in shared/contracts drive main, preload, DesktopAPI and per-feature demos`.

---

## Files

Create:
- `shared/contracts/define.ts`, `common.ts`, `index.ts`, `app.ts`, `git.ts`, `repo-map.ts`, `terminals.ts`, `activity.ts`, `stinggraph.ts`, `views.ts`, `db-schema.ts`, `runtime.ts`
- `electron/app/ipc.ts`
- `electron/adapters/driving/ipc/build-api.ts`
- `electron/adapters/driven/electron-shell/sender.ts`
- `src/app/pick-api.ts`, `src/app/DemoBadge.tsx`
- `src/shared/demo-context.ts`
- `src/features/{app,git,repo-map,terminals,activity,stinggraph,views,db-schema,runtime}/demo.ts`
- `tests/contracts.test.ts` (moves to `tests/app/` in plan 04)

Modify: `electron/main.ts`, `electron/preload.ts`, `src/api.ts`, `src/main.tsx`, `src/App.tsx`, `src/demo.ts`, `src/useGitState.ts`,
`src/live-view.ts`, `src/activity.ts`, `electron/views/rules/schema.ts`, `electron/database.ts`, `electron/view-state.ts`,
`electron/editors.ts`, every importer of the moved declarations (found by `npm run typecheck`, Task 4),
`tests/repo-map.mjs`, `tests/terminal-links.mjs:171`, `tests/worktree-removal.mjs:48`, `tests/desktop.mjs`.

Delete: `src/shared.ts`, `src/views.ts`, `src/db-schema.ts`.

---

### Task 1: `shared/contracts/define.ts` and `common.ts` (TDD)

- [ ] **Step 1: Write the first part of `tests/contracts.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineContract, returns, event, channel, rendererName } from '../shared/contracts/define';

test('defineContract keeps feature, routes and events; channel and renderer names', () => {
  const c = defineContract('demo-feature', {
    invoke: { load: [z.tuple([z.string()]), returns<number>()], settings: [z.tuple([]), returns<boolean>(), { renderer: 'demoSettings' }] },
    events: { onThing: event<string>() },
  });
  assert.equal(c.feature, 'demo-feature');
  assert.deepEqual(Object.keys(c.invoke), ['load', 'settings']);
  assert.deepEqual(Object.keys(c.events), ['onThing']);
  assert.equal(channel(c.feature, 'load'), 'demo-feature.load');
  assert.equal(rendererName('load', c.invoke.load), 'load');
  assert.equal(rendererName('settings', c.invoke.settings), 'demoSettings');
});
```

- [ ] **Step 2: Run it** — `npx tsx --test tests/contracts.test.ts` → FAIL `Cannot find module '../shared/contracts/define'`.

- [ ] **Step 3: Create `shared/contracts/define.ts`**

```ts
// Contracts: one per feature, imported by main (handler registration), preload (window.stingray) and the renderer
// (DesktopAPI, demos). Channels are `${feature}.${member}`; the renderer API stays flat (member name, or `renderer`).
import type { z } from 'zod';

declare const typeTag: unique symbol;
/** Return type carrier of a route (no runtime value). */
export type Returns<T> = { readonly [typeTag]?: T };
/** Payload type carrier of an event (no runtime value). */
export type EventOf<T> = { readonly [typeTag]?: T };
export const returns = <T>(): Returns<T> => ({});
export const event = <T>(): EventOf<T> => ({});

type AnyTuple = z.ZodTuple<any, any>;
export type InvokeEntry = readonly [AnyTuple, Returns<any>] | readonly [AnyTuple, Returns<any>, { readonly renderer: string }];
export interface Contract {
  readonly feature: string;
  readonly invoke: Readonly<Record<string, InvokeEntry>>;
  readonly events: Readonly<Record<string, EventOf<any>>>;
}

export function defineContract<const F extends string, const I extends Record<string, InvokeEntry>, const E extends Record<string, EventOf<any>>>(
  feature: F, spec: { invoke: I; events: E }): { feature: F; invoke: I; events: E } {
  return { feature, invoke: spec.invoke, events: spec.events };
}

export const channel = (feature: string, member: string) => `${feature}.${member}`;
export const rendererName = (member: string, entry: InvokeEntry) => (entry.length === 3 ? entry[2].renderer : member);

type Args<E> = E extends readonly [infer S extends AnyTuple, ...unknown[]] ? z.input<S> : never;
type Parsed<E> = E extends readonly [infer S extends AnyTuple, ...unknown[]] ? z.output<S> : never;
type Ret<E> = E extends readonly [AnyTuple, Returns<infer R>, ...unknown[]] ? R : never;
type Flat<K, E> = E extends readonly [AnyTuple, Returns<any>, { readonly renderer: infer N extends string }] ? N : K;
type Payload<E> = E extends EventOf<infer T> ? T : never;

/** Renderer side (window.stingray, demos): Promise-returning, keyed by flat renderer name. */
export type Invoke<C extends Contract> = { [K in keyof C['invoke'] as Flat<K, C['invoke'][K]>]: (...args: Args<C['invoke'][K]>) => Promise<Ret<C['invoke'][K]>> };
/** Main side (registerContract): parsed arguments, sync or async result, same keys as Invoke. */
export type Handlers<C extends Contract> = { [K in keyof C['invoke'] as Flat<K, C['invoke'][K]>]: (...args: Parsed<C['invoke'][K]>) => Ret<C['invoke'][K]> | Promise<Ret<C['invoke'][K]>> };
/** Renderer side: subscribe, returns unsubscribe. */
export type Events<C extends Contract> = { [K in keyof C['events']]: (listener: (payload: Payload<C['events'][K]>) => void) => () => void };
/** Main side: emit one event. */
export type Publishers<C extends Contract> = { [K in keyof C['events']]: (payload: Payload<C['events'][K]>) => void };
/** Envelope every handler returns (failure-isolation rule 1). Sender and argument checks still throw. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { message: string } };
```

- [ ] **Step 4: Create `shared/contracts/common.ts`** — move `idSchema` and `urlSchema` verbatim from `src/shared.ts:8-11`:

```ts
import { z } from 'zod';

export const idSchema = z.string().uuid();
export const urlSchema = z.string().max(2048).refine((value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, 'Use an http:// or https:// URL without credentials.');
```

- [ ] **Step 5: Run** — `npx tsx --test tests/contracts.test.ts` → PASS.

### Task 2: Feature contract files

Each file imports only `zod`, other `shared/` files and type-only package imports. Type declarations listed as
"moved verbatim" are cut from the named source lines and pasted unchanged (including their doc comments).

- [ ] **Step 1: `shared/contracts/git.ts`**

Move verbatim from `src/shared.ts`: lines 12-25 (`repositoryUrlSchema`, `cloneDestinationSchema` with comment), 26-36
(`workspaceSchema`, `repoSchema`, `stateSchema`, `Workspace`, `Repository`, `State`), 37 (`Change`), 47-51
(`repoPathSchema`), 52-57 (`GitLineStats`, `GitStatus`), 58-73 (`RemovalReview`, `RemovalResult`, `removalConsentSchema`,
`RemovalConsent`), 74-78 (`PullRequestStatus`), 166-167 (`WorkspaceGitState`). Then add:

```ts
import { z } from 'zod';
import { idSchema, urlSchema } from './common';
import { defineContract, event, returns } from './define';
// ... moved declarations ...

export const gitContract = defineContract('git', {
  invoke: {
    pickRepository: [z.tuple([]), returns<State | null>()],
    openRepository: [z.tuple([z.string().min(1).max(4096)]), returns<State>()],
    pickCloneParent: [z.tuple([]), returns<string | null>()],
    // Validated in the service with fixed errors (no Zod payload echo).
    cloneRepository: [z.tuple([z.string().max(2048), z.string().max(4096)]), returns<State>()],
    createWorkspace: [z.tuple([idSchema, z.string().max(100)]), returns<State>()],
    reviewRemoval: [z.tuple([idSchema]), returns<RemovalReview>()],
    removeWorkspace: [z.tuple([idSchema, removalConsentSchema]), returns<RemovalResult>()],
    /** Shared Git + PR state of a workspace; starts main-process tracking (watcher, polls) on first use. */
    gitState: [z.tuple([idSchema]), returns<WorkspaceGitState>()],
    /** Re-reads Git now and re-queries GitHub (5s cooldown). */
    refreshGitState: [z.tuple([idSchema]), returns<WorkspaceGitState>()],
  },
  events: { onStatusChanged: event<WorkspaceGitState>() },
});
```

- [ ] **Step 2: `shared/contracts/repo-map.ts`** — move verbatim `src/shared.ts:38-46` (`LineStats`, `FileSize`, `RepoFile`, `RepoSnapshot`, `FileInspection`), then:

```ts
import { z } from 'zod';
import { idSchema } from './common';
import { defineContract, returns } from './define';
import { repoPathSchema, type Change, type GitStatus } from './git';
// ... moved declarations ...
export const repoMapContract = defineContract('repo-map', {
  invoke: {
    repoSnapshot: [z.tuple([idSchema]), returns<RepoSnapshot>()],
    inspectFile: [z.tuple([idSchema, repoPathSchema]), returns<FileInspection>()],
  },
  events: {},
});
```

- [ ] **Step 3: `shared/contracts/terminals.ts`** — move verbatim `src/shared.ts:89-94` (`TerminalInfo`, `terminalScrollback`, `TerminalSnapshot`, `TerminalEvent`), then:

```ts
export const terminalsContract = defineContract('terminals', {
  invoke: {
    terminals: [z.tuple([]), returns<TerminalInfo[]>()],
    terminalSnapshot: [z.tuple([idSchema]), returns<TerminalSnapshot>()],
    createTerminal: [z.tuple([idSchema]), returns<TerminalInfo>()],
    writeTerminal: [z.tuple([idSchema, z.string().max(65536)]), returns<void>()],
    openTerminalLink: [z.tuple([idSchema, z.string().min(1).max(8192)]), returns<void>()],
    resizeTerminal: [z.tuple([idSchema, z.number().int().min(2).max(500), z.number().int().min(1).max(300)]), returns<void>()],
    closeTerminal: [z.tuple([idSchema]), returns<void>()],
  },
  events: { onTerminal: event<TerminalEvent>() },
});
```

- [ ] **Step 4: `shared/contracts/activity.ts`** — move verbatim `src/activity.ts:1-3` (comment, `AgentPhase`, `HarnessId`) and `:5-14` (`AgentActivity`, `ActivitySnapshot`). `harnessNames` (line 4) and every function stay in `src/activity.ts`, which now imports these types from `../shared/contracts/activity`. Then:

```ts
export const activityContract = defineContract('activity', {
  invoke: {
    activity: [z.tuple([]), returns<ActivitySnapshot>()],
    activityView: [z.tuple([z.array(idSchema).max(2)]), returns<void>()],
    acknowledgeActivity: [z.tuple([idSchema, idSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]), returns<void>()],
    /** Dismiss a workspace's restored (previous session) activity. */
    dismissActivity: [z.tuple([idSchema]), returns<void>()],
  },
  events: { onActivity: event<ActivitySnapshot>() },
});
```

- [ ] **Step 5: `shared/contracts/app.ts`** — move `EditorId` and `EditorSettings` verbatim from `src/views.ts:195-199` and `EDITOR_IDS` from `electron/editors.ts:12` (the `EDITOR_IDS` line keeps `satisfies readonly EditorId[]`). Then:

```ts
import { z } from 'zod';
import { idSchema, urlSchema } from './common';
import { defineContract, returns } from './define';
import { repoPathSchema, type State } from './git';
// ... moved declarations ...
export const appContract = defineContract('app', {
  invoke: {
    state: [z.tuple([]), returns<State>()],
    preview: [z.tuple([idSchema, z.union([z.literal(''), urlSchema])]), returns<State>()],
    editorSettings: [z.tuple([]), returns<EditorSettings>()],
    setEditor: [z.tuple([z.enum(EDITOR_IDS)]), returns<EditorSettings>()],
    /** Open a worktree file (at a 1-based line when the editor supports it) in the selected editor. */
    openSource: [z.tuple([idSchema, repoPathSchema, z.number().int().positive().max(10_000_000).nullable()]), returns<void>()],
  },
  events: {},
});
```

- [ ] **Step 6: `shared/contracts/stinggraph.ts`**

```ts
import { z } from 'zod';
import type { OverlayConflicts } from '@colbymchenry/codegraph';
import { idSchema } from './common';
import { defineContract, returns } from './define';

export const stinggraphContract = defineContract('stinggraph', {
  invoke: {
    /** codegraph.sharedBase: managed worktrees use one shared origin/main index plus an overlay of their commits. Applies when a graph is next opened. */
    settings: [z.tuple([]), returns<{ sharedBase: boolean }>(), { renderer: 'codegraphSettings' }],
    setSharedBase: [z.tuple([z.boolean()]), returns<{ sharedBase: boolean }>(), { renderer: 'setCodegraphSharedBase' }],
    /** File/symbol conflicts and main-moved files between the managed worktrees of this worktree's repo; null when shared base is off or not built. */
    conflicts: [z.tuple([idSchema]), returns<OverlayConflicts | null>(), { renderer: 'codegraphConflicts' }],
  },
  events: {},
});
```

- [ ] **Step 7: `shared/contracts/db-schema.ts`** — move the whole of `src/db-schema.ts` verbatim (types only, no contract object).

- [ ] **Step 8: `shared/contracts/views.ts`** — move the whole of `src/views.ts` verbatim **except** `EditorId`/`EditorSettings` (now in `app.ts`) and replace line 6 with the single list:

```ts
export const VIEW_KINDS = ['tables', 'flow', 'timeline', 'graph', 'flowchart', 'sequence'] as const;
export type ViewKind = typeof VIEW_KINDS[number];
```

Its import `import type { InfraProvider, InfraService } from './infra/catalog';` becomes
`import type { InfraProvider, InfraService } from '../../src/infra/catalog';` (temporary type-only import; plan 04 moves
the catalog to `shared/views/infra/catalog.ts` and rewrites this path). Also move `point` and `positionsSchema` verbatim
from `electron/views/rules/schema.ts:104-107` and `nodeIds` + `viewLocalStateSchema` from `electron/database.ts:15-16`.
Then add:

```ts
const viewIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);
export const viewsContract = defineContract('views', {
  invoke: {
    views: [z.tuple([idSchema]), returns<ViewSummary[]>()],
    /** `depth` overrides a flowchart view's `flowchart.depth` (0-4), a layers view's `layers.depth` (1-4) or a sequence view's
     * `sequence.depth` (0-6) for this computation (clamped to the kind's range); others ignore it. */
    view: [z.tuple([idSchema, viewIdSchema, z.strictObject({ depth: z.number().int().min(0).max(6).optional() }).optional()]), returns<ViewResult>()],
    /** Local (app data) state of a view in a worktree; null when none saved yet. */
    viewState: [z.tuple([idSchema, viewIdSchema]), returns<ViewLocalState | null>()],
    saveViewState: [z.tuple([idSchema, viewIdSchema, viewLocalStateSchema]), returns<void>()],
    /** Writes .stingray/views/<slug>.yaml; rejects if that file exists. */
    saveViewAs: [z.tuple([idSchema, z.strictObject({
      name: z.string().max(200), basedOn: viewIdSchema, exclude: z.array(z.string().max(300)).max(2000),
      layout: z.strictObject({ positions: positionsSchema }).nullable(),
    })]), returns<SaveViewResult>()],
    /** Only catalog ids are accepted, so the renderer can open nothing but the catalog's fixed documentation URLs. */
    openServiceDocs: [z.tuple([z.string().max(100)]), returns<void>()],
  },
  events: { onViewsChanged: event<ViewsChangedEvent>() },
});
```

- [ ] **Step 9: `shared/contracts/runtime.ts`** — move verbatim `src/shared.ts:79-88` (`ContainerInfo`, `WorkspacePort`, `LiveViewTarget`) and `src/live-view.ts:4-20` (`unit`, `modifiers`, `delta`, `liveViewInputSchema`, `LiveViewInput`, `LiveViewSession`, `LiveViewEvent`). `src/live-view.ts` keeps `MODIFIER`, `modifierBits`, `framePoint`, `keyInput` and imports `LiveViewInput` from `../shared/contracts/runtime`. Then:

```ts
const frameSize = z.number().int().min(16).max(8192);
const containerId = z.string().regex(/^[a-f0-9]{64}$/);
export const runtimeContract = defineContract('runtime', {
  invoke: {
    containers: [z.tuple([]), returns<ContainerInfo[]>()],
    /** docker stop; test-env containers only. */
    stopContainer: [z.tuple([containerId]), returns<void>()],
    /** Last ~300 log lines; test-env containers only. */
    containerLogs: [z.tuple([containerId]), returns<string>()],
    /** Copies 127.0.0.1:<port> and opens chrome://inspect in Google Chrome when possible. */
    inspectCdp: [z.tuple([z.number().int().min(1).max(65535)]), returns<{ address: string; opened: boolean }>()],
    ports: [z.tuple([]), returns<WorkspacePort[]>()],
    /** Screencast + input of a test instance's Stingray window over CDP on 127.0.0.1:port; max sizes are frame pixels. */
    liveViewStart: [z.tuple([z.strictObject({ port: z.number().int().min(1).max(65535), maxWidth: frameSize.optional(), maxHeight: frameSize.optional() })]), returns<LiveViewSession>()],
    liveViewInput: [z.tuple([idSchema, liveViewInputSchema]), returns<void>()],
    liveViewResize: [z.tuple([idSchema, frameSize, frameSize]), returns<void>()],
    liveViewStop: [z.tuple([idSchema]), returns<void>()],
    /** The latest frame was displayed; the next one may be sent. */
    liveViewAck: [z.tuple([idSchema]), returns<void>()],
  },
  events: { onLiveView: event<LiveViewEvent>() },
});
```

- [ ] **Step 10: `shared/contracts/index.ts`**

```ts
import { activityContract } from './activity';
import { appContract } from './app';
import type { Events, Invoke } from './define';
import { gitContract } from './git';
import { repoMapContract } from './repo-map';
import { runtimeContract } from './runtime';
import { stinggraphContract } from './stinggraph';
import { terminalsContract } from './terminals';
import { viewsContract } from './views';

/** Every contract with routes or events (db-schema is types only). */
export const contracts = [appContract, gitContract, repoMapContract, terminalsContract, activityContract, stinggraphContract, viewsContract, runtimeContract] as const;

export type DesktopAPI = { mode: 'desktop' | 'demo' }
  & Invoke<typeof appContract> & Events<typeof appContract>
  & Invoke<typeof gitContract> & Events<typeof gitContract>
  & Invoke<typeof repoMapContract> & Events<typeof repoMapContract>
  & Invoke<typeof terminalsContract> & Events<typeof terminalsContract>
  & Invoke<typeof activityContract> & Events<typeof activityContract>
  & Invoke<typeof stinggraphContract> & Events<typeof stinggraphContract>
  & Invoke<typeof viewsContract> & Events<typeof viewsContract>
  & Invoke<typeof runtimeContract> & Events<typeof runtimeContract>;
```

- [ ] **Step 11: Extend `tests/contracts.test.ts`** (append)

```ts
import { contracts } from '../shared/contracts';

test('every contract route is a ZodTuple; channels are well-formed and unique; flat names are unique', () => {
  const channels = new Set<string>(), flat = new Set<string>(['mode']);
  let routes = 0;
  for (const c of contracts) {
    for (const [member, entry] of Object.entries(c.invoke)) {
      routes++;
      assert.ok(entry[0] instanceof z.ZodTuple, `${c.feature}.${member} schema`);
      const name = channel(c.feature, member);
      assert.match(name, /^[a-z-]+\.[a-zA-Z]+$/);
      assert.ok(!channels.has(name), `duplicate channel ${name}`); channels.add(name);
      const renderer = rendererName(member, entry);
      assert.ok(!flat.has(renderer), `duplicate flat name ${renderer}`); flat.add(renderer);
    }
    for (const member of Object.keys(c.events)) {
      const name = channel(c.feature, member);
      assert.match(name, /^[a-z-]+\.on[A-Z][a-zA-Z]+$/);
      assert.ok(!channels.has(name)); channels.add(name);
      assert.ok(!flat.has(member)); flat.add(member);
    }
  }
  assert.equal(routes, 46, 'every route of main.ts except the removed db-schema');
});
```

- [ ] **Step 12: Run** — `npx tsx --test tests/contracts.test.ts` → PASS.

### Task 3: Delete the renderer-owned type files and fix every importer

- [ ] **Step 1: Delete** — `git rm src/shared.ts src/views.ts src/db-schema.ts`. Remove the `DesktopAPI` interface and the `declare global` (they are gone with `src/shared.ts`).

- [ ] **Step 2: Fix imports with the typecheck loop**

Run: `npm run typecheck 2>&1 | grep -o "^[^(]*" | sort -u`
For every listed file, rewrite each broken import to the new home (relative path from the importing file; `type`
keywords unchanged; split an import into two when its names now live in two files):

| Name(s) | New module |
|---|---|
| `idSchema`, `urlSchema` | `shared/contracts/common` |
| `repositoryUrlSchema`, `cloneDestinationSchema`, `workspaceSchema`, `repoSchema`, `stateSchema`, `Workspace`, `Repository`, `State`, `Change`, `repoPathSchema`, `GitLineStats`, `GitStatus`, `RemovalReview`, `RemovalResult`, `removalConsentSchema`, `RemovalConsent`, `PullRequestStatus`, `WorkspaceGitState` | `shared/contracts/git` |
| `LineStats`, `FileSize`, `RepoFile`, `RepoSnapshot`, `FileInspection` | `shared/contracts/repo-map` |
| `TerminalInfo`, `terminalScrollback`, `TerminalSnapshot`, `TerminalEvent` | `shared/contracts/terminals` |
| `ContainerInfo`, `WorkspacePort`, `LiveViewTarget`, `liveViewInputSchema`, `LiveViewInput`, `LiveViewSession`, `LiveViewEvent` | `shared/contracts/runtime` |
| `AgentPhase`, `HarnessId`, `AgentActivity`, `ActivitySnapshot` | `shared/contracts/activity` |
| `EditorId`, `EditorSettings`, `EDITOR_IDS` | `shared/contracts/app` |
| every other former `src/views.ts` name, `VIEW_KINDS`, `positionsSchema`, `viewLocalStateSchema` | `shared/contracts/views` |
| every former `src/db-schema.ts` name | `shared/contracts/db-schema` |
| `DesktopAPI` | `shared/contracts` (index) |

Specific edits beyond import paths (each keeps validation identical):
- `electron/editors.ts`: delete line 12 (`EDITOR_IDS` moved); import `EDITOR_IDS, type EditorId, type EditorSettings` from `../shared/contracts/app`.
- `electron/views/rules/schema.ts`: delete `point`/`positionsSchema` (104-107) and `export const KINDS` (line 11); import `VIEW_KINDS, positionsSchema` from `../../../shared/contracts/views`; line 133 `kind: z.enum(KINDS)` → `kind: z.enum(VIEW_KINDS)`; `layoutSchema` stays and uses the imported `positionsSchema`.
- `electron/database.ts`: delete `nodeIds` and `viewLocalStateSchema` (15-16) and the `positionsSchema` import; import `viewLocalStateSchema` from `../shared/contracts/views` (still used by `legacyViewStateSchema`).
- `electron/view-state.ts`: import `viewLocalStateSchema` from `../shared/contracts/views`; delete line 6 `export { viewLocalStateSchema };` (its only importer, `main.ts`, no longer needs it).
- `src/demo.ts:34`: `await import('./shared')` → `await import('../shared/contracts/git')`.
- `agents/hook-client.ts:2`, `agents/pi-observer.ts:3`: `AgentPhase` from `../shared/contracts/activity`.
- Tests (import-path edits only, allowed): e.g. `tests/live-view.test.ts:3` becomes
  `import { framePoint, keyInput } from '../src/live-view';` plus `import { liveViewInputSchema, type LiveViewEvent } from '../shared/contracts/runtime';`.

Repeat until `npm run typecheck` reports no errors except in `electron/main.ts`, `electron/preload.ts`, `src/api.ts`,
`src/demo.ts` (handled in Tasks 5-8).

- [ ] **Step 3: Verify no process imports moved types from `src/`**

Run: `grep -rn "src/\(shared\|views\|db-schema\)'" electron agents src tests shared`
Expected: no output.

### Task 4: `electron/app/ipc.ts` — the single `handle()` with envelope (TDD)

- [ ] **Step 1: Append tests to `tests/contracts.test.ts`**

```ts
import { handle, registerContract, type IpcContext } from '../electron/app/ipc';

function fakeIpc(url = 'file:///app/dist/index.html') {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  const mainFrame = { url };
  const webContents = { mainFrame };
  const logged: string[] = [];
  const ctx: IpcContext = {
    ipcMain: { handle: (name: string, fn: any) => { handlers.set(name, fn); } } as IpcContext['ipcMain'],
    window: () => ({ webContents }) as any,
    rendererUrl: url,
    log: message => { logged.push(message); },
  };
  return { ctx, handlers, trusted: { sender: webContents, senderFrame: mainFrame }, logged };
}

test('handle(): untrusted sender or subframe throws and never calls the action; bad args throw a ZodError', async () => {
  const { ctx, handlers, trusted } = fakeIpc();
  let calls = 0;
  handle(ctx, 'x.y', z.tuple([z.string()]), () => { calls++; });
  const h = handlers.get('x.y')!;
  for (const event of [{ sender: {}, senderFrame: trusted.senderFrame }, { sender: trusted.sender, senderFrame: {} },
    { sender: trusted.sender, senderFrame: { url: 'https://evil.example/' } }]) {
    await assert.rejects(h(event, 'a'), /Untrusted IPC sender\./);
  }
  await assert.rejects(h(trusted, 42), (e: Error) => e.name === 'ZodError');
  assert.equal(calls, 0);
  assert.deepEqual(await h(trusted, 'a'), { ok: true, value: undefined });
  assert.equal(calls, 1);
});

test('failure isolation rule 1: a throwing handler returns { ok: false } and is logged; the other still answers', async () => {
  const { ctx, handlers, trusted, logged } = fakeIpc();
  const c = defineContract('iso', { invoke: { bad: [z.tuple([]), returns<number>()], good: [z.tuple([]), returns<number>()] }, events: {} });
  registerContract(ctx, c, { bad: () => { throw new Error('boom'); }, good: async () => 7 });
  assert.deepEqual(await handlers.get('iso.bad')!(trusted), { ok: false, error: { message: 'boom' } });
  assert.deepEqual(await handlers.get('iso.good')!(trusted), { ok: true, value: 7 });
  assert.ok(logged.some(m => m.includes('iso.bad')));
});
```

- [ ] **Step 2: Run** — FAIL `Cannot find module '../electron/app/ipc'`.

- [ ] **Step 3: Create `electron/app/ipc.ts`**

```ts
// The single IPC entry of the main process: trusted-sender check, zod argument parse (both throw: trust boundary),
// then the action inside an error envelope so a failing handler never leaves an unhandled rejection (rule 1).
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import { channel, rendererName, type Contract, type Handlers, type IpcResult } from '../../shared/contracts/define';

export interface IpcContext {
  ipcMain: Pick<IpcMain, 'handle'>;
  window(): BrowserWindow | undefined;
  rendererUrl: string;
  log?: (message: string, error: unknown) => void;
}

export function handle(ctx: IpcContext, name: string, schema: z.ZodType, action: (...args: any[]) => unknown): void {
  ctx.ipcMain.handle(name, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<IpcResult<unknown>> => {
    const win = ctx.window();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame.url.split('#')[0] !== ctx.rendererUrl) throw new Error('Untrusted IPC sender.');
    const parsed = schema.parse(args) as unknown[];
    try { return { ok: true, value: await action(...parsed) }; } catch (error) {
      (ctx.log ?? console.error)(`IPC ${name} failed:`, error);
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  });
}

/** Registers every route of a contract; `handlers` must have exactly the contract's flat names (tsc). */
export function registerContract<C extends Contract>(ctx: IpcContext, contract: C, handlers: Handlers<C>): void {
  for (const [member, entry] of Object.entries(contract.invoke)) {
    const action = (handlers as Record<string, (...args: any[]) => unknown>)[rendererName(member, entry)];
    handle(ctx, channel(contract.feature, member), entry[0], action);
  }
}
```

- [ ] **Step 4: Run** — `npx tsx --test tests/contracts.test.ts` → PASS.

### Task 5: Preload built from the contracts (TDD)

- [ ] **Step 1: Append tests**

```ts
import { buildPreloadApi } from '../electron/adapters/driving/ipc/build-api';

test('buildPreloadApi: one function per route/event, right channel, trailing undefined dropped, envelope unwrapped', async () => {
  const invoked: unknown[][] = [];
  const listeners = new Map<string, Function>();
  const replies: Record<string, unknown> = { 'views.view': { ok: true, value: 'v' }, 'git.gitState': { ok: false, error: { message: 'Workspace not found.' } } };
  const api = buildPreloadApi([...contracts], {
    invoke: async (name: string, ...args: unknown[]) => { invoked.push([name, ...args]); return replies[name] ?? { ok: true, value: null }; },
    on: (name: string, fn: Function) => { listeners.set(name, fn); return undefined as any; },
    removeListener: (name: string) => { listeners.delete(name); return undefined as any; },
  } as any) as Record<string, any>;
  const routes = contracts.reduce((n, c) => n + Object.keys(c.invoke).length + Object.keys(c.events).length, 0);
  assert.equal(Object.keys(api).length, routes + 1); // + mode
  assert.equal(api.mode, 'desktop');
  assert.equal(await api.view('id', 'database', undefined), 'v');
  assert.deepEqual(invoked.at(-1), ['views.view', 'id', 'database']);
  await api.codegraphSettings();
  assert.deepEqual(invoked.at(-1), ['stinggraph.settings']);
  await assert.rejects(api.gitState('id'), /^Error: Workspace not found\.$/);
  const got: unknown[] = [];
  const off = api.onTerminal((p: unknown) => got.push(p));
  listeners.get('terminals.onTerminal')!({}, { id: 't' });
  assert.deepEqual(got, [{ id: 't' }]);
  off();
  assert.equal(listeners.has('terminals.onTerminal'), false);
});
```

- [ ] **Step 2: Run** — FAIL (module missing).

- [ ] **Step 3: Create `electron/adapters/driving/ipc/build-api.ts`**

```ts
// window.stingray from the contracts: one invoke per route (unwrapping the IpcResult envelope), one subscribe per event.
import type { IpcRenderer } from 'electron';
import { channel, rendererName, type Contract, type IpcResult } from '../../../../shared/contracts/define';

const trimTrailingUndefined = (args: unknown[]) => { const out = [...args]; while (out.length && out.at(-1) === undefined) out.pop(); return out; };

export function buildPreloadApi(contracts: readonly Contract[], ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>) {
  const api: Record<string, unknown> = { mode: 'desktop' };
  for (const c of contracts) {
    for (const [member, entry] of Object.entries(c.invoke)) api[rendererName(member, entry)] = async (...args: unknown[]) => {
      const result = await ipc.invoke(channel(c.feature, member), ...trimTrailingUndefined(args)) as IpcResult<unknown>;
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    for (const member of Object.keys(c.events)) api[member] = (listener: (payload: unknown) => void) => {
      const name = channel(c.feature, member);
      const h = (_event: unknown, payload: unknown) => listener(payload);
      ipc.on(name, h);
      return () => { ipc.removeListener(name, h); };
    };
  }
  return api;
}
```

- [ ] **Step 4: Replace `electron/preload.ts` with**

```ts
import { contextBridge, ipcRenderer } from 'electron';
import { contracts } from '../shared/contracts';
import { buildPreloadApi } from './adapters/driving/ipc/build-api';

contextBridge.exposeInMainWorld('stingray', buildPreloadApi(contracts, ipcRenderer));
```

- [ ] **Step 5: Run** — `npx tsx --test tests/contracts.test.ts` → PASS.

### Task 6: Event sender

- [ ] **Step 1: Create `electron/adapters/driven/electron-shell/sender.ts`**

```ts
// Typed event emitters for one contract; core services receive these as their publish ports.
import type { BrowserWindow } from 'electron';
import { channel, type Contract, type Publishers } from '../../../../shared/contracts/define';

export function sender<C extends Contract>(contract: C, win: () => BrowserWindow | undefined): Publishers<C> {
  const out: Record<string, (payload: unknown) => void> = {};
  for (const member of Object.keys(contract.events)) out[member] = payload => {
    const w = win();
    if (w && !w.isDestroyed()) w.webContents.send(channel(contract.feature, member), payload);
  };
  return out as Publishers<C>;
}
```

### Task 7: `electron/main.ts` registers one handler object per contract

- [ ] **Step 1: Imports** — delete `ipcMain` from the `electron` import and the `z` import; delete the imports of
`idSchema, urlSchema, repoPathSchema, removalConsentSchema` (line 5), `positionsSchema` (26), `viewLocalStateSchema`
(27, keep `ViewStateStore`), `EDITOR_IDS` (28, keep `EditorService`), `liveViewInputSchema` (31). Add:

```ts
import { urlSchema } from '../shared/contracts/common';
import { appContract } from '../shared/contracts/app';
import { gitContract } from '../shared/contracts/git';
import { repoMapContract } from '../shared/contracts/repo-map';
import { terminalsContract } from '../shared/contracts/terminals';
import { activityContract } from '../shared/contracts/activity';
import { stinggraphContract } from '../shared/contracts/stinggraph';
import { viewsContract } from '../shared/contracts/views';
import { runtimeContract } from '../shared/contracts/runtime';
import { registerContract, type IpcContext } from './app/ipc';
import { sender } from './adapters/driven/electron-shell/sender';
```

- [ ] **Step 2: Events** — after `let win: BrowserWindow;` add
`const currentWindow = () => (win && !win.isDestroyed() ? win : undefined);` and replace the five ad-hoc sends:
- line 47: `new ActivityService(snapshot => activityEvents.onActivity(snapshot))` with `const activityEvents = sender(activityContract, currentWindow);` declared before it;
- line 50: `new Terminals(event => terminalEvents.onTerminal(event), activity, activityShell)` with `const terminalEvents = sender(terminalsContract, currentWindow);`;
- line 59: `state => gitEvents.onStatusChanged(state)` with `const gitEvents = sender(gitContract, currentWindow);`;
- line 65: `emit: event => viewsEvents.onViewsChanged(event)` with `const viewsEvents = sender(viewsContract, currentWindow);`;
- line 66: `new LiveViews(event => runtimeEvents.onLiveView(event))` with `const runtimeEvents = sender(runtimeContract, currentWindow);`.

- [ ] **Step 3: Replace `function handle(...)` (68-74) and every `handle(...)` call (123-239)** with, inside `whenReady` after the webview hooks:

```ts
  const ipc: IpcContext = { ipcMain, window: () => win, rendererUrl };
  registerContract(ipc, appContract, {
    state: () => store.load(),
    preview: (id, url) => git.preview(id, url),
    editorSettings: () => editors.settings(),
    setEditor: editor => editors.select(editor),
    openSource: async (id, file, line) => editors.openSource((await git.workspace(id)).path, file, line),
  });
  registerContract(ipc, gitContract, { /* bodies of today's pick-repository … remove-workspace, git-state, refresh-git-state lambdas, unchanged */ });
  registerContract(ipc, repoMapContract, { repoSnapshot: id => git.repoSnapshot(id), inspectFile: (id, path) => git.inspectFile(id, path) });
  registerContract(ipc, terminalsContract, { /* terminals … close-terminal lambdas, unchanged (open-terminal-link body verbatim) */ });
  registerContract(ipc, activityContract, { /* activity, activity-view, acknowledge-activity, dismiss-activity lambdas, unchanged */ });
  registerContract(ipc, stinggraphContract, {
    codegraphSettings: () => ({ sharedBase: sharedBaseEnabled(app.getPath('userData')) }),
    setCodegraphSharedBase: enabled => setSharedBase(app.getPath('userData'), enabled),
    codegraphConflicts: id => { const shared = sharedBaseWorkspaces(app.getPath('userData'), id); return shared ? codegraph.conflicts(shared.target, shared.workspaceIds) : null; },
  });
  registerContract(ipc, viewsContract, { /* views, view, view-state, save-view-state, save-view-as, open-service-docs lambdas, unchanged */ });
  registerContract(ipc, runtimeContract, { /* containers … live-view-ack lambdas, unchanged */ });
```

Write out every handler: the key is the route's flat name (table below), the value is the existing lambda body from
the listed line, copied without change:

| Key | Today (`electron/main.ts`) | Key | Today |
|---|---|---|---|
| `pickRepository` | 124-127 | `terminals` | 204 |
| `openRepository` | 128 | `terminalSnapshot` | 205 |
| `pickCloneParent` | 129-132 | `createTerminal` | 206 |
| `cloneRepository` | 134-138 (with `cloning` flag) | `writeTerminal` | 207 |
| `createWorkspace` | 139 | `openTerminalLink` | 208-228 (with `openingLink`) |
| `reviewRemoval` | 140 | `resizeTerminal` | 229 |
| `removeWorkspace` | 141-147 | `closeTerminal` | 230 |
| `gitState` | 231 | `activity` | 194 |
| `refreshGitState` | 232 | `activityView` | 195-198 |
| `views` | 161 | `acknowledgeActivity` | 199-201 |
| `view` | 164-165 | `dismissActivity` | 202 |
| `viewState` | 166 | `containers` | 188 |
| `saveViewState` | 167 | `stopContainer` | 189 |
| `saveViewAs` | 168-171 | `containerLogs` | 190 |
| `openServiceDocs` | 183-187 | `inspectCdp` | 191 |
| `liveViewStart` | 234-235 | `ports` | 192 |
| `liveViewInput` | 236 | `liveViewResize` | 237 |
| `liveViewStop` | 238 | `liveViewAck` | 239 |

The `viewIdSchema` (163) and `frameSize` (233) constants are deleted (now in the contracts). `did-start-loading` /
`closed` / `close` hooks (203, 241-258) stay where they are.

- [ ] **Step 4: Verify the acceptance greps**

Run: `grep -n "ipcMain.handle\|z\.tuple" electron/main.ts electron/preload.ts`
Expected: no output.

### Task 8: Per-feature demos

- [ ] **Step 1: Create `src/shared/demo-context.ts`**

```ts
// Shared browser-demo state, owned by src/demo.ts and passed to every feature's createXDemo(ctx).
import type { RepoFile } from '../../shared/contracts/repo-map';
import type { State } from '../../shared/contracts/git';
import type { TerminalEvent, TerminalInfo } from '../../shared/contracts/terminals';

export interface DemoContext {
  state: State;
  terminals: (TerminalInfo & { buffer: string })[];
  terminalListeners: Set<(event: TerminalEvent) => void>;
  snapshot(): State;
  save(): State;
  mainId: string;
  files: RepoFile[];
  content(path: string): string;
  uncommitted: { kind: 'available'; added: number; deleted: number; binaryFiles: number };
}
```

- [ ] **Step 2: Create the nine demo files.** Each exports one factory typed against its contract; bodies are moved
verbatim from `src/demo.ts`'s `demoAPI` (lines 205-314) with these renames only: `state` → `ctx.state`, `save()` →
`ctx.save()`, `snapshot()` → `ctx.snapshot()`, `terminalList` → `ctx.terminals`, `listeners` →
`ctx.terminalListeners`, `mainId` → `ctx.mainId`, `demoFiles` → `ctx.files`, `demoContent` → `ctx.content`,
`demoUncommitted` → `ctx.uncommitted`, `demoAPI.gitState(id)` → `git.gitState(id)` (self-reference inside the git
factory).

| File | Signature | Members (from `demoAPI`) and helpers moved with them |
|---|---|---|
| `src/features/app/demo.ts` | `createAppDemo(ctx): Invoke<typeof appContract> & Events<typeof appContract>` | `state`, `preview`, `editorSettings`, `setEditor`, `openSource`; the `editor` variable |
| `src/features/git/demo.ts` | `createGitDemo(ctx)` | `pickRepository`, `openRepository`, `pickCloneParent`, `cloneRepository`, `createWorkspace`, `reviewRemoval`, `removeWorkspace`, `gitState`, `refreshGitState`, `onStatusChanged: () => () => {}` (was `onGitStateChanged`); `demoGitStatus`, `demoPullRequest` |
| `src/features/repo-map/demo.ts` | `createRepoMapDemo(ctx)` | `repoSnapshot`, `inspectFile` |
| `src/features/terminals/demo.ts` | `createTerminalsDemo(ctx)` | `terminals`, `terminalSnapshot`, `createTerminal`, `writeTerminal`, `openTerminalLink`, `resizeTerminal`, `closeTerminal`, `onTerminal` |
| `src/features/activity/demo.ts` | `createActivityDemo(ctx)` | `activity`, `activityView`, `acknowledgeActivity`, `dismissActivity`, `onActivity` |
| `src/features/stinggraph/demo.ts` | `createStinggraphDemo(ctx)` | `codegraphSettings`, `setCodegraphSharedBase`, `codegraphConflicts` |
| `src/features/views/demo.ts` | `createViewsDemo(ctx)` | `views`, `view`, `viewState`, `saveViewState`, `saveViewAs`, `openServiceDocs`, `onViewsChanged`; every views helper of `src/demo.ts` (`repoViews`, `savedViews`, `viewStates`, `demoView`, `demoLoginSequence`, `demoDiagnostics`, `flowNode`, `flowEdge`, `branch`, `CORE_TABLES`, …) |
| `src/features/runtime/demo.ts` | `createRuntimeDemo(ctx)` | `containers`, `stopContainer`, `containerLogs`, `inspectCdp`, `ports`, `liveViewStart`, `liveViewInput`, `liveViewResize`, `liveViewStop`, `liveViewAck`, `onLiveView`; `demoTestEnvStopped` |
| `src/features/db-schema/demo.ts` | data only: `export const demoDbSchema` (+ `column`, `fk`, `timestamps`) | none (no routes) |

`src/features/views/demo.ts` imports `demoDbSchema` from `../db-schema/demo` (plan 04 switches it to the feature's `index.ts`).
Each factory file starts like this (git shown):

```ts
import type { Events, Invoke } from '../../../shared/contracts/define';
import type { gitContract, GitStatus, PullRequestStatus } from '../../../shared/contracts/git';
import type { DemoContext } from '../../shared/demo-context';

export function createGitDemo(ctx: DemoContext): Invoke<typeof gitContract> & Events<typeof gitContract> {
  const demoGitStatus = async (id: string): Promise<GitStatus> => ({ /* body of src/demo.ts:200, with ctx renames */ });
  const demoPullRequest = async (id: string): Promise<PullRequestStatus> => { /* src/demo.ts:201-205 */ };
  const git: Invoke<typeof gitContract> & Events<typeof gitContract> = {
    /* members listed above, verbatim with ctx renames */
  };
  return git;
}
```
(`import type { gitContract }` is valid because only `typeof gitContract` is used.)

- [ ] **Step 3: Reduce `src/demo.ts` to state + assembly**

Keep `repoId`, `mainId`, `demoContent`, `demoFiles`, `initial`, the localStorage load (line 34), and replace everything else with:

```ts
const ctx: DemoContext = {
  state, terminals: [], terminalListeners: new Set(),
  snapshot: () => structuredClone(ctx.state),
  save: () => { localStorage.setItem('stingray-demo-v1', JSON.stringify(ctx.state)); return ctx.snapshot(); },
  mainId, files: demoFiles, content: demoContent,
  uncommitted: { kind: 'available', added: 6, deleted: 2, binaryFiles: 0 },
};
export const demoAPI: DesktopAPI = {
  mode: 'demo',
  ...createAppDemo(ctx), ...createGitDemo(ctx), ...createRepoMapDemo(ctx), ...createTerminalsDemo(ctx),
  ...createActivityDemo(ctx), ...createStinggraphDemo(ctx), ...createViewsDemo(ctx), ...createRuntimeDemo(ctx),
};
```

- [ ] **Step 4: Rename the git event in the renderer** — `src/useGitState.ts:19` `api.onGitStateChanged(publish)` → `api.onStatusChanged(publish)`; update the comment on line 6 (`'git-state-changed' events` → `git.onStatusChanged events`).

- [ ] **Step 5: Append the demo key test to `tests/contracts.test.ts`**

```ts
test('demoAPI has exactly the keys of DesktopAPI', async () => {
  const { demoAPI } = await import('../src/demo');
  const expected = new Set(['mode']);
  for (const c of contracts) {
    for (const [member, entry] of Object.entries(c.invoke)) expected.add(rendererName(member, entry));
    for (const member of Object.keys(c.events)) expected.add(member);
  }
  assert.deepEqual(Object.keys(demoAPI).sort(), [...expected].sort());
});
```

- [ ] **Step 6: Run** — `npm run typecheck && npx tsx --test tests/contracts.test.ts` → PASS. Also check that removing a member from one demo factory fails `npm run typecheck` (try once, then revert).

### Task 9: Bridge selection, missing-bridge screen, DEMO badge (audit 19, TDD)

- [ ] **Step 1: Append tests**

```ts
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { BridgeMissingError, pickApi } from '../src/app/pick-api';
import { DemoBadge } from '../src/app/DemoBadge';

test('pickApi: plain browser always demo; ?demo only in dev Electron; otherwise bridge or BridgeMissingError', async () => {
  const bridge = { mode: 'desktop' } as any, demo = { mode: 'demo' } as any;
  const pick = (o: { electron: boolean; dev: boolean; search: string; bridge?: unknown }) =>
    pickApi({ bridge: o.bridge as any, userAgent: o.electron ? 'Mozilla/5.0 Electron/45.2.3' : 'Mozilla/5.0 Chrome/140', search: o.search, dev: o.dev, loadDemo: async () => demo });
  assert.equal(await pick({ electron: false, dev: false, search: '' }), demo);
  assert.equal(await pick({ electron: false, dev: false, search: '?demo' }), demo);
  assert.equal(await pick({ electron: true, dev: true, search: '?demo', bridge }), demo);
  assert.equal(await pick({ electron: true, dev: true, search: '?demo' }), demo);
  assert.equal(await pick({ electron: true, dev: false, search: '?demo', bridge }), bridge);
  assert.throws(() => pick({ electron: true, dev: false, search: '?demo' }), BridgeMissingError);
  assert.equal(await pick({ electron: true, dev: false, search: '', bridge }), bridge);
  assert.throws(() => pick({ electron: true, dev: true, search: '' }), BridgeMissingError);
});

test('DemoBadge renders DEMO only in demo mode', () => {
  const demo = renderToStaticMarkup(createElement(DemoBadge, { mode: 'demo' }));
  assert.match(demo, /DEMO/);
  assert.match(demo, /role="status"/);
  assert.match(demo, /aria-label="Demo data"/);
  assert.equal(renderToStaticMarkup(createElement(DemoBadge, { mode: 'desktop' })), '');
});
```

- [ ] **Step 2: Run** — FAIL (modules missing).

- [ ] **Step 3: Create `src/app/pick-api.ts`**

```ts
import type { DesktopAPI } from '../../shared/contracts';

export class BridgeMissingError extends Error {
  name = 'BridgeMissingError';
  constructor() { super('Stingray desktop bridge is missing: the preload script did not load. Check the main-process log.'); }
}

/** Plain browser: demo. Inside Electron: the preload bridge; `?demo` only in a dev renderer build; no bridge is an error. */
export function pickApi(o: { bridge?: DesktopAPI; userAgent: string; search: string; dev: boolean; loadDemo: () => Promise<DesktopAPI> }): Promise<DesktopAPI> {
  if (!o.userAgent.includes('Electron')) return o.loadDemo();
  if (o.dev && new URLSearchParams(o.search).has('demo')) return o.loadDemo();
  if (o.bridge) return Promise.resolve(o.bridge);
  throw new BridgeMissingError();
}
```

- [ ] **Step 4: Create `src/app/DemoBadge.tsx`**

```tsx
export function DemoBadge({ mode }: { mode: 'desktop' | 'demo' }) {
  return mode === 'demo' ? <span className="demo-badge" role="status" aria-label="Demo data">DEMO</span> : null;
}
```
Add to `src/styles.css`: `.demo-badge { margin-left: 8px; padding: 0 6px; border-radius: 4px; background: #e07850; color: #151110; font-weight: 700; font-size: 10px; letter-spacing: .06em; }`.

- [ ] **Step 5: Replace `src/api.ts`**

```ts
import type { DesktopAPI } from '../shared/contracts';
import { pickApi } from './app/pick-api';

declare global { interface Window { stingray?: DesktopAPI } }
export const api: DesktopAPI = await pickApi({
  bridge: window.stingray, userAgent: navigator.userAgent, search: location.search, dev: import.meta.env.DEV,
  loadDemo: async () => (await import('./demo')).demoAPI,
});
```

- [ ] **Step 6: `src/main.tsx` — load `App` dynamically; show the missing-bridge screen with plain DOM**

Replace line 3 `import App from './App';` and line 11 with:

```tsx
import('./App').then(({ default: App }) => {
  createRoot(document.getElementById('root')!).render(<Boundary><App /></Boundary>);
}, (error: Error) => {
  if (error?.name !== 'BridgeMissingError') throw error;
  const main = document.createElement('main'); main.className = 'welcome';
  const h1 = document.createElement('h1'); h1.textContent = 'Stingray desktop bridge is missing: the preload script did not load. Check the main-process log.';
  main.append(h1); document.getElementById('root')!.replaceChildren(main);
});
```

- [ ] **Step 7: Show the badge in `src/App.tsx`** — import `{ DemoBadge } from './app/DemoBadge'` and insert
`<DemoBadge mode={api.mode} />` right after the opening `<span>` of the second status-bar group (line 221, before
`<span title={api.mode === 'demo' …`). The existing `demo-banner` (line 164) stays.

- [ ] **Step 8: Run** — `npx tsx --test tests/contracts.test.ts` → PASS.

### Task 10: e2e raw channel names, desktop badge check, preload bundle check

- [ ] **Step 1: Raw channel strings (string renames only)**

- `tests/repo-map.mjs`: every `'repo-snapshot'` → `'repo-map.repoSnapshot'` (lines 137, 139 ×2, 308, 329, 330 ×2, 336 ×2); every `'inspect-file'` → `'repo-map.inspectFile'` (lines 101, 261, 321).
- `tests/terminal-links.mjs:171`: `'open-terminal-link'` → `'terminals.openTerminalLink'`.
- `tests/worktree-removal.mjs:48`: `'activity-event'` → `'activity.onActivity'`.

Run `grep -n "'repo-snapshot'\|'inspect-file'\|'open-terminal-link'\|'activity-event'" tests/*.mjs` → no output.

- [ ] **Step 2: New desktop check** — in `tests/desktop.mjs`, directly after the first `check(...)` that runs with the
desktop bridge loaded (after line 98), add:

```js
  check('no DEMO badge in desktop mode', await page.getByRole('status', { name: 'Demo data', exact: true }).count() === 0);
```

- [ ] **Step 3: Preload bundle test** — append to `tests/contracts.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
test('built preload bundles zod and the contracts: no require() other than electron', { skip: !existsSync('dist-electron/preload.cjs') }, () => {
  const requires = [...readFileSync('dist-electron/preload.cjs', 'utf8').matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(requires)], ['electron']);
});
```

- [ ] **Step 4: Ledger** — append one row: `| 03 | tests/repo-map.mjs, tests/terminal-links.mjs:171, tests/worktree-removal.mjs:48 | kebab channels | feature.member channels | String renames only (spec 03); no assertion changed. |` and `| 03 | tests/desktop.mjs | — | new check "no DEMO badge in desktop mode" | New check. |`

### Task 11: Verify and commit

- [ ] **Step 1: Full checks**

Run: `npm run check 2>&1 | tail -n 12 && npm run test:e2e`
Expected: `# fail 0`; all 8 e2e suites `PASS`.

- [ ] **Step 2: Manual audit-19 checks**

1. `npm run dev:ui`, open `http://127.0.0.1:5178/` in a browser → demo loads, `DEMO` badge visible in the status bar.
2. `npm run dev` → desktop mode, no `DEMO` badge. (`?demo` inside Electron cannot be reached by navigation — `will-navigate` and the sender check pin `rendererUrl` — so the dev/production `?demo` rule is covered by the `pickApi` table test.)
3. Temporarily set `preload: path.join(__dirname, 'missing.cjs')` in `electron/main.ts:103`, `npm run build && npm start` → the bridge-missing message is shown, no demo data. Revert.
Record the results in the PR notes section of the ledger (`## Manual checks`).

- [ ] **Step 3: Commit**

```bash
git add -A shared electron src tests docs/plans/2026-11-23-test-edit-ledger.md
git status --short
git commit -m "feat(ipc): zod contracts in shared/contracts drive main, preload, DesktopAPI and per-feature demos"
```

## Self-review

- Spec coverage: contract files + define/common/index (T1-T2), moved types and no shims (T3), `ipc.ts` with sender check, parse and envelope + rule-1 test (T4), preload loop + bundle check (T5, T10), sender (T6), main without `ipcMain.handle`/`z.tuple` (T7), demos typed against contracts + key test (T8), `pickApi`, missing-bridge screen, `DEMO` badge (T9), channel renames (T10), git event rename (T8 S4), `VIEW_KINDS` single list (T2 S8, T3).
- Type names used later: `Invoke`, `Handlers`, `Events`, `Publishers`, `IpcResult`, `registerContract`, `IpcContext`, `sender`, `buildPreloadApi`, `DemoContext`, `createXDemo`.
