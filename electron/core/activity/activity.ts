import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ActivitySnapshot, AgentActivity, AgentPhase } from '../../../shared/contracts/activity';
import type { ActivityHistory, ActivityRecord } from './activity-history';

const uuid = z.string().uuid();
const token = z.string().regex(/^[a-f0-9]{64}$/);
const phase = z.enum(['idle', 'working', 'waiting', 'failed', 'interrupted', 'unknown']);
// v1 is the original Pi-only hello; v2 names the harness. Only Pi streams state over a long-lived socket.
const helloV1 = z.object({ type: z.literal('hello'), v: z.literal(1), token, run: uuid, runtime: uuid, supported: z.boolean() }).strict();
const hello = z.union([helloV1, helloV1.extend({ v: z.literal(2), harness: z.literal('pi') }).strict()]);
const state = z.object({ type: z.literal('state'), seq: z.number().int().min(1).max(1e9), phase, completed: z.number().int().min(0).max(1e9) }).strict();
/** One-shot frame from a short-lived hook process (Claude Code hooks, Codex notify): authenticate + report, then close.
 * `session` is the harness's opaque session identity, `pid` the agent process used for liveness, `at` orders racing hooks.
 * Codex `start` registers a per-run `run` nonce with the terminal token; Codex notify then authenticates with that nonce
 * alone, so the terminal token never appears in argv. `resume` (async Claude tool hooks) only leaves Waiting. */
const hookEvent = z.object({
  type: z.literal('event'), v: z.literal(2), token: token.optional(), run: token.optional(), harness: z.enum(['claude', 'codex']),
  session: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), pid: z.number().int().min(2).max(2 ** 22), at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  phase, completed: z.boolean(), ended: z.boolean(), resume: z.literal(true).optional(),
}).strict().refine(e => e.token || (e.harness === 'codex' && e.run));
type HookEvent = z.infer<typeof hookEvent>;
type TerminalBinding = { terminalId: string; workspaceId: string; token: string };
type Entry = AgentActivity & { startedAt: number; completedAt: number | null; run: string; runtime: string; retired: Set<string>; seq: number; completed: number; socket?: Socket; pid?: number; at: number; seen?: number; nonce?: string };

/** A private local socket. Credentials bind to terminals, never to client-selected workspaces.
 * This protects against unrelated connections, not hostile code running as the same OS user
 * or inside an agent that already possesses the capability. No payloads are logged. */
