# 05c · Terminals feature extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** `electron/core/terminals/` (terminal registry, link resolution) is pure behind `PtySpawner`, `MirrorFactory`,
`LinkTargets`, `LinkActions`, `TerminalPublisher`; audit 9 (PTY flow control, mirror write guard), audit 15
(`Terminals` lifecycle unit tests) and unique terminal titles land here.

**Architecture:** core `Terminals` receives a spawner and a mirror factory; `node-pty` and `@xterm/headless` stay in
`electron/adapters/driven/pty/`. Link resolution keeps its validation in core and asks `LinkTargets` (driven/fs) for URL
resolution, real paths and stat. `electron/app/wiring/terminals.ts` keeps `new Terminals(send, activity?, activityShell?)`,
`resolveTerminalLink(input, workspace)`, `openTerminalLink(input, workspace, actions)`.

**Tech Stack:** TypeScript, node-pty, @xterm/headless, node:test.

**Spec:** [04 § Commit 5](../specs/2026-11-23-04-hexagonal-modules-design.md#commit-5--per-feature-extraction) (terminals row),
[07 § 9, § 15, Small fixes "Terminal titles"](../specs/2026-11-23-07-audit-fixes-design.md).

**Depends on:** plan 05b committed. **Commit:** one, `refactor(terminals): pure terminals core; PTY flow control; lifecycle tests; unique titles`.

---

## Files

Create: `electron/core/terminals/ports.ts`, `electron/adapters/driven/pty/node-pty.ts`, `electron/adapters/driven/fs/link-targets.ts`,
`electron/adapters/driven/electron-shell/shell.ts`, `electron/adapters/driving/ipc/terminals.ts`, `electron/app/wiring/terminals.ts`,
`tests/fakes/terminals.ts`, `tests/terminals/terminals.test.ts`, `tests/terminals/terminal-links.core.test.ts`.

Modify: `electron/core/terminals/{terminals,terminal-links,index}.ts`, `electron/adapters/driven/pty/terminal-mirror.ts`,
`electron/main.ts`, `tests/terminals/terminal-links.test.ts` (import path), `tests/runtime/*.test.ts` if they import `Terminals` (paths).

---

### Task 1: Ports and fakes

- [ ] **Step 1: `electron/core/terminals/ports.ts`**

```ts
import type { TerminalEvent } from '../../../shared/contracts/terminals';

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Flow control: stop / restart reading the PTY. */
  pause(): void;
  resume(): void;
}
export interface PtySpawner {
  /** The user's login shell. */
  shell(): string;
  /** The environment to start from (core removes Electron/Stingray control variables). */
  env(): Record<string, string | undefined>;
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): PtyProcess;
}
export interface TerminalMirrorPort {
  /** `done` runs once xterm has parsed the chunk (or the write failed). */
  write(data: string, sequence: number, done?: () => void): void;
  resize(cols: number, rows: number): void;
  snapshot(): Promise<{ data: string; sequence: number }>;
  dispose(): void;
}
export type MirrorFactory = (cols: number, rows: number) => TerminalMirrorPort;
export type TerminalPublisher = (event: TerminalEvent) => void;
export interface LinkTargets {
  /** `new URL(input, <workspace folder as a file: URL with a trailing slash>)`; throws on invalid input. */
  resolveUrl(input: string, workspace: string): URL;
  /** Real path of a file: URL's target and whether it is inside the real workspace folder; rejects when unavailable. */
  realTarget(url: URL, workspace: string): Promise<{ target: string; inside: boolean }>;
  /** stat (following the real path); rejects when unavailable. */
  stat(target: string): Promise<{ isFile: boolean; isDirectory: boolean; mode: number }>;
}
export interface LinkActions {
  confirm(link: { kind: 'web' | 'file' | 'reveal'; target: string }): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  openPath(file: string): Promise<string>;
  showItemInFolder(file: string): void;
}
```

- [ ] **Step 2: `tests/fakes/terminals.ts`**

```ts
import type { LinkTargets, MirrorFactory, PtyProcess, PtySpawner, TerminalMirrorPort } from '../../electron/core/terminals';

export class FakePty implements PtyProcess {
  written: string[] = []; killed = false; pauses = 0; resumes = 0;
  private data = new Set<(d: string) => void>(); private exit = new Set<(e: { exitCode: number }) => void>();
  constructor(readonly pid: number, readonly env: Record<string, string>) {}
  onData(l: (d: string) => void) { this.data.add(l); }
  onExit(l: (e: { exitCode: number }) => void) { this.exit.add(l); }
  write(d: string) { this.written.push(d); }
  resize() {}
  kill() { this.killed = true; }
  pause() { this.pauses++; }
  resume() { this.resumes++; }
  emit(d: string) { for (const l of this.data) l(d); }
  exitWith(exitCode: number) { for (const l of this.exit) l({ exitCode }); }
}
export function fakeSpawner(env: Record<string, string> = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', STINGRAY_DATA_DIR: '/x', NODE_OPTIONS: '--x' }) {
  const processes: FakePty[] = [];
  const spawner: PtySpawner = { shell: () => '/bin/zsh', env: () => env, spawn: (_file, _args, o) => { const p = new FakePty(1000 + processes.length, o.env); processes.push(p); return p; } };
  return { spawner, processes };
}
export class FakeMirror implements TerminalMirrorPort {
  data = ''; sequence = 0; disposed = false; private pending: (() => void)[] = [];
  write(d: string, sequence: number, done?: () => void) { this.data += d; this.sequence = sequence; if (done) this.pending.push(done); }
  resize() {}
  async snapshot() { return { data: this.data, sequence: this.sequence }; }
  dispose() { this.disposed = true; }
  drain() { for (const done of this.pending.splice(0)) done(); }
}
export function fakeMirrors() {
  const mirrors: FakeMirror[] = [];
  const factory: MirrorFactory = () => { const m = new FakeMirror(); mirrors.push(m); return m; };
  return { factory, mirrors };
}
/** A workspace folder map: real targets by absolute path. */
export function fakeLinkTargets(files: Record<string, { isFile: boolean; isDirectory: boolean; mode: number }>, root = '/ws'): LinkTargets {
  return {
    resolveUrl: (input, workspace) => new URL(input, `file://${workspace}/`),
    realTarget: async url => { const target = decodeURIComponent(url.pathname); if (!(target in files) && target !== root) throw new Error('ENOENT'); return { target, inside: target.startsWith(root + '/') }; },
    stat: async target => files[target] ?? (() => { throw new Error('ENOENT'); })(),
  };
}
```

### Task 2: Pure `Terminals` with flow control and unique titles (TDD; audit 9, 15)

- [ ] **Step 1: `tests/terminals/terminals.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terminals } from '../../electron/core/terminals';
import { TerminalMirror } from '../../electron/adapters/driven/pty/terminal-mirror';
import type { TerminalEvent } from '../../shared/contracts/terminals';
import { fakeMirrors, fakeSpawner } from '../fakes/terminals';

