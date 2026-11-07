import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { PiPhase } from '../src/activity';

// The observer only reads these scalar fields, never messages, prompts, tool data,
// session files, UI titles, auth, or model output. It never returns a hook decision.
type Event = { aborted?: boolean; outcome?: string; willRetry?: boolean };
type Context = { isIdle(): boolean };
export type PiObserverAPI = { on(name: string, handler: (event: Event, ctx: Context) => void | Promise<void>): unknown };
export function registerPiObserver(pi: PiObserverAPI, version: string, env = process.env, heartbeatMs = 5000) {
  const endpoint = env.STINGRAY_ACTIVITY_SOCKET, token = env.STINGRAY_ACTIVITY_TOKEN;
  if (!endpoint || !token || !/^[a-f0-9]{64}$/.test(token)) return;
  // VERSION gates semantics, not permissions. Unknown versions remain unavailable.
  const supported = version === '1.5.0';
  let socket: Socket | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let active = false, connected = false, runtime = '', run = '', seq = 0, completed = 0;
  let working = false, waiting = false, outcome = 'none', rest: PiPhase = 'idle';
  const phase = (): PiPhase => waiting ? 'waiting' : working ? 'working' : rest;
  function send() {
    if (!connected || !socket || socket.destroyed || !supported) return;
    // Full snapshots + monotonic completion counter allow coalescing during outages.
    // Bound writes; losing the bridge must never stall Pi or affect its decisions.
    if (socket.writableLength > 8192) { socket.destroy(); return; }
    socket.write(JSON.stringify({ type: 'state', seq: ++seq, phase: phase(), completed }) + '\n');
  }
  function connect() {
    if (!active || socket) return;
    const current = createConnection(endpoint!); socket = current;
    const deadline = setTimeout(() => { if (!connected) current.destroy(); }, 500);
    deadline.unref(); current.unref();
    current.on('error', () => {});
    current.on('connect', () => {
      clearTimeout(deadline);
      if (!active || socket !== current) { current.destroy(); return; }
      connected = true;
      current.write(JSON.stringify({ type: 'hello', v: 1, token, run, runtime, supported }) + '\n');
      if (supported) send(); else current.end();
    });
    current.on('close', () => {
      clearTimeout(deadline);
      if (socket === current) { socket = undefined; connected = false; }
    });
    // No protocol messages are expected from the service.
    current.on('data', () => current.destroy());
  }
  function update() { if (active && supported) send(); }
  pi.on('session_start', (_event, ctx) => {
    if (timer) clearInterval(timer);
    socket?.destroy(); socket = undefined; connected = false;
    // A child process must not reuse its parent's run identity. Reloads in this
    // same process keep it, while every session runtime gets a fresh generation.
    if (env.STINGRAY_PI_PID !== String(process.pid) || !/^[a-f0-9-]{36}$/.test(env.STINGRAY_PI_RUN || '')) {
      env.STINGRAY_PI_PID = String(process.pid); env.STINGRAY_PI_RUN = randomUUID();
    }
    run = env.STINGRAY_PI_RUN!; runtime = randomUUID(); seq = 0; completed = 0;
    working = !ctx.isIdle(); waiting = false; rest = 'idle'; outcome = 'none'; active = true;
    connect();
    if (supported) { timer = setInterval(() => { if (socket) send(); else connect(); }, heartbeatMs); timer.unref(); }
  });
  const start = () => { working = true; rest = 'idle'; outcome = 'none'; update(); };
  pi.on('before_agent_start', start);
  pi.on('agent_start', start);
  pi.on('turn_end', event => { outcome = event.outcome || 'unknown'; });
  pi.on('agent_before_settle', event => { outcome = event.outcome || outcome; });
  // Deliberately no agent_end listener: retries, compaction, and queued turns follow it.
  pi.on('agent_settled', event => {
    working = false;
    if (event.aborted || outcome === 'aborted') rest = 'interrupted';
    else if (outcome === 'completed') { rest = 'idle'; ++completed; }
    else if (outcome === 'error') rest = 'failed';
    else rest = 'unknown';
    update();
  });
  pi.on('ui_prompt_start', () => { waiting = true; update(); });
  pi.on('ui_prompt_end', () => { waiting = false; update(); });
  // These are cancellable boundaries and do not expose a universal start/end pair.
  // Conservatively invalidate idle instead of inventing a successful completion.
  pi.on('session_before_compact', () => { if (!working) rest = 'unknown'; update(); });
  pi.on('session_before_tree', () => { if (!working) rest = 'unknown'; update(); });
  pi.on('session_tree', (_event, ctx) => { if (!working) rest = ctx.isIdle() ? 'idle' : 'unknown'; update(); });
  pi.on('session_compact', (event, ctx) => { if (!working && !event.willRetry) rest = ctx.isIdle() ? 'idle' : 'unknown'; update(); });
  pi.on('session_compact_failed', event => { if (!working && !event.willRetry) rest = event.aborted ? 'interrupted' : 'failed'; update(); });
  pi.on('session_shutdown', async () => {
    active = false;
    if (timer) clearInterval(timer); timer = undefined;
    const current = socket; socket = undefined; connected = false;
    if (!current || current.destroyed) return;
    await new Promise<void>(resolve => {
      const deadline = setTimeout(() => { current.destroy(); resolve(); }, 150);
      current.once('close', () => { clearTimeout(deadline); resolve(); });
      current.end();
    });
  });
}
