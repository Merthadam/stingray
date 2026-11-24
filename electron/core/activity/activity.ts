import { z } from 'zod';
import type { ActivitySnapshot, AgentActivity, AgentPhase } from '../../../shared/contracts/activity';
import type { ActivityRecord } from './activity-history';
import type { ActivityConnection, ActivityPublisher, ActivitySession, HistoryRepository, ProcessProbe, SessionOutcome } from './ports';

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
 * alone, so the terminal token never appears in argv. `resume` (async Claude tool hooks) only leaves Waiting; during Working it only refreshes liveness. */
const hookEvent = z.object({
  type: z.literal('event'), v: z.literal(2), token: token.optional(), run: token.optional(), harness: z.enum(['claude', 'codex']),
  session: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), pid: z.number().int().min(2).max(2 ** 22), at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  phase, completed: z.boolean(), ended: z.boolean(), resume: z.literal(true).optional(),
}).strict().refine(e => e.token || (e.harness === 'codex' && e.run));
type HookEvent = z.infer<typeof hookEvent>;
type TerminalBinding = { terminalId: string; workspaceId: string; token: string };
const uuid4 = () => globalThis.crypto.randomUUID();
const randomHex = (bytes: number) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
type Entry = AgentActivity & { startedAt: number; completedAt: number | null; run: string; runtime: string; retired: Set<string>; seq: number; completed: number; socket?: ActivityConnection; pid?: number; at: number; seen?: number; nonce?: string };