const ws = '00000000-0000-4000-8000-0000000000c1';
function setup(mirrorFactory?: ConstructorParameters<typeof Terminals>[0]['mirrors']) {
  const events: TerminalEvent[] = [];
  const { spawner, processes } = fakeSpawner();
  const m = fakeMirrors();
  const terminals = new Terminals({ send: e => events.push(e), pty: spawner, mirrors: mirrorFactory ?? m.factory });
  return { terminals, events, processes, mirrors: m.mirrors };
}

test('child environment drops Electron/Stingray control variables', () => {
  const s = setup();
  s.terminals.create(ws, '/ws');
  assert.equal(s.processes[0].env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(s.processes[0].env.STINGRAY_DATA_DIR, undefined);
  assert.equal(s.processes[0].env.NODE_OPTIONS, undefined);
  assert.equal(s.processes[0].env.TERM, 'xterm-256color');
});

test('close before exit kills, removes, and ignores a later exit or data', () => {
  const s = setup();
  const t = s.terminals.create(ws, '/ws');
  s.terminals.close(t.id);
  assert.equal(s.processes[0].killed, true);
  assert.deepEqual(s.terminals.list(), []);
  const before = s.events.length;
  assert.doesNotThrow(() => { s.processes[0].exitWith(0); s.processes[0].emit('late'); });
  assert.deepEqual(s.terminals.list(), []);
  assert.equal(s.events.slice(before).filter(e => e.data !== undefined).length, 0, 'no data events after close');
});

test('exit then snapshot keeps the written data and the exit code; write after exit throws', async () => {
  const s = setup();
  const t = s.terminals.create(ws, '/ws');
  s.processes[0].emit('hello'); s.processes[0].exitWith(3);
  const snap = await s.terminals.snapshot(t.id);
  assert.equal(snap.data, 'hello'); assert.equal(snap.exitCode, 3);
  assert.throws(() => s.terminals.write(t.id, 'x'), /This terminal has exited\. Open a new one\./);
});

test('the 25th terminal is refused', () => {
  const s = setup();
  for (let i = 0; i < 24; i++) s.terminals.create(ws, '/ws');
  assert.throws(() => s.terminals.create(ws, '/ws'), /Close a terminal before opening another \(limit 24\)\./);
});

test('titles stay unique after closing one', () => {
  const s = setup();
  const a = s.terminals.create(ws, '/ws'); s.terminals.create(ws, '/ws');
  s.terminals.close(a.id);
  const c = s.terminals.create(ws, '/ws');
  assert.deepEqual(s.terminals.list().map(t => t.title).sort(), ['Terminal 2', 'Terminal 3']);
  assert.equal(c.title, 'Terminal 3');
});

test('flow control: a fast producer pauses the PTY above 1 MiB queued and resumes below 256 KiB', () => {
  const s = setup();
  s.terminals.create(ws, '/ws');
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 32; i++) s.processes[0].emit(chunk); // 2 MiB, mirror not drained
  assert.equal(s.processes[0].pauses, 1);
  assert.equal(s.events.filter(e => e.data).length, 32, 'every chunk still reaches the renderer');
  s.mirrors[0].drain();
  assert.equal(s.processes[0].resumes, 1);
});

