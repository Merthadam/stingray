# 05h · Runtime feature extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** `electron/core/runtime/` (terminal port discovery, container discovery, live view, Chrome inspect) is pure
behind `PortScanner`, `DockerRunner`, `DockerSocketFiles`, `CdpConnection`, `Clipboard`, `AppOpener`, `LiveViewPublisher`;
CDP calls time out after 10 s ("The live view did not respond.").

**Architecture:** process/docker/CDP/Electron calls move to `electron/adapters/driven/{process,docker,cdp,electron-shell}/`;
`electron/app/wiring/runtime.ts` keeps `new PortService(roots, runner?, platform?)`, `new ContainerService(run?, env?)`,
`new LiveViews(publish)`, `inspectCdp(port)` for main and the existing tests.

**Tech Stack:** TypeScript, zod, node:test.

**Spec:** [04 § Commit 5](../specs/2026-11-23-04-hexagonal-modules-design.md#commit-5--per-feature-extraction) (runtime row),
[07 § Small fixes "CDP call timeout"](../specs/2026-11-23-07-audit-fixes-design.md#small-fixes).

**Depends on:** plan 05g committed. **Commit:** one, `refactor(runtime): pure runtime core behind process, docker and CDP ports; CDP call timeout`.

---

## Files

Create: `electron/core/runtime/ports.ts` (port interfaces; the existing `electron/core/runtime/ports.ts` *service* file is renamed first, see Task 1),
`electron/adapters/driven/process/{ps-lsof,open-app}.ts`, `electron/adapters/driven/docker/docker-runner.ts`,
`electron/adapters/driven/cdp/cdp-connection.ts`, `electron/adapters/driven/electron-shell/clipboard.ts`,
`electron/adapters/driving/ipc/runtime.ts`, `electron/app/wiring/runtime.ts`, `tests/fakes/runtime.ts`,
`tests/runtime/{ports,containers,live-view}.core.test.ts`.

Modify: `electron/core/runtime/{containers,live-view,chrome-inspect,index}.ts`, `electron/main.ts`,
`tests/runtime/{ports,live-view,workspace-status}.test.ts` (import paths).

---

### Task 1: Free the `ports.ts` name, declare the ports, fakes

- [ ] **Step 1:** `git mv electron/core/runtime/ports.ts electron/core/runtime/port-service.ts` (the feature's port interfaces live in `ports.ts` like every other feature; this is a rename inside the feature). Update its importers (`index.ts`, tests via wiring in Task 4).

- [ ] **Step 2: `electron/core/runtime/ports.ts`**

```ts
import type { LiveViewEvent } from '../../../shared/contracts/runtime';

/** Runs ps/lsof with bounded output (lsof exit 1 with no output is ''); rejects with the scan error. */
export type PortScanner = (file: string, args: string[]) => Promise<string>;
export type DockerRunner = (args: string[], options?: { timeout?: number; stderr?: boolean }) => Promise<string>;
export interface DockerSocketFiles {
  /** Existing, non-directory Colima docker.sock paths under `home` (~/.colima/docker.sock and each profile's). */
  colimaSockets(home: string): Promise<string[]>;
  /** realpath, or the input when it cannot be resolved. */
  realpath(path: string): Promise<string>;
}
export interface CdpSocket { readonly open: boolean; send(text: string): void; close(): void; onMessage(listener: (data: string) => void): void; onClose(listener: () => void): void }
export interface CdpConnection {
  /** GET http://127.0.0.1:<port>/json/list (3 s); rejects on any failure. */
  list(port: number): Promise<unknown>;
  /** WebSocket to the page target; rejects with "Timed out connecting to the test instance." / "Could not connect to the test instance.". */
  connect(port: number, targetId: string): Promise<CdpSocket>;
}
export interface Clipboard { writeText(text: string): void }
/** Opens a URL in a named macOS app (`open -a`); false when that failed. */
export type AppOpener = (app: string, url: string) => Promise<boolean>;
export type LiveViewPublisher = (event: LiveViewEvent) => void;
```

- [ ] **Step 3: `tests/fakes/runtime.ts`**

```ts
import type { CdpConnection, CdpSocket } from '../../electron/core/runtime';
import { APP_PAGE } from '../../electron/core/runtime';

/** A CDP endpoint whose socket records commands and never replies. */
export function silentCdp() {
  const sent: string[] = [];
  const socket: CdpSocket = { open: true, send: t => { sent.push(t); }, close: () => {}, onMessage: () => {}, onClose: () => {} };
  const cdp: CdpConnection = { list: async () => [{ id: 'T', type: 'page', url: APP_PAGE, title: 'Stingray' }], connect: async () => socket };
  return { cdp, sent };
}
```

### Task 2: Pure services (TDD)

- [ ] **Step 1: `tests/runtime/live-view.core.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveViews } from '../../electron/core/runtime';
import { silentCdp } from '../fakes/runtime';

test('a CDP call without a reply rejects after the timeout and frees its pending entry', async () => {
  const { cdp, sent } = silentCdp();
  const views = new LiveViews(() => {}, { cdp, callTimeoutMs: 50 });
  const started = Date.now();
  await assert.rejects(views.start({ port: 9222 }), /^Error: The live view did not respond\.$/);
  assert.ok(Date.now() - started < 2000);
  assert.ok(sent.some(t => t.includes('Page.startScreencast')));
});
```

- [ ] **Step 2: `tests/runtime/ports.core.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortService } from '../../electron/core/runtime';

test('port discovery runs only on macOS (injected platform) and asks the scanner, never the OS', async () => {
  const root = { id: 't1', workspaceId: 'w1', pid: 100, title: 'Terminal 1' };
  await assert.rejects(new PortService(() => [root], async () => '', 'linux').list(), /macOS/);
  const calls: string[] = [];
  const service = new PortService(() => [root], async file => { calls.push(file); return file.endsWith('ps') ? '  100     1\n' : ''; }, 'darwin');
  assert.deepEqual(await service.list(), []);
  assert.ok(calls.length >= 1);
});
```

- [ ] **Step 3: `tests/runtime/containers.core.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerService } from '../../electron/core/runtime';

test('Colima sockets come from the socket-files port and are deduplicated by real path', async () => {
  const calls: string[][] = [];
  const service = new ContainerService(async args => { calls.push(args); return args[0] === 'context' ? 'unix:///home/u/.colima/default/docker.sock' : ''; },
    { HOME: '/home/u' }, { colimaSockets: async () => ['/home/u/.colima/docker.sock', '/home/u/.colima/default/docker.sock'], realpath: async p => p.replace('/.colima/docker.sock', '/.colima/default/docker.sock') });
  assert.deepEqual(await service.list(), []);
  assert.equal(calls.filter(a => a[0] === '--host').length, 1, 'one endpoint after dedupe');
});
```

- [ ] **Step 4: Run** — FAIL (constructors).

- [ ] **Step 5: Core rewrites** (logic unchanged unless stated)

`port-service.ts`: delete `execFile`/`promisify`/`exec`/`run`/`scanError`'s use in `run` (move `run` with `scanError` to `driven/process/ps-lsof.ts`; keep `scanError` exported from core because `processOwners` throws it); `PortRunner` → `PortScanner` (from `./ports`); constructor `(private roots: () => PortRoot[], private runner: PortScanner, private platform: string)`.

`containers.ts`: delete the node imports and `runDocker` (moved to `driven/docker/docker-runner.ts`, verbatim); `DockerRunner` type now from `./ports`; constructor `(private run: DockerRunner, private env: Record<string, string | undefined>, private files: DockerSocketFiles)`; in `endpoints()` replace the Colima block with
```ts
    const home = this.env.HOME;
    if (home) for (const socket of await this.files.colimaSockets(home)) add('unix://' + socket);
```
and `await realpath(socket).catch(() => socket)` → `await this.files.realpath(socket)`; in `discoverHost` `realpath(p).catch(() => p)` → `this.files.realpath(p)`.

`live-view.ts`: delete `import { randomUUID } from 'node:crypto'`; `Session.socket: CdpSocket`; constructor `constructor(private emit: LiveViewPublisher, options: { cdp: CdpConnection; callTimeoutMs?: number })` storing `cdp` and `callTimeoutMs = options.callTimeoutMs ?? 10_000`; in `connect()`:
```ts
    let list: unknown;
    try { list = await this.cdp.list(port); } catch { throw new Error(`No test instance answers on 127.0.0.1:${port}. Is it running?`); }
    const target = pickTarget(list);
    if (!target) throw new Error(`No Stingray window found on 127.0.0.1:${port}.`);
    const socket = await this.cdp.connect(port, target.id);
    if (generation !== this.generation) { socket.close(); throw new Error('The live view was closed.'); }
    const id = globalThis.crypto.randomUUID(), session: Session = { socket, nextId: 1, pending: new Map(), metadata: null, size, stopped: false, unacked: [] };
```
`socket.addEventListener('message', ({ data }) => { … JSON.parse(String(data)) … })` → `socket.onMessage(data => { … JSON.parse(data) … })`; `socket.addEventListener('close', …)` → `socket.onClose(…)`. `call()` with the timeout:
```ts
  private call(session: Session, method: string, params: Record<string, unknown>) {
    if (!session.socket.open) return Promise.reject(new Error('The live view disconnected.'));
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.pending.delete(id); reject(new Error('The live view did not respond.')); }, this.callTimeoutMs);
      session.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      session.socket.send(JSON.stringify({ id, method, params }));
    });
  }
```

`chrome-inspect.ts`:
```ts
import type { AppOpener, Clipboard } from './ports';

/** shell.openExternal refuses chrome:// URLs, so copy the address and ask macOS to open Chrome's inspect page directly. */
export async function inspectCdp(port: number, deps: { clipboard: Clipboard; openApp: AppOpener; platform: string }) {
  const address = `127.0.0.1:${port}`;
  deps.clipboard.writeText(address);
  const opened = deps.platform === 'darwin' && await deps.openApp('Google Chrome', 'chrome://inspect/#devices');
  return { address, opened };
}
```
`index.ts` exports `PortService, processOwners, parseListeners, type PortRoot, ContainerService, inspectFormat, parseContainers, LiveViews, APP_PAGE, MAX_LIVE_VIEWS, pickTarget, toCdpInput, inspectCdp` and the port types.

- [ ] **Step 6: Run** — `npx tsx --test tests/runtime/*.core.test.ts` → PASS.

### Task 3: Driven adapters

- [ ] **Step 1: `electron/adapters/driven/process/ps-lsof.ts`** — today's `run()` from `port-service.ts:9-17` verbatim, exported as `export const psLsof: PortScanner = run;` (import `scanError` from `../../../core/runtime`).
- [ ] **Step 2: `electron/adapters/driven/process/open-app.ts`**
```ts
import { execFile } from 'node:child_process';
import type { AppOpener } from '../../../core/runtime';
export const openApp: AppOpener = (app, url) => new Promise(resolve => execFile('/usr/bin/open', ['-a', app, url], { timeout: 5000 }, error => resolve(!error)));
```
- [ ] **Step 3: `electron/adapters/driven/docker/docker-runner.ts`** — `runDocker` moved verbatim, plus
```ts
export const nodeDockerSocketFiles: DockerSocketFiles = {
  async colimaSockets(home) {
    const colima = path.join(home, '.colima');
    const profiles = await readdir(colima).catch(() => [] as string[]);
    const sockets = [path.join(colima, 'docker.sock'), ...profiles.filter(p => !p.startsWith('_')).map(p => path.join(colima, p, 'docker.sock'))];
    const found: string[] = [];
    for (const socket of sockets) if (await stat(socket).then(s => !s.isDirectory(), () => false)) found.push(socket);
    return found;
  },
  realpath: p => realpath(p).catch(() => p),
};
```
- [ ] **Step 4: `electron/adapters/driven/cdp/cdp-connection.ts`** (uses the globals at call time, so the existing tests' fake `fetch`/`WebSocket` still apply)
```ts
import type { CdpConnection, CdpSocket } from '../../../core/runtime';

const wrap = (socket: WebSocket): CdpSocket => ({
  get open() { return socket.readyState === WebSocket.OPEN; },
  send: text => socket.send(text), close: () => socket.close(),
  onMessage: listener => socket.addEventListener('message', ({ data }) => listener(String(data))),
  onClose: listener => socket.addEventListener('close', () => listener()),
});
export const webCdp: CdpConnection = {
  list: async port => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json(),
  connect: (port, targetId) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    const timer = setTimeout(() => { socket.close(); reject(new Error('Timed out connecting to the test instance.')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(wrap(socket)); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to the test instance.')); }, { once: true });
  }),
};
```
- [ ] **Step 5: `electron/adapters/driven/electron-shell/clipboard.ts`**
```ts
import { clipboard } from 'electron';
import type { Clipboard } from '../../../core/runtime';
export const electronClipboard: Clipboard = { writeText: text => clipboard.writeText(text) };
```

### Task 4: Wiring, IPC, main, tests

- [ ] **Step 1: `electron/app/wiring/runtime.ts`**

```ts
import type { LiveViewEvent } from '../../../shared/contracts/runtime';
import { webCdp } from '../../adapters/driven/cdp/cdp-connection';
import { nodeDockerSocketFiles, runDocker } from '../../adapters/driven/docker/docker-runner';
import { psLsof } from '../../adapters/driven/process/ps-lsof';
import * as core from '../../core/runtime';

export class PortService extends core.PortService {
  constructor(roots: () => core.PortRoot[], runner: core.PortScanner = psLsof, platform: string = process.platform) { super(roots, runner, platform); }
}
export class ContainerService extends core.ContainerService {
  constructor(run: core.DockerRunner = runDocker, env: Record<string, string | undefined> = process.env) { super(run, env, nodeDockerSocketFiles); }
}
export class LiveViews extends core.LiveViews { constructor(publish: (event: LiveViewEvent) => void) { super(publish, { cdp: webCdp }); } }
export { processOwners, parseListeners, inspectFormat, parseContainers, APP_PAGE, MAX_LIVE_VIEWS, pickTarget, toCdpInput, type PortRoot } from '../../core/runtime';
```
`inspectCdp` needs the Electron clipboard, so it is bound in main (`electron/app` from plan 06), not here (tests do not import it).

- [ ] **Step 2: `electron/adapters/driving/ipc/runtime.ts`**

```ts
import type { Handlers } from '../../../../shared/contracts/define';
import type { runtimeContract } from '../../../../shared/contracts/runtime';
import type { ContainerService, LiveViews, PortService } from '../../../core/runtime';

export function runtimeHandlers(d: { containers: ContainerService; ports: PortService; liveViews: LiveViews; inspectCdp(port: number): Promise<{ address: string; opened: boolean }> }): Handlers<typeof runtimeContract> {
  return {
    containers: () => d.containers.list(),
    stopContainer: id => d.containers.stop(id),
    containerLogs: id => d.containers.logs(id),
    inspectCdp: port => d.inspectCdp(port),
    ports: () => d.ports.list(),
    liveViewStart: options => d.liveViews.start(options),
    liveViewInput: (id, input) => d.liveViews.input(id, input),
    liveViewResize: (id, maxWidth, maxHeight) => d.liveViews.resize(id, maxWidth, maxHeight),
    liveViewStop: id => d.liveViews.stop(id),
    liveViewAck: id => d.liveViews.ack(id),
  };
}
```
`electron/main.ts`: `PortService`, `ContainerService`, `LiveViews` from `./app/wiring/runtime`; `registerContract(ipc, runtimeContract, runtimeHandlers({ containers, ports, liveViews, inspectCdp: port => inspectCdp(port, { clipboard: electronClipboard, openApp, platform: process.platform }) }))`.

- [ ] **Step 3: Existing tests (import paths)** — `tests/runtime/ports.test.ts` (`PortService, processOwners, parseListeners, type PortRoot`), `tests/runtime/live-view.test.ts` (`APP_PAGE, LiveViews, MAX_LIVE_VIEWS, pickTarget, toCdpInput`), `tests/runtime/workspace-status.test.ts` (`ContainerService, inspectFormat, parseContainers`) import from `../../electron/app/wiring/runtime`.

### Task 5: Verify and commit

- [ ] **Step 1**

```bash
grep -rn "from 'node:\|from 'electron'" electron/core/runtime        # no output
grep -rn "\bfetch(\|new WebSocket\|process\.\(env\|platform\|kill\)" electron/core   # no output
npm run check 2>&1 | tail -n 12
npm run test:e2e -- workspace-status desktop
```

- [ ] **Step 2: Commit**

```bash
git add -A electron tests
git commit -m "refactor(runtime): pure runtime core behind process, docker and CDP ports; CDP call timeout"
```

## Self-review

- Spec coverage (04 runtime row): core `ports.ts` (renamed `port-service.ts` so the feature's `ports.ts` holds port interfaces like every other feature), `containers.ts`, `live-view.ts`, `chrome-inspect.ts`; ports `PortScanner`, `DockerRunner`, `CdpConnection`, `Clipboard`, `AppOpener`, `LiveViewPublisher` (+ `DockerSocketFiles`: Colima socket discovery and realpath were the remaining I/O in `containers.ts`); adapters `process/{ps-lsof,open-app}`, `docker/docker-runner`, `cdp/cdp-connection`, `electron-shell/clipboard`; driving `ipc/runtime.ts`; `ports.core`, `containers.core`, `live-view.core` tests; CDP call timeout.
