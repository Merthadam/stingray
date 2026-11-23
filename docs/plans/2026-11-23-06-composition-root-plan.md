# 06 · Composition root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** `electron/main.ts` becomes `import { start } from './app'; start();`. `electron/app/` (index, compose, window,
lifecycle, removal listeners) is the only place that builds adapters and services; the remaining inline logic of main
becomes core (`CloneLock`, `TerminalLinkOpener`, `ActivityVisibility`) or Electron adapters (`dialogs.ts`, `sessions.ts`);
the app feature's `editors.ts` is split (approved clarification 6); audit 20 (webview storage cleared on removal) lands.

**Architecture:** `compose()` returns a typed `Services` object; `registerRemovalListeners()` (no Electron import, so it
is unit-testable) registers every `WorkspaceLifecycle` listener in a fixed order; `window.ts` owns the window, webview
hardening (moved verbatim), close guard and reload hooks; `lifecycle.ts` owns the quit cleanup order.

**Tech Stack:** Electron 45, TypeScript, node:test.

**Spec:** [05 — Composition root](../specs/2026-11-23-05-composition-root-design.md), [07 § 20](../specs/2026-11-23-07-audit-fixes-design.md#finding-20--webview-storage-survives-workspace-removal),
[04 § Commit 4 table](../specs/2026-11-23-04-hexagonal-modules-design.md#commit-4--moves) (`editors.ts` split).

**Depends on:** plan 05h committed. **Commit:** one, `refactor(app): composition root in electron/app; thin main; clear webview storage on removal`.

---

## Files

Create: `electron/app/{index,compose,window,lifecycle,removal-listeners}.ts`, `electron/core/git/clone-lock.ts`,
`electron/core/terminals/link-opener.ts`, `electron/core/activity/activity-visibility.ts`, `electron/core/app/{ports,index}.ts`,
`electron/adapters/driven/electron-shell/{dialogs,sessions}.ts`, `electron/adapters/driven/process/editor-launcher.ts`,
`electron/adapters/driven/fs/source-files.ts`, `electron/adapters/driving/ipc/app.ts`, `electron/app/wiring/app.ts`,
`tests/git/clone-lock.test.ts`, `tests/terminals/link-opener.test.ts`, `tests/activity/activity-visibility.test.ts`, `tests/app/editors.core.test.ts`.

Modify: `electron/main.ts` (thin), `electron/core/app/editors.ts`, `electron/adapters/driving/ipc/{git,terminals,activity}.ts`,
`tests/git/workspace-lifecycle.test.ts` (new cases), `tests/app/editors.test.ts` (import path).

---

### Task 1: `CloneLock` (TDD)

- [ ] **Step 1: `tests/git/clone-lock.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloneLock } from '../../electron/core/git';

test('a second clone while one runs is refused; busy resets after success and after an error', async () => {
  const lock = new CloneLock();
  let release!: () => void;
  const first = lock.run(() => new Promise<void>(r => { release = r; }));
  assert.equal(lock.busy, true);
  await assert.rejects(lock.run(async () => {}), /^Error: A clone is already in progress\. Wait for it to finish\.$/);
  release(); await first;
  assert.equal(lock.busy, false);
  await assert.rejects(lock.run(async () => { throw new Error('clone failed'); }), /clone failed/);
  assert.equal(lock.busy, false);
});
```
- [ ] **Step 2: Run** — FAIL. **Step 3:** `electron/core/git/clone-lock.ts`:

```ts
/** One clone at a time (main.ts `cloning` flag); the window close guard reads `busy`. */
export class CloneLock {
  private running = false;
  get busy() { return this.running; }
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.running) throw new Error('A clone is already in progress. Wait for it to finish.');
    this.running = true;
    try { return await action(); } finally { this.running = false; }
  }
}
```
Export from `core/git/index.ts`. **Step 4:** Run → PASS.

### Task 2: `TerminalLinkOpener` (TDD)

- [ ] **Step 1: `tests/terminals/link-opener.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalLinkOpener } from '../../electron/core/terminals';
import { fakeLinkTargets } from '../fakes/terminals';

const terminal = { id: 't1', workspaceId: 'w1', title: 'Terminal 1', exited: false, sequence: 0 };
function opener(confirm: () => Promise<boolean>) {
  const opened: string[] = [];
  const o = new TerminalLinkOpener({ terminals: { list: () => [terminal] }, workspacePath: async () => '/ws', confirm,
    actions: { openExternal: async u => { opened.push(u); }, openPath: async p => { opened.push(p); return ''; }, showItemInFolder: p => { opened.push(p); } },
    targets: fakeLinkTargets({}) });
  return { o, opened };
}

test('a second link during a pending confirmation is refused; unknown terminals are refused', async () => {
  let answer!: (v: boolean) => void;
  const { o, opened } = opener(() => new Promise<boolean>(r => { answer = r; }));
  const first = o.open('t1', 'https://example.com/');
  await new Promise(r => setTimeout(r, 0));
  await assert.rejects(o.open('t1', 'https://example.com/'), /^Error: Finish the current link confirmation first\.$/);
  answer(true); await first;
  assert.deepEqual(opened, ['https://example.com/']);
  await assert.rejects(o.open('nope', 'https://example.com/'), /^Error: Terminal not found\.$/);
});

test('the lock is released after the confirmation rejects', async () => {
  let calls = 0;
  const { o } = opener(async () => { if (++calls === 1) throw new Error('dialog failed'); return false; });
  await assert.rejects(o.open('t1', 'https://example.com/'), /dialog failed/);
  await o.open('t1', 'https://example.com/');
});
```
- [ ] **Step 2: Run** — FAIL. **Step 3:** `electron/core/terminals/link-opener.ts` (the `open-terminal-link` handler body of main, moved):

```ts
import type { TerminalInfo } from '../../../shared/contracts/terminals';
import type { LinkActions, LinkTargets } from './ports';
import { openTerminalLink, type TerminalLink } from './terminal-links';

/** One terminal-link confirmation at a time; the link is resolved inside the terminal's workspace. */
export class TerminalLinkOpener {
  private opening = false;
  constructor(private d: { terminals: { list(): TerminalInfo[] }; workspacePath(workspaceId: string): Promise<string>;
    confirm(link: TerminalLink): Promise<boolean>; actions: Omit<LinkActions, 'confirm'>; targets: LinkTargets }) {}
  async open(id: string, uri: string): Promise<void> {
    if (this.opening) throw new Error('Finish the current link confirmation first.');
    const terminal = this.d.terminals.list().find(t => t.id === id);
    if (!terminal) throw new Error('Terminal not found.');
    this.opening = true;
    try { await openTerminalLink(uri, await this.d.workspacePath(terminal.workspaceId), { confirm: this.d.confirm, ...this.d.actions }, this.d.targets); }
    finally { this.opening = false; }
  }
}
```
Export it (and `type TerminalLink`) from `core/terminals/index.ts`. **Step 4:** Run → PASS.

### Task 3: `ActivityVisibility` (TDD)

- [ ] **Step 1: `tests/activity/activity-visibility.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityVisibility } from '../../electron/core/activity';

function setup(focused = true) {
  const acks: [string, string, number][] = [];
  let visible = focused;
  const v = new ActivityVisibility({ terminals: { list: () => [{ id: 't1' }, { id: 't2' }] },
    activity: { acknowledge: (id, terminalId, revision) => { acks.push([id, terminalId, revision]); } }, isWindowFocusedAndVisible: () => visible });
  return { v, acks, setFocused: (f: boolean) => { visible = f; } };
}

test('unknown terminal ids are ignored; acknowledge needs a focused, visible window and a visible terminal; reset clears', () => {
  const s = setup();
  s.v.setVisible(['t1', 'unknown']);
  s.v.acknowledge('a', 'unknown', 1);
  s.v.acknowledge('a', 't2', 1);
  s.v.acknowledge('a', 't1', 1);
  assert.deepEqual(s.acks, [['a', 't1', 1]]);
  s.setFocused(false); s.v.acknowledge('a', 't1', 2);
  assert.equal(s.acks.length, 1);
  s.setFocused(true); s.v.reset(); s.v.acknowledge('a', 't1', 3);
  assert.equal(s.acks.length, 1);
});
```
- [ ] **Step 2: Run** — FAIL. **Step 3:** `electron/core/activity/activity-visibility.ts`:

```ts
import type { ActivityService } from './activity';
import type { TerminalDirectory } from './ports';

/** Which terminals the renderer shows (activity-view) and whether a completion may be acknowledged now. */
export class ActivityVisibility {
  private visible = new Set<string>();
  constructor(private d: { terminals: TerminalDirectory; activity: Pick<ActivityService, 'acknowledge'>; isWindowFocusedAndVisible(): boolean }) {}
  setVisible(ids: string[]) { const known = new Set(this.d.terminals.list().map(t => t.id)); this.visible = new Set(ids.filter(id => known.has(id))); }
  acknowledge(id: string, terminalId: string, revision: number) {
    if (this.d.isWindowFocusedAndVisible() && this.visible.has(terminalId)) this.d.activity.acknowledge(id, terminalId, revision);
  }
  /** A reloading renderer shows nothing until it reports again. */
  reset() { this.visible.clear(); }
}
```
Export from `core/activity/index.ts`. **Step 4:** Run → PASS.

### Task 4: Editors split (app feature)

- [ ] **Step 1: `electron/core/app/ports.ts`**

```ts
export interface EditorDeps {
  env: { PATH?: string; HOME?: string };
  isExecutable(file: string): Promise<boolean>;
  /** Run a CLI without a shell; rejects when it cannot start or exits non-zero. */
  launch(file: string, args: string[]): Promise<void>;
  showItemInFolder(file: string): void;
  /** Absolute real path of a regular file inside the worktree; rejects with "Choose a regular file inside this worktree." / "The file is unavailable.". */
  resolveSource(root: string, file: string): Promise<string>;
}
```
- [ ] **Step 2: `tests/app/editors.core.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorService } from '../../electron/core/app';

test('openSource launches the selected editor CLI at the line; falls back to `open -t`', async () => {
  const settings = new Map<string, string>([['editor', 'vscode']]);
  const launched: [string, string[]][] = [];
  const service = new EditorService({ get: k => settings.get(k), set: (k, v) => { settings.set(k, v); } }, {
    env: { PATH: '/bin', HOME: '/home/u' }, isExecutable: async f => f === '/bin/code', showItemInFolder: () => {},
    launch: async (file, args) => { launched.push([file, args]); }, resolveSource: async (root, file) => `${root}/${file}` });
  await service.openSource('/ws', 'a.ts', 7);
  assert.deepEqual(launched, [['/bin/code', ['-g', '/ws/a.ts:7']]]);
  await service.select('system');
  await service.openSource('/ws', 'a.ts', null);
  assert.deepEqual(launched.at(-1), ['/usr/bin/open', ['-t', '/ws/a.ts']]);
});
```
- [ ] **Step 3: Rewrite `electron/core/app/editors.ts`** — delete the node imports, `isExecutable`, `launch` and `resolveSource` (moved to adapters below) and the `database` import. `EditorDeps` comes from `./ports`. Constructor: `constructor(private readonly settingsStore: SettingsRepository, private readonly deps: EditorDeps)` (`SettingsRepository` from `../shared/ports`). Replace: `os.homedir()` → `HOME = ''` default from `deps.env` (`const { PATH = '', HOME = '' } = this.deps.env;` and skip the `~/.local/bin` entry when `HOME` is empty); `path.delimiter` → `':'`; `path.isAbsolute`/`path.join` → posix-path; `database(…).prepare('INSERT OR REPLACE …').run('editor', selected)` → `this.settingsStore.set('editor', selected)`; `saved()` reads `this.settingsStore.get('editor')`; `resolveSource(root, file)` → `this.deps.resolveSource(root, file)`. `electron/core/app/index.ts`: `export { EditorService } from './editors'; export type { EditorDeps } from './ports';`.
- [ ] **Step 4: Adapters**
  - `electron/adapters/driven/process/editor-launcher.ts`: `isExecutable` and `launch` moved verbatim from today's `editors.ts:28-37`, exported.
  - `electron/adapters/driven/fs/source-files.ts`: `resolveSource` moved verbatim from `editors.ts:96-106`, exported.
  - `electron/app/wiring/app.ts`:
```ts
import { resolveSource } from '../../adapters/driven/fs/source-files';
import { isExecutable, launch } from '../../adapters/driven/process/editor-launcher';
import { sqliteSettingsRepository } from '../../adapters/driven/sqlite/settings-repository';
import { EditorService as CoreEditorService, type EditorDeps } from '../../core/app';

export { resolveSource, type EditorDeps };
export class EditorService extends CoreEditorService {
  constructor(directory: string, deps: Partial<EditorDeps> & Pick<EditorDeps, 'showItemInFolder'>) {
    super(sqliteSettingsRepository(directory), { env: process.env, isExecutable, launch, resolveSource, ...deps });
  }
}
```
  - `tests/app/editors.test.ts`: `EditorService, resolveSource, type EditorDeps` from `../../electron/app/wiring/app` (import edit). The core `EditorDeps` now has `resolveSource`; the wiring's `Partial<EditorDeps>` keeps the test's deps objects valid.
- [ ] **Step 5: `electron/adapters/driving/ipc/app.ts`**
```ts
import type { appContract } from '../../../../shared/contracts/app';
import type { Handlers } from '../../../../shared/contracts/define';
import type { EditorService } from '../../../core/app';
import type { GitService } from '../../../core/git';

export function appHandlers(d: { git: GitService; editors: EditorService }): Handlers<typeof appContract> {
  return {
    state: () => d.git.store.load(),
    preview: (id, url) => d.git.preview(id, url),
    editorSettings: () => d.editors.settings(),
    setEditor: editor => d.editors.select(editor),
    openSource: async (id, file, line) => d.editors.openSource((await d.git.workspace(id)).path, file, line),
  };
}
```
- [ ] **Step 6: Run** — `npx tsx --test tests/app/editors*.test.ts` → PASS.

### Task 5: Electron adapters — dialogs and sessions (audit 20)

- [ ] **Step 1: `electron/adapters/driven/electron-shell/dialogs.ts`** (texts copied unchanged from today's `electron/main.ts` lines 124-132, 216-221, 245-256)

```ts
import { dialog, type BrowserWindow } from 'electron';
import type { TerminalLink } from '../../../core/terminals';

export async function pickFolder(win: BrowserWindow, title: string): Promise<string | null> {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title });
  return result.canceled ? null : result.filePaths[0];
}
export async function confirmTerminalLink(win: BrowserWindow, link: TerminalLink): Promise<boolean> {
  const action = link.kind === 'web' ? 'Open in browser' : link.kind === 'file' ? 'Open file' : 'Show in file manager';
  const { response } = await dialog.showMessageBox(win, { type: 'question', title: 'Open terminal link',
    message: action + '?', detail: link.target + '\n\nTerminal output can contain misleading links. Only open targets you trust.',
    buttons: ['Cancel', action], defaultId: 0, cancelId: 0, noLink: true });
  return response === 1;
}
export function cloneInProgress(win: BrowserWindow): void {
  void dialog.showMessageBox(win, { type: 'info', message: 'A project is still being cloned.',
    detail: 'Keep Stingray open until it finishes or reports an error (up to five minutes).', buttons: ['Keep open'] });
}
export async function confirmQuitWithTerminals(win: BrowserWindow): Promise<boolean> {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', message: 'Quit Stingray and stop running terminals?',
    detail: 'Shells and their foreground jobs will be closed. Worktrees and branches will stay on disk.',
    buttons: ['Keep working', 'Quit and stop terminals'], defaultId: 0, cancelId: 0,
  });
  return response === 1;
}
```
(Check `tests/terminals/terminal-links.mjs`: it stubs `dialog.showMessageBox` through `app.evaluate` with `holdLinkDialog`; the call still goes through Electron's `dialog` object, so the stub keeps working.)

- [ ] **Step 2: `electron/adapters/driven/electron-shell/sessions.ts`**

```ts
import { session } from 'electron';

const locked = new Set<string>();
/** Webview partitions: no permissions, no downloads (moved from electron/main.ts lockSession). */
export function lockSession(partition: string) {
  if (locked.has(partition)) return;
  locked.add(partition);
  const guest = session.fromPartition(partition);
  guest.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  guest.setPermissionCheckHandler(() => false);
  guest.on('will-download', event => event.preventDefault());
}
/** Audit 20: cookies, storage and cache of a removed workspace's browser pane. */
export async function clearWorkspaceSession(workspaceId: string) {
  const partition = 'persist:stingray-' + workspaceId;
  const guest = session.fromPartition(partition);
  await guest.clearStorageData();
  await guest.clearCache();
  locked.delete(partition);
}
```

### Task 6: Removal listeners in one place (TDD; rule 3 order, audit 20)

- [ ] **Step 1: Append to `tests/git/workspace-lifecycle.test.ts`** (reuses the file's `state`, `wid`, `wpath`, `scriptedGit` setup from plan 05d)

```ts
import { registerRemovalListeners, type RemovalParticipants } from '../../electron/app/removal-listeners';

function participants(over: Partial<RemovalParticipants> = {}) {
  const ran: string[] = [];
  const p: RemovalParticipants = {
    terminals: { closeWorkspace: () => { ran.push('terminals'); } },
    views: { release: async () => { ran.push('views'); }, reopen: () => { ran.push('views reopen'); } },
    graph: fakeReleaseHost(),
    gitState: { forget: () => { ran.push('git-state'); } },
    viewState: { forget: async () => { ran.push('view state'); } },
    activity: { forgetWorkspace: () => { ran.push('activity'); } },
    overlays: { repoOf: async () => 'r1', remove: async () => { ran.push('overlay'); } },
    sessions: { clearWorkspaceSession: async () => { ran.push('webview session'); } },
    ...over,
  };
  return { p, ran };
}
function gitWith(lifecycle: WorkspaceLifecycle, removeFails = false) {
  const runner = scriptedGit((cwd, args) => {
    const a = args.join(' ');
    if (a === 'worktree list --porcelain -z') return `worktree /repo\0branch refs/heads/main\0\0worktree ${wpath}\0branch refs/heads/feature\0\0`;
    if (a === 'branch --show-current') return cwd === wpath ? 'feature\n' : 'main\n';
    if (a.startsWith('status --porcelain=v1')) return '';
    if (a.startsWith('for-each-ref')) return '\n';
    if (a.startsWith('worktree remove')) return removeFails ? undefined : '';
    return undefined;
  });
  return new GitService({ store: new Store('/data', memoryState(state)), runner, files: pathOnlyFiles, cloner: async () => {}, lifecycle });
}
const removeVia = async (git: GitService) => git.removeWorkspace(wid, { discard: false, deleteBranch: false, fingerprint: (await git.reviewRemoval(wid)).fingerprint });

test('compose registration: afterRemove runs git-state → view state → activity → overlay → webview session', async () => {
  provideHasher(fakeHasher);
  try {
    const lifecycle = new WorkspaceLifecycle(() => {});
    const { p, ran } = participants();
    registerRemovalListeners(lifecycle, p);
    await removeVia(gitWith(lifecycle));
    const after = ran.filter(r => ['git-state', 'view state', 'activity', 'overlay', 'webview session'].includes(r));
    assert.deepEqual(after, ['git-state', 'view state', 'activity', 'overlay', 'webview session']);
  } finally { resetCorePorts(); }
});

test('audit 20: the webview session is cleared once after success, never on failure; its rejection does not fail removal', async () => {
  provideHasher(fakeHasher);
  try {
    let cleared = 0;
    const ok = new WorkspaceLifecycle(() => {});
    registerRemovalListeners(ok, participants({ sessions: { clearWorkspaceSession: async () => { cleared++; throw new Error('session busy'); } } }).p);
    assert.ok('state' in await removeVia(gitWith(ok)));
    assert.equal(cleared, 1);
    const failing = new WorkspaceLifecycle(() => {});
    const f = participants({ sessions: { clearWorkspaceSession: async () => { cleared++; } } });
    registerRemovalListeners(failing, f.p);
    await assert.rejects(removeVia(gitWith(failing, true)), /Git could not remove the worktree/);
    assert.equal(cleared, 1, 'not on failure');
    assert.ok(!f.ran.some(r => ['git-state', 'view state', 'activity', 'overlay'].includes(r)), 'a failing git.removeWorkspace runs no afterRemove listener');
    assert.ok(f.ran.includes('views reopen'));
  } finally { resetCorePorts(); }
});

test('compose registration: a view-state rejection does not fail the removal', async () => {
  provideHasher(fakeHasher);
  try {
    const lifecycle = new WorkspaceLifecycle(() => {});
    const { p, ran } = participants({ viewState: { forget: async () => { throw new Error('db locked'); } } });
    registerRemovalListeners(lifecycle, p);
    assert.ok('state' in await removeVia(gitWith(lifecycle)));
    assert.ok(ran.includes('activity') && ran.includes('webview session'));
  } finally { resetCorePorts(); }
});
```

- [ ] **Step 2: Run** — FAIL (module missing).

- [ ] **Step 3: `electron/app/removal-listeners.ts`** (no Electron import; the order below is the contract)

```ts
// Every side effect of removing a workspace, as WorkspaceLifecycle listeners (rule 3). Blocking: terminals and the
// code-graph release only. afterRemove order: git-state, view state, activity, overlay, webview session (last, audit 20).
import type { WorkspaceLifecycle } from '../core/git';
import { releaseWorkspace, type GraphReleaseHost } from '../core/stinggraph';

export interface RemovalParticipants {
  terminals: { closeWorkspace(id: string): void };
  views: { release(id: string): Promise<void>; reopen(id: string): void };
  graph: GraphReleaseHost;
  gitState: { forget(id: string): void };
  viewState: { forget(id: string): Promise<void> };
  activity: { forgetWorkspace(id: string): void };
  overlays: { repoOf(id: string): Promise<string | undefined>; remove(repoId: string, id: string): Promise<void> };
  sessions: { clearWorkspaceSession(id: string): Promise<void> };
}

export function registerRemovalListeners(lifecycle: WorkspaceLifecycle, p: RemovalParticipants) {
  const overlayRepos = new Map<string, string>(); // repoId captured while the registration still exists
  lifecycle.onBeforeRemove('terminals', id => p.terminals.closeWorkspace(id), { blocking: true });
  lifecycle.onBeforeRemove('views', id => p.views.release(id));
  lifecycle.onBeforeRemove('stinggraph', id => releaseWorkspace(p.graph, id), { blocking: true });
  lifecycle.onBeforeRemove('stinggraph overlay', async id => { const repoId = await p.overlays.repoOf(id); if (repoId) overlayRepos.set(id, repoId); });
  lifecycle.onRemoveFailed('views', id => p.views.reopen(id));
  lifecycle.onRemoveFailed('stinggraph overlay', id => { overlayRepos.delete(id); });
  lifecycle.onAfterRemove('git-state', id => p.gitState.forget(id));
  lifecycle.onAfterRemove('view state', id => p.viewState.forget(id));
  lifecycle.onAfterRemove('activity', id => p.activity.forgetWorkspace(id));
  lifecycle.onAfterRemove('stinggraph overlay', async id => { const repoId = overlayRepos.get(id); overlayRepos.delete(id); if (repoId) await p.overlays.remove(repoId, id); });
  lifecycle.onAfterRemove('webview session', id => p.sessions.clearWorkspaceSession(id));
}
```
- [ ] **Step 4: Run** — PASS. (The registration order "git-state → view state → activity → webview session" is what spec 05 names; the overlay listener sits before the webview session, which stays last.)

### Task 7: `compose.ts`, `window.ts`, `lifecycle.ts`, `index.ts`, thin `main.ts`

Move code; do not change texts, order or checks. Line numbers are those of `electron/main.ts` as it is at the start of this plan; map them by content.

- [ ] **Step 1: `electron/app/compose.ts`**

```ts
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { activityContract } from '../../shared/contracts/activity';
import { gitContract } from '../../shared/contracts/git';
import { runtimeContract } from '../../shared/contracts/runtime';
import { terminalsContract } from '../../shared/contracts/terminals';
import { viewsContract } from '../../shared/contracts/views';
import { sender } from '../adapters/driven/electron-shell/sender';
import { clearWorkspaceSession } from '../adapters/driven/electron-shell/sessions';
import { electronShell } from '../adapters/driven/electron-shell/shell';
import { confirmTerminalLink } from '../adapters/driven/electron-shell/dialogs';
import { nodeLinkTargets } from '../adapters/driven/fs/link-targets';
import { sqliteSettingsRepository } from '../adapters/driven/sqlite/settings-repository';
import { database, readState } from '../adapters/driven/sqlite/database';
import { ActivityVisibility } from '../core/activity';
import { CloneLock, WorkspaceLifecycle } from '../core/git';
import { StinggraphSettings } from '../core/stinggraph';
import { TerminalLinkOpener } from '../core/terminals';
import { registerRemovalListeners } from './removal-listeners';
import { ActivityShell, ActivityService } from './wiring/activity';
import { EditorService } from './wiring/app';
import { GitService, GitStateService, PullRequestService, Store } from './wiring/git';
import { ContainerService, LiveViews, PortService } from './wiring/runtime';
import { createCodeGraphProcessHost, removeOverlay } from './wiring/stinggraph';
import { Terminals } from './wiring/terminals';
import { ViewService, ViewStateStore } from './wiring/views';

export function compose(o: { dataDir: string; distDir: string; window: () => BrowserWindow | undefined }) {
  const window = () => { const w = o.window(); return w && !w.isDestroyed() ? w : undefined; };
  const lifecycle = new WorkspaceLifecycle();
  const store = new Store(o.dataDir);
  const viewState = new ViewStateStore(o.dataDir);
  const editors = new EditorService(o.dataDir, { showItemInFolder: file => electronShell.showItemInFolder(file) });
  const activity = new ActivityService(snapshot => sender(activityContract, window).onActivity(snapshot));
  const activityShell = new ActivityShell();
  const terminals = new Terminals(event => sender(terminalsContract, window).onTerminal(event), activity, activityShell);
  const git = new GitService(store, id => terminals.countWorkspace(id), undefined, lifecycle);
  const containers = new ContainerService();
  const ports = new PortService(() => terminals.portRoots());
  const pullRequests = new PullRequestService();
  const visible = () => { const w = window(); return Boolean(w && w.isVisible() && !w.isMinimized()); };
  const gitState = new GitStateService(git, pullRequests, state => sender(gitContract, window).onStatusChanged(state), visible);
  git.onStatus = (id, status) => gitState.observe(id, status);
  pullRequests.onListChange = () => gitState.listChanged();
  const stinggraphSettings = new StinggraphSettings(sqliteSettingsRepository(o.dataDir), () => readState(database(o.dataDir)), o.dataDir);
  const codegraph = createCodeGraphProcessHost({ sharedBase: id => stinggraphSettings.sharedBaseTarget(id) });
  const grammarPath = path.join(o.distDir, 'tree-sitter-python.wasm');
  const views = new ViewService({ host: codegraph, grammarPath, emit: event => sender(viewsContract, window).onViewsChanged(event),
    dbSchema: { dbSchema: (id, root) => codegraph.dbSchema(id, root, grammarPath), sqlSchema: (id, root) => codegraph.sqlSchema(id, root) } });
  const liveViews = new LiveViews(event => sender(runtimeContract, window).onLiveView(event));
  const cloneLock = new CloneLock();
  const visibility = new ActivityVisibility({ terminals, activity,
    isWindowFocusedAndVisible: () => { const w = window(); return Boolean(w && w.isFocused() && w.isVisible() && !w.isMinimized()); } });
  const linkOpener = new TerminalLinkOpener({ terminals, workspacePath: async id => (await git.workspace(id)).path,
    confirm: link => { const w = window(); return w ? confirmTerminalLink(w, link) : Promise.resolve(false); },
    actions: electronShell, targets: nodeLinkTargets });
  registerRemovalListeners(lifecycle, {
    terminals, views, graph: codegraph, gitState, viewState, activity,
    overlays: { repoOf: async id => (await store.load()).workspaces.find(w => w.id === id)?.repoId, remove: (repoId, id) => removeOverlay(o.dataDir, repoId, id) },
    sessions: { clearWorkspaceSession },
  });
  return { store, viewState, editors, activity, activityShell, terminals, git, containers, ports, pullRequests, gitState,
    stinggraphSettings, codegraph, views, liveViews, cloneLock, visibility, linkOpener, lifecycle };
}
export type Services = ReturnType<typeof compose>;
```
(The five `sender(…)` calls are cheap; if preferred, create each sender once at the top — no behaviour difference.)
Add `startServices(services, o: { dataDir: string; distDir: string; execPath: string })` in the same file with today's `whenReady` lines 84-98 verbatim (launcher install into `<dataDir>/bin`, activity socket, shell prepare, history restore via `new ActivityHistory(dataDir)` from `./wiring/activity`), same order and the same `try/catch`.

- [ ] **Step 2: `electron/app/window.ts`**

```ts
import { BrowserWindow, app } from 'electron';
import { urlSchema } from '../../shared/contracts/common';
import { cloneInProgress, confirmQuitWithTerminals } from '../adapters/driven/electron-shell/dialogs';

export function focusExisting(win: BrowserWindow | undefined) {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}
export function createMainWindow(o: { rendererUrl: string; preload: string; lockSession(partition: string): void }): BrowserWindow {
  // today's electron/main.ts lines 99-122 verbatim (BrowserWindow options, setWindowOpenHandler, will-navigate,
  // will-attach-webview, did-attach-webview), with `rendererUrl`/`lockSession` from `o` and `preload: o.preload`.
}
export function guardClose(win: BrowserWindow, o: { cloneBusy(): boolean; runningTerminals(): boolean }) {
  let quitting = false;
  win.on('close', event => {
    if (o.cloneBusy()) { event.preventDefault(); cloneInProgress(win); return; }
    if (!quitting && o.runningTerminals()) {
      event.preventDefault();
      void confirmQuitWithTerminals(win).then(quit => { if (quit) { quitting = true; app.quit(); } });
    }
  });
}
/** A reloaded renderer has lost its session ids and visible terminals; a closed window has no viewer. */
export function onRendererReset(win: BrowserWindow, reset: () => void, closed: () => void) {
  win.webContents.on('did-start-loading', reset);
  win.on('closed', closed);
}
```

- [ ] **Step 3: `electron/app/lifecycle.ts`**

```ts
import { app } from 'electron';
import { closeDatabase } from '../adapters/driven/sqlite/database';
import type { Services } from './compose';

/** Quit cleanup, same order as before: flush history → close terminals → dispose git state → close activity + views → close database. */
export function registerQuit(s: Services, dataDir: string) {
  app.on('window-all-closed', () => app.quit());
  let cleanedUp = false;
  app.on('will-quit', event => {
    if (cleanedUp) return;
    event.preventDefault(); s.activity.flushHistory(); s.terminals.closeAll(); s.gitState.dispose(); // flush first: closing terminals drops their entries
    void Promise.allSettled([s.activity.close(), s.views.dispose()]).finally(() => { closeDatabase(dataDir); cleanedUp = true; app.quit(); });
  });
}
```

- [ ] **Step 4: `electron/app/index.ts`**

```ts
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { appContract } from '../../shared/contracts/app';
import { activityContract } from '../../shared/contracts/activity';
import { gitContract } from '../../shared/contracts/git';
import { repoMapContract } from '../../shared/contracts/repo-map';
import { runtimeContract } from '../../shared/contracts/runtime';
import { stinggraphContract } from '../../shared/contracts/stinggraph';
import { terminalsContract } from '../../shared/contracts/terminals';
import { viewsContract } from '../../shared/contracts/views';
import { pickFolder } from '../adapters/driven/electron-shell/dialogs';
import { electronClipboard } from '../adapters/driven/electron-shell/clipboard';
import { lockSession } from '../adapters/driven/electron-shell/sessions';
import { electronShell } from '../adapters/driven/electron-shell/shell';
import { openApp } from '../adapters/driven/process/open-app';
import { activityHandlers } from '../adapters/driving/ipc/activity';
import { appHandlers } from '../adapters/driving/ipc/app';
import { gitHandlers } from '../adapters/driving/ipc/git';
import { repoMapHandlers } from '../adapters/driving/ipc/repo-map';
import { runtimeHandlers } from '../adapters/driving/ipc/runtime';
import { stinggraphHandlers } from '../adapters/driving/ipc/stinggraph';
import { terminalsHandlers } from '../adapters/driving/ipc/terminals';
import { viewsHandlers } from '../adapters/driving/ipc/views';
import { inspectCdp } from '../core/runtime';
import { compose, startServices } from './compose';
import { registerContract, type IpcContext } from './ipc';
import { registerQuit } from './lifecycle';
import { createMainWindow, focusExisting, guardClose, onRendererReset } from './window';
import { saveViewAs } from './wiring/views';

export function start() {
  // today's electron/main.ts lines 33-38 (step-1 version) verbatim: app name, STINGRAY_DATA_DIR, dev URL check, rendererUrl, single-instance lock
  let win: BrowserWindow | undefined;
  app.on('second-instance', () => focusExisting(win));
  const dataDir = app.getPath('userData');
  const s = compose({ dataDir, distDir: __dirname, window: () => win });
  app.whenReady().then(async () => {
    await startServices(s, { dataDir, distDir: __dirname, execPath: process.execPath });
    win = createMainWindow({ rendererUrl, preload: path.join(__dirname, 'preload.cjs'), lockSession });
    const ipc: IpcContext = { ipcMain, window: () => win, rendererUrl };
    registerContract(ipc, appContract, appHandlers({ git: s.git, editors: s.editors }));
    registerContract(ipc, gitContract, gitHandlers({ git: s.git, gitState: s.gitState, pickFolder: title => pickFolder(win!, title),
      cloneRepository: (url, destination) => s.cloneLock.run(() => s.git.cloneRepository(url, destination)) }));
    registerContract(ipc, repoMapContract, repoMapHandlers(s.git.repoMap));
    registerContract(ipc, terminalsContract, terminalsHandlers({ terminals: s.terminals, git: s.git, openLink: (id, uri) => s.linkOpener.open(id, uri) }));
    registerContract(ipc, activityContract, activityHandlers({ activity: s.activity, setVisible: ids => s.visibility.setVisible(ids),
      acknowledge: (id, terminalId, revision) => s.visibility.acknowledge(id, terminalId, revision) }));
    registerContract(ipc, stinggraphContract, stinggraphHandlers({ settings: s.stinggraphSettings, host: s.codegraph }));
    registerContract(ipc, viewsContract, viewsHandlers({ views: s.views, viewState: s.viewState, git: s.git, saveViewAs, openExternal: url => electronShell.openExternal(url) }));
    registerContract(ipc, runtimeContract, runtimeHandlers({ containers: s.containers, ports: s.ports, liveViews: s.liveViews,
      inspectCdp: port => inspectCdp(port, { clipboard: electronClipboard, openApp, platform: process.platform }) }));
    onRendererReset(win, () => { s.visibility.reset(); s.liveViews.stopAll(); }, () => s.liveViews.stopAll());
    guardClose(win, { cloneBusy: () => s.cloneLock.busy, runningTerminals: () => s.terminals.list().some(t => !t.exited) });
    void win.loadURL(rendererUrl);
  });
  registerQuit(s, dataDir);
}
```
(`appContract` handler order matches the contract; `pickFolder(win!, …)` runs only after the window exists, because IPC is registered after `createMainWindow`.)

- [ ] **Step 5: `electron/main.ts`** — replace the whole file with:

```ts
import { start } from './app';
start();
```

- [ ] **Step 6: Acceptance greps**

```bash
grep -c "" electron/main.ts                                                                # 2
grep -rn "showMessageBox\|showOpenDialog" electron | grep -v "electron/adapters/driven/electron-shell/dialogs.ts"   # no output
grep -n "^\s*let \|dialog\.\|ipcMain\.handle\|z\.\(tuple\|object\|string\)" electron/app/index.ts electron/app/compose.ts   # only `let win`
```

### Task 8: Verify and commit

- [ ] **Step 1**

```bash
npm run check 2>&1 | tail -n 12
npm run test:e2e
node tests/app/launch.mjs
```
Expected: `# fail 0`; all e2e suites PASS (the `terminal-links` suite covers the moved sender/navigation checks; `desktop` the window); launch smoke PASS. Review `window.ts` against the old `main.ts` lines 99-122 as a verbatim move (security-relevant) and string-compare every dialog text.

- [ ] **Step 2: Commit**

```bash
git add -A electron tests
git commit -m "refactor(app): composition root in electron/app; thin main; clear webview storage on removal"
```

## Self-review

- Spec 05 table rows: 33-38 → `index.ts start()`; 39-40 → `focusExisting`; 41 `quitting` → `guardClose`; 42/134-138 → `CloneLock`; 43/208-228 → `TerminalLinkOpener` + `dialogs.confirmTerminalLink`; 44-66 → `compose.ts`; 49/195-203 → `ActivityVisibility` + reset on reload; 51-54/141-147 → `registerRemovalListeners`; 68-74 → `ipc.ts` (plan 03); 75-82 → `sessions.lockSession` (+ `clearWorkspaceSession`, audit 20); 84-98 → `startServices`; 99-122 → `createMainWindow`; 124-132 → `pickFolder`; 233-242 → `onRendererReset`; 243-258 → `guardClose`; 261-267 → `registerQuit`.
- Tests: `clone-lock`, `link-opener`, `activity-visibility`, lifecycle order + view-state rejection + failing removal runs no afterRemove + audit 20; `editors.core` for the app feature.