test('a mirror whose write throws does not stop later data events', () => {
  const s = setup((cols, rows) => {
    const mirror = new TerminalMirror(cols, rows);
    (mirror as unknown as { terminal: { write: () => never } }).terminal.write = () => { throw new Error('parser error'); };
    return mirror;
  });
  s.terminals.create(ws, '/ws');
  const error = console.error; console.error = () => {};
  try { s.processes[0].emit('a'); s.processes[0].emit('b'); } finally { console.error = error; }
  assert.deepEqual(s.events.filter(e => e.data).map(e => e.data), ['a', 'b']);
});
```

- [ ] **Step 2: Run** — FAIL (constructor shape).

- [ ] **Step 3: Rewrite `electron/core/terminals/terminals.ts`**

```ts
import type { TerminalInfo, TerminalSnapshot } from '../../../shared/contracts/terminals';
import type { ActivityService, ShellIntegration } from '../activity';
import type { MirrorFactory, PtyProcess, PtySpawner, TerminalMirrorPort, TerminalPublisher } from './ports';

/** PATH with `dir` first and no other copy of it; unchanged when `dir` is empty. */
export const prependPath = (value: string | undefined, dir: string) =>
  dir ? [dir, ...(value ?? '').split(':').filter(p => p && p !== dir)].join(':') : value ?? '';

// Flow control (audit 9): bytes queued in the headless mirror per terminal.
const HIGH = 1024 * 1024, LOW = 256 * 1024;
type Entry = TerminalInfo & { process: PtyProcess; mirror: TerminalMirrorPort; exitCode?: number; queued: number; paused: boolean };
export interface TerminalsDeps { send: TerminalPublisher; pty: PtySpawner; mirrors: MirrorFactory; activity?: ActivityService; shell?: ShellIntegration }

