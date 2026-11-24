# 05b · Activity feature extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** `electron/core/activity/` is pure (agent state machine, history records, harness definitions); the Unix
socket server moves to the driving adapter `electron/adapters/driving/hooks/activity-socket.ts` with a per-event error
boundary (rule 1); pid liveness and SQLite history become driven adapters; audit 4 (long Claude turns) is fixed.

**Architecture:** the core `ActivityService` exposes `openSession(connection)` → `{ message(value), closed() }`; the socket
adapter does framing, size/rate limits and lease timers and calls `message()` per parsed line inside try/catch. The
wiring class `ActivityService` (old signature `(publish, lease?, hookWorking?, persist?)` with `start()`/`close()`,
`directory`, `endpoint`) composes core + socket + `ProcessProbe`.

**Tech Stack:** TypeScript, zod, `node:net` (adapter only), node:test.

**Spec:** [04 § Commit 5](../specs/2026-11-23-04-hexagonal-modules-design.md#commit-5--per-feature-extraction) (activity row, rule 1), [07 § 4](../specs/2026-11-23-07-audit-fixes-design.md#finding-4--long-claude-turns-go-unknown-after-5-min).

**Depends on:** plan 05a committed. **Commit:** one, `refactor(activity): pure activity core, socket driving adapter; keep long Claude turns working`.

---

## Files

Create: `electron/core/activity/ports.ts`, `electron/adapters/driving/hooks/activity-socket.ts`,
`electron/adapters/driven/process/process-probe.ts`, `electron/adapters/driven/sqlite/activity-history-repository.ts`,
`electron/adapters/driving/ipc/activity.ts`, `electron/app/wiring/activity.ts`, `tests/fakes/activity.ts`,
`tests/activity/activity.core.test.ts`, `tests/activity/activity-socket.test.ts`.

Modify: `electron/core/activity/{activity,activity-history,harnesses,index}.ts`, `electron/adapters/driven/fs/activity-shell.ts`
(imports), `electron/core/terminals/terminals.ts` (type imports only), `electron/main.ts`, `tests/activity/activity.test.ts`
(import path + one new test), `tests/activity/activity-history.test.ts` and `tests/agents/pi-smoke.ts` (import paths).

---

### Task 1: Ports and fakes

- [ ] **Step 1: `electron/core/activity/ports.ts`**

```ts
import type { ActivitySnapshot } from '../../../shared/contracts/activity';
import type { ActivityRecord } from './activity-history';

/** One accepted hook/Pi connection, as seen by core. */
export interface ActivityConnection { end(): void; destroy(): void; readonly destroyed: boolean }
/** 'renew': extend the connection lease; 'stop': stop reading this chunk (connection ended or destroyed). */
export type SessionOutcome = 'continue' | 'renew' | 'stop';
export interface ActivitySession { message(value: unknown): SessionOutcome; closed(): void }
/** Whether a process may still be running (false only when it is known to be gone). */
export interface ProcessProbe { alive(pid: number): boolean }
export interface HistoryRepository { load(now?: number): ActivityRecord[]; save(records: ActivityRecord[], now?: number): void }
/** zsh integration used when terminals start (implemented by driven/fs/activity-shell.ts). */
export interface ShellIntegration { environment(shell: string, env: Record<string, string>): Record<string, string>; startup: string }
export type ActivityPublisher = (snapshot: ActivitySnapshot) => void;
/** Terminals that exist now (implemented by the terminals service in electron/app). */
export interface TerminalDirectory { list(): { id: string }[] }
```
Check `ShellIntegration` against `ActivityShell` (`electron/adapters/driven/fs/activity-shell.ts`): its `environment(shell, env)` and `startup` field must match; adjust the port's parameter types to the class's exact ones if they differ (no behaviour change).

- [ ] **Step 2: `tests/fakes/activity.ts`**

```ts
import type { ActivityConnection, HistoryRepository, ProcessProbe } from '../../electron/core/activity';
import type { ActivityRecord } from '../../electron/core/activity';

export function fakeConnection(): ActivityConnection & { ended: boolean } {
  const c = { ended: false, destroyed: false, end() { c.ended = true; }, destroy() { c.destroyed = true; } };
  return c;
}
export function fakeProbe(pids = new Set<number>()): ProcessProbe & { pids: Set<number> } {
  return { pids, alive: pid => pids.has(pid) };
}
export function memoryHistory(records: ActivityRecord[] = []): HistoryRepository & { saved: ActivityRecord[][] } {
  const saved: ActivityRecord[][] = [];
  return { saved, load: () => structuredClone(records), save: next => { saved.push(structuredClone(next)); } };
}
export function fakeClock(start = 1_000_000) { let now = start; return { now: () => now, advance: (ms: number) => { now += ms; } }; }
```

### Task 2: Pure `ActivityService` + audit 4 (TDD)

- [ ] **Step 1: `tests/activity/activity.core.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityService } from '../../electron/core/activity';
import { fakeClock, fakeConnection, fakeProbe } from '../fakes/activity';

const terminal = '00000000-0000-4000-8000-0000000000a1', workspace = '00000000-0000-4000-8000-0000000000b1';
function setup(hookWorkingMs = 1000) {
  const clock = fakeClock(), probe = fakeProbe(new Set([4242]));
  const service = new ActivityService(() => {}, { leaseMs: 100, hookWorkingMs, persistMs: 1000, probe, now: clock.now });
  const { STINGRAY_ACTIVITY_TOKEN: token } = service.bind(terminal, workspace);
  const hook = (fields: Record<string, unknown>) => {
    const conn = fakeConnection();
    const outcome = service.openSession(conn)!.message({ type: 'event', v: 2, token, harness: 'claude', session: 's1', pid: 4242, at: clock.now(), phase: 'working', completed: false, ended: false, ...fields });
    return { conn, outcome };
  };
  return { service, clock, probe, hook, phase: () => service.snapshot().agents[0]?.phase };
}

test('hook events drive phases; a stale event never overwrites a newer one', () => {
  const s = setup();
  assert.equal(s.hook({}).outcome, 'stop');
  assert.equal(s.phase(), 'working');
  s.clock.advance(10); s.hook({ phase: 'waiting' });
  assert.equal(s.phase(), 'waiting');
  s.hook({ phase: 'idle', at: 0 });
  assert.equal(s.phase(), 'waiting');
  s.clock.advance(10); s.hook({ resume: true });
  assert.equal(s.phase(), 'working');
});

test('Working without events expires to unknown after hookWorkingMs; a dead process disconnects', () => {
  const s = setup(1000);
  s.hook({});
  s.clock.advance(999); s.service.checkLiveness();
  assert.equal(s.phase(), 'working');
  s.clock.advance(2); s.service.checkLiveness();
  assert.equal(s.phase(), 'unknown');
  s.probe.pids.delete(4242); s.service.checkLiveness();
  assert.equal(s.service.snapshot().agents[0].connection, 'disconnected');
});

test('audit 4: resume events during a long Working turn keep it working; silence still expires it', () => {
  const s = setup(1000);
  s.hook({});
  for (let i = 0; i < 6; i++) { s.clock.advance(400); s.hook({ resume: true }); s.service.checkLiveness(); }
  assert.equal(s.phase(), 'working', '2.4 s of resume events > hookWorkingMs');
  const revision = s.service.snapshot().revision;
  s.clock.advance(400); s.hook({ resume: true });
  assert.equal(s.service.snapshot().revision, revision, 'resume while working publishes nothing');
  s.clock.advance(1001); s.service.checkLiveness();
  assert.equal(s.phase(), 'unknown');
});
```

- [ ] **Step 2: Run** — `npx tsx --test tests/activity/activity.core.test.ts` → FAIL (constructor shape / `openSession` / `checkLiveness` missing).

- [ ] **Step 3: Rewrite `electron/core/activity/activity.ts`** (protocol logic unchanged; only I/O moves out)

1. Imports: delete `node:net`, `node:crypto`, `node:fs/promises`, `node:path`. Keep `zod` and the schemas (lines 9-25). Add `import type { ActivityConnection, ActivityPublisher, ActivitySession, HistoryRepository, ProcessProbe, SessionOutcome } from './ports';`.
2. `Entry.socket?: Socket` → `socket?: ActivityConnection`.
3. Helpers: `const uuid4 = () => globalThis.crypto.randomUUID();` and `const randomHex = (bytes: number) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');`.
4. Class fields/constructor:
```ts
export interface ActivityOptions { leaseMs?: number; hookWorkingMs?: number; persistMs?: number; probe: ProcessProbe; now?: () => number }
export class ActivityService {
  private connections = new Set<ActivityConnection>();
  private terminals = new Map<string, TerminalBinding>();
  private entries = new Map<string, Entry>();
  private revision = 0;
  private liveness?: ReturnType<typeof setInterval>;
  private history?: HistoryRepository;
  private persistTimer?: ReturnType<typeof setTimeout>;
  directory = '';
  endpoint = '';
  protected readonly leaseMs: number;
  private readonly hookWorkingMs: number; private readonly persistMs: number;
  private readonly probe: ProcessProbe; private readonly now: () => number;
  constructor(private publish: ActivityPublisher, options: ActivityOptions) {
    this.leaseMs = options.leaseMs ?? 20000; this.hookWorkingMs = options.hookWorkingMs ?? 15 * this.leaseMs;
    this.persistMs = options.persistMs ?? 1000; this.probe = options.probe; this.now = options.now ?? Date.now;
  }
  /** Hook-reported agents have no socket to close: their liveness is the agent process. */
  startLiveness() { this.liveness = setInterval(() => this.checkLiveness(), Math.min(5000, this.leaseMs)); (this.liveness as { unref?: () => void }).unref?.(); }
```
`start()` is deleted from core (socket setup moves to the adapter; the wiring class keeps `start()`).
5. `bind()`: `token: randomHex(32)`. `restore(history: HistoryRepository)`. `persistTimer.unref()` → `(this.persistTimer as { unref?: () => void }).unref?.()`.
6. Every `Date.now()` → `this.now()`; every `randomUUID()` → `uuid4()`.
7. `checkProcesses()` → public `checkLiveness()`; replace the `try { process.kill(entry.pid, 0); } catch …` block with `if (!this.probe.alive(entry.pid)) { entry.connection = 'disconnected'; changed = true; }`.
8. `hookEvent(socket, e)` → `hookEvent(conn: ActivityConnection, e)`; `socket.destroy()`/`socket.end()` → `conn.destroy()`/`conn.end()`. Audit 4 — replace line `if (e.resume && entry?.phase !== 'waiting') return;` with:
```ts
    if (e.resume && entry?.phase !== 'waiting') {
      // A long Working turn reports only resume events (Claude PostToolUse): they keep it alive without a phase change.
      if (entry && entry.phase === 'working' && e.at >= entry.at) { entry.seen = this.now(); entry.pid = e.pid; entry.at = e.at; }
      return;
    }
```
9. Replace `accept(socket)` with `openSession`. Same checks, same order; framing/limits/timers are the adapter's:
```ts
  /** One accepted connection; null when 64 are open. The caller frames lines, applies size/rate limits and lease timers. */
  openSession(conn: ActivityConnection): ActivitySession | null {
    if (this.connections.size >= 64) return null;
    this.connections.add(conn);
    let entry: Entry | undefined;
    const message = (value: unknown): SessionOutcome => {
      if (!entry) {
        const event = hookEvent.safeParse(value);
        if (event.success) { this.hookEvent(conn, event.data); return 'stop'; }
        // … lines 206-230 of today's accept(), verbatim, with `socket` → `conn`, `Date.now()` → `this.now()`,
        // `randomUUID()` → `uuid4()`, every `{ …; socket.destroy(); return; }` → `{ …; conn.destroy(); return 'stop'; }`,
        // and `renewLease(); this.changed();` → `this.changed(); return 'renew';`
      }
      // … lines 232-243 verbatim with the same substitutions; `renewLease();` is dropped and the function ends with `return 'renew';`
    };
    const closed = () => {
      this.connections.delete(conn);
      if (entry?.socket === conn) {
        entry.socket = undefined;
        if (entry.connection !== 'unsupported') entry.connection = 'disconnected';
        entry.lastEventAt = this.now(); this.changed();
      }
    };
    return { message, closed };
  }
```
10. `close()` (sync): `clearInterval(this.liveness); clearTimeout(this.persistTimer); this.history = undefined; for (const c of this.connections) c.destroy(); this.connections.clear(); this.terminals.clear(); this.entries.clear();`.

- [ ] **Step 4: `electron/core/activity/activity-history.ts`** — keep the header comment, `MAX_ACTIVITY_PER_WORKSPACE`, `MAX_ACTIVITY_AGE_MS`, `time`, `recordSchema` (export it) and `ActivityRecord`; move `SCHEMA` and the whole `ActivityHistory` class to Task 4's repository. No `database` import remains.

- [ ] **Step 5: `harnesses.ts`** — imports `HarnessId` from `../../../shared/contracts/activity` (already, after plan 03); no change otherwise. `index.ts` exports: `ActivityService, type ActivityOptions, recordSchema, MAX_ACTIVITY_PER_WORKSPACE, MAX_ACTIVITY_AGE_MS, type ActivityRecord, claudeHookEvents, claudeSettings, harnesses, shellQuote, type HarnessContext` and every port type from `./ports`.

- [ ] **Step 6: Run** — `npx tsx --test tests/activity/activity.core.test.ts` → PASS.

### Task 3: Socket driving adapter with a per-event error boundary (rule 1, TDD)

- [ ] **Step 1: `tests/activity/activity-socket.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { ActivityService, type ActivitySession } from '../../electron/core/activity';
import { startActivitySocket } from '../../electron/adapters/driving/hooks/activity-socket';

const terminal = '00000000-0000-4000-8000-0000000000a1', workspace = '00000000-0000-4000-8000-0000000000b1';
const pause = (ms = 20) => new Promise(r => setTimeout(r, ms));
const closedPromise = (s: Socket) => new Promise<void>(r => s.once('close', () => r()));

test('rule 1: a malformed event and a throwing core call close only that connection; the next valid event is applied', async () => {
  const core = new ActivityService(() => {}, { leaseMs: 20000, probe: { alive: () => true } });
  const { STINGRAY_ACTIVITY_TOKEN: token } = core.bind(terminal, workspace);
  let failNext = true;
  const flaky = { openSession: (conn: Parameters<ActivityService['openSession']>[0]): ActivitySession | null => {
    const s = core.openSession(conn);
    return s && { message: v => { if (failNext) { failNext = false; throw new Error('core failed'); } return s.message(v); }, closed: () => s.closed() };
  } };
  const logged: string[] = [];
  const server = await startActivitySocket(flaky, { leaseMs: 20000, log: m => { logged.push(m); } });
  const open = async () => { const s = createConnection(server.endpoint); s.on('error', () => {}); await new Promise<void>(r => s.once('connect', () => r())); return s; };
  const event = () => JSON.stringify({ type: 'event', v: 2, token, harness: 'claude', session: 's1', pid: process.pid, at: Date.now(), phase: 'working', completed: false, ended: false }) + '\n';
  try {
    const malformed = await open(); const m = closedPromise(malformed); malformed.write('{not json\n'); await m;
    const throwing = await open(); const t = closedPromise(throwing); throwing.write(event()); await t;
    assert.ok(logged.some(l => l.includes('Activity event failed')));
    assert.equal(core.snapshot().agents.length, 0);
    const valid = await open(); valid.write(event());
    for (let i = 0; i < 100 && !core.snapshot().agents.length; i++) await pause();
    assert.equal(core.snapshot().agents[0]?.phase, 'working');
    valid.destroy();
  } finally { core.close(); await server.close(); }
});
```

- [ ] **Step 2: Run** — FAIL (module missing).

- [ ] **Step 3: `electron/adapters/driving/hooks/activity-socket.ts`** (moved from today's `start()`/`accept()`/`close()`; limits unchanged)

```ts
// The agent hook socket: a private Unix socket in a 0700 temp dir. Frames newline-delimited JSON with strict size, rate
// and lease limits and hands each parsed value to core. One bad event never stops the server (rule 1). No payloads are logged.
import { createServer, type Socket } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ActivityService } from '../../../core/activity';

export interface ActivitySocket { directory: string; endpoint: string; close(): Promise<void> }

export async function startActivitySocket(core: Pick<ActivityService, 'openSession'>,
  options: { leaseMs: number; log?: (message: string, error?: unknown) => void }): Promise<ActivitySocket> {
  const log = options.log ?? ((message, error) => console.error(message, error));
  // macOS AF_UNIX paths are short; os.tmpdir() can exceed their limit.
  const directory = await mkdtemp('/tmp/stingray-activity-');
  const sockets = new Set<Socket>();
  const server = createServer(socket => accept(socket));
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await chmod(directory, 0o700);
    const endpoint = path.join(directory, 'events.sock');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => { server.off('error', reject); resolve(); });
    });
    await chmod(endpoint, 0o600);
    server.on('error', () => { for (const socket of sockets) socket.destroy(); });
    return { directory, endpoint, close };
  } catch (error) { await close(); throw error; }

  function accept(socket: Socket) {
    const session = core.openSession({ end: () => socket.end(), destroy: () => socket.destroy(), get destroyed() { return socket.destroyed; } });
    if (!session) { socket.destroy(); return; }
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let windowStart = Date.now(), count = 0;
    // Absolute authentication/valid-frame deadlines: partial-byte drips must not keep a slot or a Working state alive.
    let deadline = setTimeout(() => socket.destroy(), 2000);
    const renewLease = () => { clearTimeout(deadline); deadline = setTimeout(() => socket.destroy(), options.leaseMs); };
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(deadline); sockets.delete(socket); session.closed(); });
    socket.on('data', chunk => {
      // Strictly bound even an unterminated line, before parsing untrusted JSON.
      if (buffer.length + chunk.length > 8192) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      let end: number;
      while (!socket.destroyed && (end = buffer.indexOf(10)) !== -1) {
        if (end > 1024) { socket.destroy(); return; }
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); count = 0; }
        if (++count > 100) { socket.destroy(); return; }
        let value: unknown;
        try { value = JSON.parse(line.toString('utf8')); } catch { socket.destroy(); return; }
        let outcome;
        try { outcome = session.message(value); } catch (error) { log('Activity event failed:', error instanceof Error ? error.message : 'error'); socket.destroy(); return; }
        if (outcome === 'stop') return;
        if (outcome === 'renew') renewLease();
      }
      if (buffer.length > 1024) socket.destroy();
    });
  }
}
```

- [ ] **Step 4: Run** — PASS.

### Task 4: Driven adapters, wiring, IPC handlers

- [ ] **Step 1: `electron/adapters/driven/process/process-probe.ts`**

```ts
import type { ProcessProbe } from '../../../core/activity';

export const nodeProcessProbe: ProcessProbe = {
  alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } },
};
```

- [ ] **Step 2: `electron/adapters/driven/sqlite/activity-history-repository.ts`** — the former `ActivityHistory` class verbatim (incl. `SCHEMA`, `load`, `save`, `db`, `prune`), renamed `SqliteActivityHistory implements HistoryRepository`, importing `recordSchema`, `MAX_ACTIVITY_PER_WORKSPACE`, `MAX_ACTIVITY_AGE_MS`, `type ActivityRecord`, `type HistoryRepository` from `../../../core/activity` and `database`, `transaction` from `./database`.

- [ ] **Step 3: `electron/app/wiring/activity.ts`**

```ts
import type { ActivitySnapshot } from '../../../shared/contracts/activity';
import { startActivitySocket, type ActivitySocket } from '../../adapters/driving/hooks/activity-socket';
import { nodeProcessProbe } from '../../adapters/driven/process/process-probe';
import { SqliteActivityHistory } from '../../adapters/driven/sqlite/activity-history-repository';
import { ActivityService as CoreActivityService } from '../../core/activity';

export { SqliteActivityHistory as ActivityHistory };
export { ActivityShell, shellQuote } from '../../adapters/driven/fs/activity-shell';
export { claudeHookEvents } from '../../core/activity';

export class ActivityService extends CoreActivityService {
  private socket?: ActivitySocket;
  constructor(publish: (snapshot: ActivitySnapshot) => void, leaseMs = 20000, hookWorkingMs = 15 * leaseMs, persistMs = 1000) {
    super(publish, { leaseMs, hookWorkingMs, persistMs, probe: nodeProcessProbe });
  }
  async start() {
    try {
      this.socket = await startActivitySocket(this, { leaseMs: this.leaseMs });
      this.directory = this.socket.directory; this.endpoint = this.socket.endpoint;
      this.startLiveness();
    } catch (error) { await this.close(); throw error; }
  }
  async close() { super.close(); await this.socket?.close(); this.socket = undefined; }
}
```

- [ ] **Step 4: `electron/adapters/driving/ipc/activity.ts`**

```ts
import type { activityContract } from '../../../../shared/contracts/activity';
import type { Handlers } from '../../../../shared/contracts/define';
import type { ActivityService } from '../../../core/activity';

/** setVisible/acknowledge stay window-dependent until plan 06 moves them into core ActivityVisibility. */
export function activityHandlers(d: { activity: ActivityService; setVisible(ids: string[]): void; acknowledge(id: string, terminalId: string, revision: number): void }): Handlers<typeof activityContract> {
  return {
    activity: () => d.activity.snapshot(),
    activityView: ids => d.setVisible(ids),
    acknowledgeActivity: (id, terminalId, revision) => d.acknowledge(id, terminalId, revision),
    dismissActivity: workspaceId => d.activity.dismissRestored(workspaceId),
  };
}
```

- [ ] **Step 5: `electron/main.ts`** — import `ActivityService, ActivityHistory, ActivityShell` from `./app/wiring/activity`; replace `registerContract(ipc, activityContract, {…})` with
```ts
  registerContract(ipc, activityContract, activityHandlers({
    activity,
    setVisible: ids => { const known = new Set(terminals.list().map(t => t.id)); visibleTerminals = new Set(ids.filter(id => known.has(id))); },
    acknowledge: (id, terminalId, revision) => {
      if (win.isFocused() && win.isVisible() && !win.isMinimized() && visibleTerminals.has(terminalId)) activity.acknowledge(id, terminalId, revision);
    },
  }));
```

- [ ] **Step 6: Other importers** — `electron/core/terminals/terminals.ts`: `import type { ActivityService, ShellIntegration } from '../activity';` and the `activityShell?:` constructor parameter typed `ShellIntegration` (was `ActivityShell`). `electron/adapters/driven/fs/activity-shell.ts`: import harness names from `../../../core/activity` (index).

### Task 5: Existing tests, new integration case, verify, commit

- [ ] **Step 1: Paths** — `tests/activity/activity.test.ts`, `tests/activity/activity-history.test.ts`, `tests/activity/activity-shell.test.ts`, `tests/agents/pi-smoke.ts`: point `ActivityService`, `ActivityHistory`, `ActivityShell`, `shellQuote` imports at `../../electron/app/wiring/activity` (import edits only).

- [ ] **Step 2: New case in `tests/activity/activity.test.ts`** (append before the last test)

```ts
test('resume events keep a long hook Working turn alive; silence still expires it', async () => {
  const f = await fixture(50, 200);
  try {
    const token = f.env.STINGRAY_ACTIVITY_TOKEN, t0 = Date.now();
    await hook(f, hookEvent(token, { at: t0 }));
    await until(() => f.service.snapshot().agents[0]?.phase === 'working');
    for (let i = 1; i <= 8; i++) { await pause(60); await hook(f, hookEvent(token, { at: t0 + i, resume: true })); }
    assert.equal(f.service.snapshot().agents[0].phase, 'working', '480 ms of resume events > hookWorkingMs 200');
    await until(() => f.service.snapshot().agents[0].phase === 'unknown');
  } finally { await f.close(); }
});
```

- [ ] **Step 3: Purity, checks, e2e**

```bash
grep -rn "from 'node:\|from 'electron'" electron/core/activity    # expect no output
npm run check 2>&1 | tail -n 12                                   # fail 0
npm run test:e2e -- desktop terminal-links worktree-removal
node tests/activity/pi-activity.mjs                               # native Pi activity UI, macOS
```

- [ ] **Step 4: Commit**

```bash
git add -A electron tests docs/plans/2026-11-23-test-edit-ledger.md
git commit -m "refactor(activity): pure activity core, socket driving adapter; keep long Claude turns working"
```
(Ledger: one row "new test case in tests/activity/activity.test.ts (audit 4)".)

## Self-review

- Spec coverage (04 activity row): core `activity.ts`, `activity-history.ts`, `harnesses.ts`; ports `ProcessProbe`, `HistoryRepository`, `ShellIntegration`, `ActivityPublisher`, `TerminalDirectory`; adapters `process/process-probe.ts`, `sqlite/activity-history-repository.ts`, `fs/activity-shell.ts`; driving `ipc/activity.ts`, `hooks/activity-socket.ts`; core tests (phase transitions, lease expiry with fake clock, hook resume keeps `seen`); rule 1 socket test; audit 4 in core and integration tests.
- `TerminalDirectory` is declared here and implemented/used in plan 06 (`ActivityVisibility`).