export class ActivityService {
  private server?: Server;
  private sockets = new Set<Socket>();
  private terminals = new Map<string, TerminalBinding>();
  private entries = new Map<string, Entry>();
  private revision = 0;
  private liveness?: ReturnType<typeof setInterval>;
  private history?: ActivityHistory;
  private persistTimer?: ReturnType<typeof setTimeout>;
  directory = '';
  endpoint = '';
  // Hook agents can stop reporting without exiting (Claude interrupted with Esc fires no hook): Working this long
  // without any event becomes unknown. Long silent tool runs also hit it; unknown is honest there too.
  constructor(private publish: (snapshot: ActivitySnapshot) => void, private leaseMs = 20000, private hookWorkingMs = 15 * leaseMs, private persistMs = 1000) {}
  async start() {
    // macOS AF_UNIX paths are short; os.tmpdir() can exceed their limit.
    this.directory = await mkdtemp('/tmp/stingray-activity-');
    await chmod(this.directory, 0o700);
    this.endpoint = path.join(this.directory, 'events.sock');
    this.server = createServer(socket => this.accept(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(this.endpoint, () => { this.server!.off('error', reject); resolve(); });
      });
      await chmod(this.endpoint, 0o600);
      this.server.on('error', () => { for (const socket of this.sockets) socket.destroy(); });
      // Hook-reported agents have no socket to close: their liveness is the agent process.
      this.liveness = setInterval(() => this.checkProcesses(), Math.min(5000, this.leaseMs)); this.liveness.unref();
    } catch (error) { await this.close(); throw error; }
  }
  bind(terminalId: string, workspaceId: string) {
    const binding = { terminalId, workspaceId, token: randomBytes(32).toString('hex') };
    this.terminals.set(terminalId, binding);
    return { STINGRAY_ACTIVITY_SOCKET: this.endpoint, STINGRAY_ACTIVITY_TOKEN: binding.token };
  }
  unbind(terminalId: string, remove = false) {
    this.terminals.delete(terminalId);
    let changed = false;
    for (const [id, entry] of this.entries) if (entry.terminalId === terminalId) {
      entry.socket?.destroy(); entry.socket = undefined;
      if (remove) this.entries.delete(id);
      else entry.connection = 'disconnected';
      changed = true;
    }
    if (changed) this.changed();
  }
  snapshot(): ActivitySnapshot {
    return { revision: this.revision, agents: [...this.entries.values()].map(e => ({ id: e.id, terminalId: e.terminalId, workspaceId: e.workspaceId, harness: e.harness, connection: e.connection, phase: e.phase, reviewRevision: e.reviewRevision, restored: e.restored, lastEventAt: e.lastEventAt })) };
  }
  /** Load the previous session's entries as restored history: their terminals are gone, so they only leave by dismissal,
   * workspace removal or retention. Later changes are saved at most once per `persistMs`; `flushHistory` saves at once. */
  restore(history: ActivityHistory) {
    this.history = history;
    for (const r of history.load()) if (!this.entries.has(r.id)) this.entries.set(r.id, {
      id: r.id, terminalId: r.terminalId, workspaceId: r.workspaceId, harness: r.harness, connection: 'disconnected', phase: r.phase,
      reviewRevision: r.needsReview ? this.revision + 1 : null, restored: true, lastEventAt: r.lastEventAt, startedAt: r.startedAt, completedAt: r.completedAt,
      run: '', runtime: '', retired: new Set(), seq: 0, completed: 0, at: 0,
    });
    this.changed();
  }
  /** Save now and stop persisting: call before quit closes terminals, which removes their entries. */
  flushHistory() {
    clearTimeout(this.persistTimer); this.persistTimer = undefined;
    this.saveHistory(); this.history = undefined;
  }
  private saveHistory() {
    try { this.history?.save([...this.entries.values()].map(e => this.record(e))); } catch { /* history is best effort */ }
  }
  dismissRestored(workspaceId: string) { this.drop(e => e.restored && e.workspaceId === workspaceId); }
  /** A removed workspace takes its entries along (its rows cascade in the database). */
  forgetWorkspace(workspaceId: string) { this.drop(e => e.workspaceId === workspaceId); }
  private drop(match: (entry: Entry) => boolean) {
    let changed = false;
    for (const [id, entry] of this.entries) if (match(entry)) { entry.socket?.destroy(); this.entries.delete(id); changed = true; }
    if (changed) this.changed();
  }
  private record(e: Entry): ActivityRecord {
    return { id: e.id, workspaceId: e.workspaceId, terminalId: e.terminalId, harness: e.harness, phase: e.phase, needsReview: e.reviewRevision !== null,
      startedAt: e.startedAt, lastEventAt: e.lastEventAt, completedAt: e.completedAt };
  }
  acknowledge(id: string, terminalId: string, reviewRevision: number) {
    const entry = this.entries.get(id);
    if (!entry || entry.restored || entry.terminalId !== terminalId || entry.reviewRevision !== reviewRevision) return;
    entry.reviewRevision = null; this.changed();
  }
  private changed() { ++this.revision; this.publish(this.snapshot()); this.persistSoon(); }
  /** Save at most once per `persistMs` (the timer is not reset by later changes). */
  private persistSoon() {
    if (this.history && !this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = undefined; this.saveHistory();
      }, this.persistMs);
      this.persistTimer.unref();
    }
  }
  private checkProcesses() {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (!entry.pid || entry.connection !== 'connected') continue;
      if (entry.phase === 'working' && Date.now() - entry.seen! > this.hookWorkingMs) { entry.phase = 'unknown'; changed = true; }
      try { process.kill(entry.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { entry.connection = 'disconnected'; changed = true; }
      }
    }
    if (changed) this.changed();
  }
  /** Room for one more run on a terminal, evicting a disconnected run without unseen review if needed. */
  private admit(terminalId: string) {
    const siblings = [...this.entries.values()].filter(e => e.terminalId === terminalId);
    if (siblings.length < 8) return true;
    const disposable = siblings.find(e => !e.socket && e.connection !== 'connected' && e.reviewRevision === null);
    if (disposable) this.entries.delete(disposable.id);
    return Boolean(disposable);
  }
  private hookEvent(socket: Socket, e: HookEvent) {
    // A nonce alone only reaches the live run that registered it: it cannot create entries or revive a dead one.
    const terminal = e.token ? [...this.terminals.values()].find(t => t.token === e.token)
      : this.terminals.get([...this.entries.values()].find(x => x.nonce === e.run && x.run === e.session && x.harness === e.harness && x.connection === 'connected')?.terminalId ?? '');
    if (!terminal) { socket.destroy(); return; }
    let entry = [...this.entries.values()].find(x => x.terminalId === terminal.terminalId && x.harness === e.harness && x.run === e.session);
    socket.end();
    if (entry && e.at < entry.at) return; // a racing older hook must not overwrite a newer state
    if (e.resume && entry?.phase !== 'waiting') return;
    if (!entry) {
      if (e.ended || !this.admit(terminal.terminalId)) return;
      entry = { id: randomUUID(), terminalId: terminal.terminalId, workspaceId: terminal.workspaceId, harness: e.harness, run: e.session, runtime: '', retired: new Set(), seq: 0, completed: 0, at: 0, reviewRevision: null, connection: 'disconnected', phase: 'unknown', restored: false, startedAt: Date.now(), lastEventAt: Date.now(), completedAt: null };
      this.entries.set(entry.id, entry);
    }
    const before = `${entry.connection}/${entry.phase}`;
    entry.at = e.at; entry.pid = e.pid; entry.seen = entry.lastEventAt = Date.now();
    if (e.token && e.run) entry.nonce = e.run;
    // An observed clean end (e.g. Claude /clear starts a new session) is not a lost connection.
    if (e.ended && entry.reviewRevision === null) { this.entries.delete(entry.id); this.changed(); return; }
    entry.connection = e.ended ? 'disconnected' : 'connected'; entry.phase = e.phase;
    if (e.completed) { entry.reviewRevision = this.revision + 1; entry.completedAt = entry.lastEventAt; }
    if (e.completed || before !== `${entry.connection}/${entry.phase}`) this.changed();
    else this.persistSoon(); // keep the saved last-event time current
  }
  private accept(socket: Socket) {
    if (this.sockets.size >= 64) { socket.destroy(); return; }
    this.sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let entry: Entry | undefined;
    let windowStart = Date.now(), count = 0;
    // Absolute authentication/valid-frame deadlines: partial-byte drips must not
    // keep a slot or a previously Working state alive indefinitely.
    let deadline = setTimeout(() => socket.destroy(), 2000);
    const renewLease = () => { clearTimeout(deadline); deadline = setTimeout(() => socket.destroy(), this.leaseMs); };
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(deadline);
      this.sockets.delete(socket);
      if (entry?.socket === socket) {
        entry.socket = undefined;
        if (entry.connection !== 'unsupported') entry.connection = 'disconnected';
        entry.lastEventAt = Date.now(); this.changed();
      }
    });
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
        if (!entry) {
          const event = hookEvent.safeParse(value);
          if (event.success) { this.hookEvent(socket, event.data); return; }
          const parsed = hello.safeParse(value);
          if (!parsed.success) { socket.destroy(); return; }
          const h = parsed.data;
          const terminal = [...this.terminals.values()].find(t => t.token === h.token);
          if (!terminal) { socket.destroy(); return; }
          entry = [...this.entries.values()].find(e => e.terminalId === terminal.terminalId && e.harness === 'pi' && e.run === h.run);
          if (entry) {
            if (entry.retired.has(h.runtime)) { entry = undefined; socket.destroy(); return; }
            if (entry.runtime !== h.runtime) {
              if (entry.retired.size >= 64) { entry = undefined; socket.destroy(); return; }
              entry.retired.add(entry.runtime); entry.runtime = h.runtime;
              entry.seq = 0; entry.completed = 0;
            }
            // Reconnection/reload never acknowledges an unseen completion.
            entry.socket?.destroy();
          } else {
            if (!this.admit(terminal.terminalId)) { socket.destroy(); return; }
            entry = { id: randomUUID(), terminalId: terminal.terminalId, workspaceId: terminal.workspaceId, harness: 'pi', run: h.run, runtime: h.runtime, retired: new Set(), seq: 0, completed: 0, at: 0, reviewRevision: null, connection: 'disconnected', phase: 'unknown', restored: false, startedAt: Date.now(), lastEventAt: Date.now(), completedAt: null };
            this.entries.set(entry.id, entry);
          }
          entry.socket = socket;
          entry.connection = h.supported ? 'connected' : 'unsupported';
          entry.phase = 'unknown'; entry.lastEventAt = Date.now();
          renewLease();
          this.changed();
        } else {
          const parsed = state.safeParse(value);
          if (!parsed.success || entry.socket !== socket || entry.connection !== 'connected') { socket.destroy(); return; }
          const s = parsed.data;
          if (s.seq <= entry.seq || s.completed < entry.completed) { socket.destroy(); return; }
          renewLease();
          entry.seq = s.seq;
          const completed = s.completed > entry.completed;
          const changed = completed || s.phase !== entry.phase;
          entry.completed = s.completed; entry.phase = s.phase as AgentPhase;
          if (changed) entry.lastEventAt = Date.now();
          if (completed) { entry.reviewRevision = this.revision + 1; entry.completedAt = entry.lastEventAt; }
          if (changed) this.changed();
        }
      }
      if (buffer.length > 1024) socket.destroy();
    });
  }
  async close() {
    clearInterval(this.liveness); clearTimeout(this.persistTimer); this.history = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.terminals.clear(); this.entries.clear();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