export class Terminals {
  private entries = new Map<string, Entry>();
  private created = 0; // titles are never reused
  viewsBin = ''; // directory of the `stingray-views` launcher, set by main once installed
  constructor(private deps: TerminalsDeps) {}
  list(): TerminalInfo[] {
    return [...this.entries.values()].map(({ process: _, mirror: __, exitCode: ___, queued: ____, paused: _____, ...info }) => info);
  }
  portRoots() {
    return [...this.entries.values()].filter(t => !t.exited).map(t => ({ id: t.id, workspaceId: t.workspaceId, title: t.title, pid: t.process.pid }));
  }
  hasWorkspace(id: string) { return this.countWorkspace(id) > 0; }
  countWorkspace(id: string) { return [...this.entries.values()].filter(t => t.workspaceId === id).length; }
  closeWorkspace(id: string) { for (const [key, t] of this.entries) if (t.workspaceId === id) this.close(key); }
  create(workspaceId: string, cwd: string): TerminalInfo {
    if (this.entries.size >= 24) throw new Error('Close a terminal before opening another (limit 24).');
    const shell = this.deps.pty.shell();
    // Do not pass Electron's control environment into child shells.
    const env = Object.fromEntries(Object.entries(this.deps.pty.env()).filter(([key, value]) =>
      value !== undefined && !key.startsWith('ELECTRON_') && !key.startsWith('STINGRAY_') && key !== 'NODE_OPTIONS')) as Record<string, string>;
    if (this.viewsBin) env.PATH = prependPath(env.PATH, this.viewsBin);
    const id = globalThis.crypto.randomUUID();
    const shellEnv = this.deps.shell?.environment(shell, env) ?? {};
    const attached = Boolean(shellEnv.ZDOTDIR && this.deps.activity?.endpoint);
    const activityEnv = attached ? this.deps.activity!.bind(id, workspaceId) : {};
    let child: PtyProcess;
    try {
      child = this.deps.pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: { ...env, ...shellEnv, ...activityEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
    } catch (error) { this.deps.activity?.unbind(id, true); throw error; }
    const entry: Entry = { id, workspaceId, title: 'Terminal ' + ++this.created, exited: false, sequence: 0, cols: 100, rows: 30,
      piTracking: attached ? 'available' : 'unavailable', process: child, mirror: this.deps.mirrors(100, 30), queued: 0, paused: false };
    this.entries.set(entry.id, entry);
    child.onData(data => {
      if (this.entries.get(entry.id) !== entry) return; // closed
      entry.queued += data.length;
      entry.mirror.write(data, ++entry.sequence, () => {
        entry.queued -= data.length;
        if (entry.paused && entry.queued < LOW) { entry.paused = false; child.resume(); }
      });
      if (!entry.paused && entry.queued > HIGH) { entry.paused = true; child.pause(); }
      this.deps.send({ id: entry.id, data, sequence: entry.sequence });
    });
    child.onExit(({ exitCode }) => {
      entry.exited = true; entry.exitCode = exitCode; this.deps.activity?.unbind(entry.id); this.deps.send({ id: entry.id, exitCode });
    });
    const { process: _, mirror: __, queued: ___, paused: ____, ...info } = entry; return info;
  }
  private get(id: string) { const t = this.entries.get(id); if (!t) throw new Error('Terminal not found.'); return t; }
  write(id: string, data: string) { const t = this.get(id); if (t.exited) throw new Error('This terminal has exited. Open a new one.'); t.process.write(data); }
  resize(id: string, cols: number, rows: number) {
    const t = this.get(id);
    if (t.exited || (t.cols === cols && t.rows === rows)) return;
    t.process.resize(cols, rows); t.mirror.resize(cols, rows); t.cols = cols; t.rows = rows;
  }
  /** Restorable state for a newly mounted pane; output after `sequence` arrives as terminal events. */
  async snapshot(id: string): Promise<TerminalSnapshot> {
    const t = this.get(id);
    const { data, sequence } = await t.mirror.snapshot();
    return { id, data, sequence, cols: t.cols ?? 100, rows: t.rows ?? 30, exitCode: t.exitCode };
  }
  close(id: string) { const t = this.get(id); this.deps.activity?.unbind(id, true); if (!t.exited) t.process.kill(); t.mirror.dispose(); this.entries.delete(id); }
  closeAll() { for (const id of this.entries.keys()) this.close(id); }
}
```
(The `if (this.entries.get(entry.id) !== entry) return;` guard in `onData` is the "close before exit" behaviour the new test pins: after `close()` late output of the killed PTY is not sent. The exit handler is unchanged.)

- [ ] **Step 4: `electron/adapters/driven/pty/terminal-mirror.ts`** — `TerminalMirror implements TerminalMirrorPort` (import the type from `../../../core/terminals`); add `private failed = false;` and replace `write` with:

```ts
  write(data: string, sequence: number, done?: () => void) {
    if (this.disposed) { done?.(); return; }
    try { this.terminal.write(data, () => { this.parsed = sequence; done?.(); }); } catch (error) {
      // A parser error must not stop the stream; the chunk still reaches the renderer (logged once per terminal).
      if (!this.failed) { this.failed = true; console.error('Terminal mirror write failed:', error); }
      done?.();
    }
  }
```

- [ ] **Step 5: `electron/adapters/driven/pty/node-pty.ts`**

```ts
import * as pty from 'node-pty';
import os from 'node:os';
import type { MirrorFactory, PtySpawner } from '../../../core/terminals';
import { TerminalMirror } from './terminal-mirror';

export const nodePtySpawner: PtySpawner = {
  shell: () => os.userInfo().shell || '/bin/zsh',
  env: () => process.env,
  spawn: (file, args, options) => pty.spawn(file, args, options),
};
export const headlessMirrors: MirrorFactory = (cols, rows) => new TerminalMirror(cols, rows);
```

- [ ] **Step 6: Run** — `npx tsx --test tests/terminals/terminals.test.ts tests/terminals/terminal-mirror.test.ts` → PASS.

### Task 3: Pure link resolution (TDD)

- [ ] **Step 1: `tests/terminals/terminal-links.core.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTerminalLink, resolveTerminalLink } from '../../electron/core/terminals';
import { fakeLinkTargets } from '../fakes/terminals';