/** A private local socket. Credentials bind to terminals, never to client-selected workspaces.
 * This protects against unrelated connections, not hostile code running as the same OS user
 * or inside an agent that already possesses the capability. No payloads are logged. */
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
  // Hook agents can stop reporting without exiting (Claude interrupted with Esc fires no hook): Working this long
  // without any event becomes unknown. Long silent tool runs also hit it; unknown is honest there too.
  private readonly hookWorkingMs: number;
  private readonly persistMs: number;
  private readonly probe: ProcessProbe;
  private readonly now: () => number;
  constructor(private publish: ActivityPublisher, options: ActivityOptions) {
    this.leaseMs = options.leaseMs ?? 20000; this.hookWorkingMs = options.hookWorkingMs ?? 15 * this.leaseMs;
    this.persistMs = options.persistMs ?? 1000; this.probe = options.probe; this.now = options.now ?? Date.now;
  }
  /** Hook-reported agents have no socket to close: their liveness is the agent process. */
  startLiveness() {
    this.liveness = setInterval(() => this.checkLiveness(), Math.min(5000, this.leaseMs));
    (this.liveness as { unref?: () => void }).unref?.();
  }
  bind(terminalId: string, workspaceId: string) {
    const binding = { terminalId, workspaceId, token: randomHex(32) };
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
  restore(history: HistoryRepository) {
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
      (this.persistTimer as { unref?: () => void }).unref?.();
    }
  }
  checkLiveness() {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (!entry.pid || entry.connection !== 'connected') continue;
      if (entry.phase === 'working' && this.now() - entry.seen! > this.hookWorkingMs) { entry.phase = 'unknown'; changed = true; }
      if (!this.probe.alive(entry.pid)) { entry.connection = 'disconnected'; changed = true; }
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
  private hookEvent(conn: ActivityConnection, e: HookEvent) {
    // A nonce alone only reaches the live run that registered it: it cannot create entries or revive a dead one.
    const terminal = e.token ? [...this.terminals.values()].find(t => t.token === e.token)
      : this.terminals.get([...this.entries.values()].find(x => x.nonce === e.run && x.run === e.session && x.harness === e.harness && x.connection === 'connected')?.terminalId ?? '');
    if (!terminal) { conn.destroy(); return; }
    let entry = [...this.entries.values()].find(x => x.terminalId === terminal.terminalId && x.harness === e.harness && x.run === e.session);
    conn.end();
    if (entry && e.at < entry.at) return; // a racing older hook must not overwrite a newer state
    if (e.resume && entry?.phase !== 'waiting') {
      // A long Working turn reports only resume events (Claude PostToolUse): they keep it alive without a phase change.
      if (entry && entry.phase === 'working' && e.at >= entry.at) { entry.seen = this.now(); entry.pid = e.pid; entry.at = e.at; }
      return;
    }
    if (!entry) {
      if (e.ended || !this.admit(terminal.terminalId)) return;
      entry = { id: uuid4(), terminalId: terminal.terminalId, workspaceId: terminal.workspaceId, harness: e.harness, run: e.session, runtime: '', retired: new Set(), seq: 0, completed: 0, at: 0, reviewRevision: null, connection: 'disconnected', phase: 'unknown', restored: false, startedAt: this.now(), lastEventAt: this.now(), completedAt: null };
      this.entries.set(entry.id, entry);
    }
    const before = `${entry.connection}/${entry.phase}`;
    entry.at = e.at; entry.pid = e.pid; entry.seen = entry.lastEventAt = this.now();
    if (e.token && e.run) entry.nonce = e.run;
    // An observed clean end (e.g. Claude /clear starts a new session) is not a lost connection.
    if (e.ended && entry.reviewRevision === null) { this.entries.delete(entry.id); this.changed(); return; }
    entry.connection = e.ended ? 'disconnected' : 'connected'; entry.phase = e.phase;
    if (e.completed) { entry.reviewRevision = this.revision + 1; entry.completedAt = entry.lastEventAt; }
    if (e.completed || before !== `${entry.connection}/${entry.phase}`) this.changed();
    else this.persistSoon(); // keep the saved last-event time current
  }
  /** One accepted connection; null when 64 are open. The caller frames lines, applies size/rate limits and lease timers. */
  openSession(conn: ActivityConnection): ActivitySession | null {
    if (this.connections.size >= 64) return null;
    this.connections.add(conn);
    let entry: Entry | undefined;
    const message = (value: unknown): SessionOutcome => {
      if (!entry) {
        const event = hookEvent.safeParse(value);
        if (event.success) { this.hookEvent(conn, event.data); return 'stop'; }
        const parsed = hello.safeParse(value);
        if (!parsed.success) { conn.destroy(); return 'stop'; }
        const h = parsed.data;
        const terminal = [...this.terminals.values()].find(t => t.token === h.token);
        if (!terminal) { conn.destroy(); return 'stop'; }
        entry = [...this.entries.values()].find(e => e.terminalId === terminal.terminalId && e.harness === 'pi' && e.run === h.run);
        if (entry) {
          if (entry.retired.has(h.runtime)) { entry = undefined; conn.destroy(); return 'stop'; }
          if (entry.runtime !== h.runtime) {
            if (entry.retired.size >= 64) { entry = undefined; conn.destroy(); return 'stop'; }
            entry.retired.add(entry.runtime); entry.runtime = h.runtime;
            entry.seq = 0; entry.completed = 0;
          }
          // Reconnection/reload never acknowledges an unseen completion.
          entry.socket?.destroy();
        } else {
          if (!this.admit(terminal.terminalId)) { conn.destroy(); return 'stop'; }
          entry = { id: uuid4(), terminalId: terminal.terminalId, workspaceId: terminal.workspaceId, harness: 'pi', run: h.run, runtime: h.runtime, retired: new Set(), seq: 0, completed: 0, at: 0, reviewRevision: null, connection: 'disconnected', phase: 'unknown', restored: false, startedAt: this.now(), lastEventAt: this.now(), completedAt: null };
          this.entries.set(entry.id, entry);
        }
        entry.socket = conn;
        entry.connection = h.supported ? 'connected' : 'unsupported';
        entry.phase = 'unknown'; entry.lastEventAt = this.now();
        this.changed(); return 'renew';
      } else {
        const parsed = state.safeParse(value);
        if (!parsed.success || entry.socket !== conn || entry.connection !== 'connected') { conn.destroy(); return 'stop'; }
        const s = parsed.data;
        if (s.seq <= entry.seq || s.completed < entry.completed) { conn.destroy(); return 'stop'; }
        entry.seq = s.seq;
        const completed = s.completed > entry.completed;
        const changed = completed || s.phase !== entry.phase;
        entry.completed = s.completed; entry.phase = s.phase as AgentPhase;
        if (changed) entry.lastEventAt = this.now();
        if (completed) { entry.reviewRevision = this.revision + 1; entry.completedAt = entry.lastEventAt; }
        if (changed) this.changed();
        return 'renew';
      }
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
  close() {
    clearInterval(this.liveness); clearTimeout(this.persistTimer); this.history = undefined;
    for (const c of this.connections) c.destroy();
    this.connections.clear(); this.terminals.clear(); this.entries.clear();
  }
}
