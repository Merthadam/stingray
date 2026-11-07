import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ActivitySnapshot, PiActivity, PiPhase } from '../src/activity';

const uuid = z.string().uuid();
const hello = z.object({ type: z.literal('hello'), v: z.literal(1), token: z.string().regex(/^[a-f0-9]{64}$/), run: uuid, runtime: uuid, supported: z.boolean() }).strict();
const state = z.object({ type: z.literal('state'), seq: z.number().int().min(1).max(1e9), phase: z.enum(['idle', 'working', 'waiting', 'failed', 'interrupted', 'unknown']), completed: z.number().int().min(0).max(1e9) }).strict();
type TerminalBinding = { terminalId: string; workspaceId: string; token: string };
type Entry = PiActivity & { run: string; runtime: string; retired: Set<string>; seq: number; completed: number; socket?: Socket };

/** A private local socket. Credentials bind to terminals, never to client-selected workspaces.
 * This protects against unrelated connections, not hostile code running as the same OS user
 * or inside an agent that already possesses the capability. No payloads are logged. */
export class ActivityService {
  private server?: Server;
  private sockets = new Set<Socket>();
  private terminals = new Map<string, TerminalBinding>();
  private entries = new Map<string, Entry>();
  private revision = 0;
  directory = '';
  endpoint = '';
  constructor(private publish: (snapshot: ActivitySnapshot) => void, private leaseMs = 20000) {}
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
    return { revision: this.revision, agents: [...this.entries.values()].map(e => ({ id: e.id, terminalId: e.terminalId, workspaceId: e.workspaceId, connection: e.connection, phase: e.phase, reviewRevision: e.reviewRevision })) };
  }
  acknowledge(id: string, terminalId: string, reviewRevision: number) {
    const entry = this.entries.get(id);
    if (!entry || entry.terminalId !== terminalId || entry.reviewRevision !== reviewRevision) return;
    entry.reviewRevision = null; this.changed();
  }
  private changed() { ++this.revision; this.publish(this.snapshot()); }
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
        this.changed();
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
          const parsed = hello.safeParse(value);
          if (!parsed.success) { socket.destroy(); return; }
          const h = parsed.data;
          const terminal = [...this.terminals.values()].find(t => t.token === h.token);
          if (!terminal) { socket.destroy(); return; }
          entry = [...this.entries.values()].find(e => e.terminalId === terminal.terminalId && e.run === h.run);
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
            const siblings = [...this.entries.values()].filter(e => e.terminalId === terminal.terminalId);
            if (siblings.length >= 8) {
              const disposable = siblings.find(e => !e.socket && e.reviewRevision === null);
              if (!disposable) { socket.destroy(); return; }
              this.entries.delete(disposable.id);
            }
            entry = { id: randomUUID(), terminalId: terminal.terminalId, workspaceId: terminal.workspaceId, run: h.run, runtime: h.runtime, retired: new Set(), seq: 0, completed: 0, reviewRevision: null, connection: 'disconnected', phase: 'unknown' };
            this.entries.set(entry.id, entry);
          }
          entry.socket = socket;
          entry.connection = h.supported ? 'connected' : 'unsupported';
          entry.phase = 'unknown';
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
          entry.completed = s.completed; entry.phase = s.phase as PiPhase;
          if (completed) entry.reviewRevision = this.revision + 1;
          if (changed) this.changed();
        }
      }
      if (buffer.length > 1024) socket.destroy();
    });
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.terminals.clear(); this.entries.clear();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