const targets = fakeLinkTargets({
  '/ws/notes.md': { isFile: true, isDirectory: false, mode: 0o644 },
  '/ws/run.sh': { isFile: true, isDirectory: false, mode: 0o755 },
  '/ws/src': { isFile: false, isDirectory: true, mode: 0o755 },
  '/outside.md': { isFile: true, isDirectory: false, mode: 0o644 },
});

test('web, readable file, executable and folder targets; outside and credential links are refused', async () => {
  assert.deepEqual(await resolveTerminalLink('https://example.com/a', '/ws', targets), { kind: 'web', target: 'https://example.com/a' });
  assert.deepEqual(await resolveTerminalLink('notes.md', '/ws', targets), { kind: 'file', target: '/ws/notes.md' });
  assert.deepEqual(await resolveTerminalLink('run.sh', '/ws', targets), { kind: 'reveal', target: '/ws/run.sh' });
  assert.deepEqual(await resolveTerminalLink('src', '/ws', targets), { kind: 'reveal', target: '/ws/src' });
  await assert.rejects(resolveTerminalLink('/outside.md', '/ws', targets), /inside this terminal’s workspace/);
  await assert.rejects(resolveTerminalLink('https://u:p@example.com', '/ws', targets), /without credentials/);
  await assert.rejects(resolveTerminalLink('missing.md', '/ws', targets), /unavailable/);
});

test('a declined confirmation opens nothing', async () => {
  const opened: string[] = [];
  await openTerminalLink('notes.md', '/ws', { confirm: async () => false, openExternal: async u => { opened.push(u); }, openPath: async p => { opened.push(p); return ''; }, showItemInFolder: p => { opened.push(p); } }, targets);
  assert.deepEqual(opened, []);
});
```

- [ ] **Step 2: Run** — FAIL (signature).

- [ ] **Step 3: Rewrite `electron/core/terminals/terminal-links.ts`** — delete the three node imports; add `import { extname } from '../shared/posix-path'; import type { LinkActions, LinkTargets } from './ports';`. `TerminalLinkActions` becomes `export type TerminalLinkActions = LinkActions;`. Then:

```ts
export async function resolveTerminalLink(input: string, workspace: string, targets: LinkTargets): Promise<TerminalLink> {
  if (!input || input.length > 8192 || input !== input.trim() || unsafeText.test(input) || input.startsWith('//')) throw invalid();
  let url: URL;
  try {
    if (unsafeText.test(decodeURIComponent(input))) throw invalid();
    url = targets.resolveUrl(input, workspace);
  } catch { throw invalid(); }
  if (url.username || url.password) throw invalid();
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!/^https?:\/\//i.test(input) || !url.hostname) throw invalid();
    return { kind: 'web', target: url.href };
  }
  if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) throw invalid();
  let real: { target: string; inside: boolean };
  try { real = await targets.realTarget(url, workspace); } catch { throw new Error('The linked local file is unavailable.'); }
  if (!real.inside) throw invalid();
  let info;
  try { info = await targets.stat(real.target); } catch { throw new Error('The linked local file is unavailable.'); }
  if (!info.isFile && !info.isDirectory) throw new Error('Only regular files and folders can be opened.');
  const readable = info.isFile && !(info.mode & 0o111) && readableTypes.has(extname(real.target).toLowerCase());
  return { kind: readable ? 'file' : 'reveal', target: real.target };
}

export async function openTerminalLink(input: string, workspace: string, actions: LinkActions, targets: LinkTargets): Promise<void> {
  // body unchanged; both resolveTerminalLink calls pass `targets`
}
```

- [ ] **Step 4: `electron/adapters/driven/fs/link-targets.ts`** (the I/O moved out of today's lines 15-31)

```ts
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LinkTargets } from '../../../core/terminals';

export const nodeLinkTargets: LinkTargets = {
  resolveUrl: (input, workspace) => new URL(input, pathToFileURL(path.resolve(workspace) + path.sep)),
  async realTarget(url, workspace) {
    const root = await realpath(workspace), target = await realpath(fileURLToPath(url));
    const relative = path.relative(root, target);
    return { target, inside: !(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) };
  },
  async stat(target) { const info = await stat(target); return { isFile: info.isFile(), isDirectory: info.isDirectory(), mode: info.mode }; },
};
```
Note: today `relative === ''` (the workspace folder itself) is accepted as inside; the expression above keeps that.

- [ ] **Step 5: Run** — `npx tsx --test tests/terminals/terminal-links.core.test.ts` → PASS.

### Task 4: Wiring, Electron shell adapter, IPC handlers, main

- [ ] **Step 1: `electron/adapters/driven/electron-shell/shell.ts`**

```ts
import { shell } from 'electron';

export const electronShell = {
  openExternal: (url: string) => shell.openExternal(url),
  openPath: (file: string) => shell.openPath(file),
  showItemInFolder: (file: string) => shell.showItemInFolder(file),
};
```

- [ ] **Step 2: `electron/app/wiring/terminals.ts`**

```ts
import type { TerminalEvent } from '../../../shared/contracts/terminals';
import { nodeLinkTargets } from '../../adapters/driven/fs/link-targets';
import { headlessMirrors, nodePtySpawner } from '../../adapters/driven/pty/node-pty';
import type { ActivityService, ShellIntegration } from '../../core/activity';
import { Terminals as CoreTerminals, openTerminalLink as coreOpen, resolveTerminalLink as coreResolve, type LinkActions } from '../../core/terminals';

export { prependPath } from '../../core/terminals';
export type { TerminalLinkActions } from '../../core/terminals';
export class Terminals extends CoreTerminals {
  constructor(send: (event: TerminalEvent) => void, activity?: ActivityService, shell?: ShellIntegration) {
    super({ send, pty: nodePtySpawner, mirrors: headlessMirrors, activity, shell });
  }
}
export const resolveTerminalLink = (input: string, workspace: string) => coreResolve(input, workspace, nodeLinkTargets);
export const openTerminalLink = (input: string, workspace: string, actions: LinkActions) => coreOpen(input, workspace, actions, nodeLinkTargets);
```

- [ ] **Step 3: `electron/adapters/driving/ipc/terminals.ts`**

```ts
import type { Handlers } from '../../../../shared/contracts/define';
import type { terminalsContract } from '../../../../shared/contracts/terminals';
import type { GitService } from '../../../core/git';
import type { Terminals } from '../../../core/terminals';

/** openLink stays a main-process callback (dialog + one-at-a-time lock) until plan 06 moves it into core TerminalLinkOpener. */
export function terminalsHandlers(d: { terminals: Terminals; git: Pick<GitService, 'useWorkspace'>; openLink(id: string, uri: string): Promise<void> }): Handlers<typeof terminalsContract> {
  return {
    terminals: () => d.terminals.list(),
    terminalSnapshot: id => d.terminals.snapshot(id),
    createTerminal: id => d.git.useWorkspace(id, w => d.terminals.create(id, w.path)),
    writeTerminal: (id, data) => d.terminals.write(id, data),
    openTerminalLink: (id, uri) => d.openLink(id, uri),
    resizeTerminal: (id, cols, rows) => d.terminals.resize(id, cols, rows),
    closeTerminal: id => d.terminals.close(id),
  };
}
```

- [ ] **Step 4: `electron/main.ts`** — import `Terminals, openTerminalLink` from `./app/wiring/terminals`, `electronShell` from `./adapters/driven/electron-shell/shell`, `terminalsHandlers`. Replace the terminals `registerContract` with `registerContract(ipc, terminalsContract, terminalsHandlers({ terminals, git, openLink: async (id, uri) => { /* today's open-terminal-link body verbatim, with openExternal/openPath/showItemInFolder taken from electronShell */ } }))`.

### Task 5: Existing tests, verify, commit

- [ ] **Step 1:** `tests/terminals/terminal-links.test.ts`: `openTerminalLink`, `resolveTerminalLink`, `TerminalLinkActions` from `../../electron/app/wiring/terminals` (import edit). Run `npm run typecheck` and fix any other test importing `Terminals` the same way.

- [ ] **Step 2: Checks**

```bash
grep -rn "from 'node:\|from 'electron'\|from 'node-pty'\|from '@xterm" electron/core/terminals   # expect no output
npm run check 2>&1 | tail -n 12
npm run test:e2e -- terminal-links desktop worktree-removal
```
Expected: no grep output; `# fail 0`; 3 suites PASS.

- [ ] **Step 3: Commit**

```bash
git add -A electron tests docs/plans/2026-11-23-test-edit-ledger.md
git commit -m "refactor(terminals): pure terminals core; PTY flow control; lifecycle tests; unique titles"
```

## Self-review

- Spec coverage (04 terminals row): core `terminals.ts`, `terminal-links.ts`; ports `PtySpawner`, `MirrorFactory`, `LinkTargets`, `LinkActions`, `TerminalPublisher`; adapters `pty/{node-pty,terminal-mirror,terminal-serialize}`, `fs/link-targets`, `electron-shell/shell`; driving `ipc/terminals.ts`; fakes; `terminals.test.ts` (audit 15 cases + flow control + mirror guard + titles), `terminal-links.core.test.ts`.
- `TerminalLinkOpener` (lock + confirm port) is plan 06.
