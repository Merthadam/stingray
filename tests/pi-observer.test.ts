import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { ActivityService } from '../electron/activity';
import { registerPiObserver, type PiObserverAPI } from '../agents/pi-observer';

const pause = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => unknown) { for (let i = 0; i < 200; i++) { if (fn()) return; await pause(); } assert.fail('Timed out'); }
async function fixture(version = '1.5.0') {
  const service = new ActivityService(() => {}); await service.start();
  const env = service.bind(randomUUID(), randomUUID());
  const handlers = new Map<string, Parameters<PiObserverAPI['on']>[1]>();
  const api: PiObserverAPI = { on: (name, fn) => { handlers.set(name, fn); } };
  const register = () => { handlers.clear(); registerPiObserver(api, version, env, 25); };
  register();
  const event = async (name: string, value: object = {}, idle = true) => {
    // Prove no accidental serialization/reading of sensitive event fields or context.
    const payload = Object.defineProperties(value, Object.fromEntries(['prompt','messages','message','title','input','errorMessage','toolResults'].map(key => [key, { get() { throw new Error('Sensitive field read'); } }])));
    assert.equal(await handlers.get(name)?.(payload, { isIdle: () => idle }), undefined, 'observer never returns a decision');
  };
  const agent = () => service.snapshot().agents[0];
  return { service, event, agent, register, handlers, close: async () => { await event('session_shutdown'); await service.close(); } };
}

test('observer starts only on session_start; final settlement only; actual UI spans; no payload access', async () => {
  const f = await fixture();
  try {
    await pause(40); assert.equal(f.agent(), undefined); assert.ok(!f.handlers.has('agent_end'));
    await f.event('session_start'); await until(() => f.agent()?.phase === 'idle');
    await f.event('before_agent_start'); await until(() => f.agent().phase === 'working');
    await f.event('ui_prompt_start'); await until(() => f.agent().phase === 'waiting');
    await f.event('ui_prompt_end'); await until(() => f.agent().phase === 'working');
    await f.event('turn_end', { outcome: 'completed' }); await f.event('agent_end'); await pause(30);
    assert.equal(f.agent().phase, 'working'); assert.equal(f.agent().reviewRevision, null);
    // A boundary continuation starts another low-level run, not a completion.
    await f.event('agent_before_settle', { outcome: 'completed' }); await f.event('agent_start');
    await f.event('turn_end', { outcome: 'error' }); await f.event('agent_end'); await pause(30);
    assert.equal(f.agent().phase, 'working'); assert.equal(f.agent().reviewRevision, null);
    await f.event('agent_start'); await f.event('turn_end', { outcome: 'completed' });
    await f.event('agent_before_settle', { outcome: 'completed' }); await f.event('agent_settled', { aborted: false });
    await until(() => f.agent().reviewRevision !== null); assert.equal(f.agent().phase, 'idle');
  } finally { await f.close(); }
});

test('failure, abort, unknown outcome and cancellable compaction never manufacture completion', async () => {
  const f = await fixture();
  try {
    await f.event('session_start'); await until(() => f.agent()?.phase === 'idle');
    for (const [outcome, phase, aborted] of [['error','failed',false],['completed','interrupted',true],['unknown','unknown',false]] as const) {
      await f.event('agent_start'); await f.event('agent_before_settle', { outcome }); await f.event('agent_settled', { aborted });
      await until(() => f.agent().phase === phase); assert.equal(f.agent().reviewRevision, null);
    }
    await f.event('session_before_compact'); await until(() => f.agent().phase === 'unknown');
    await f.event('session_compact', { willRetry: false }); await until(() => f.agent().phase === 'idle');
    await f.event('session_before_tree'); await until(() => f.agent().phase === 'unknown');
    await f.event('session_tree'); await until(() => f.agent().phase === 'idle');
    await f.event('session_compact_failed', { aborted: false, willRetry: false }); await until(() => f.agent().phase === 'failed');
    assert.equal(f.agent().reviewRevision, null);
  } finally { await f.close(); }
});

test('reload retains same run and review without duplicate entries; shutdown disconnects, never completes', async () => {
  const f = await fixture();
  try {
    await f.event('session_start'); await until(() => f.agent()?.phase === 'idle');
    await f.event('agent_start'); await f.event('agent_before_settle', { outcome: 'completed' }); await f.event('agent_settled');
    await until(() => f.agent().reviewRevision); const review = f.agent().reviewRevision, id = f.agent().id;
    await f.event('session_shutdown'); await until(() => f.agent().connection === 'disconnected');
    f.register(); await f.event('session_start'); await until(() => f.agent().connection === 'connected');
    assert.equal(f.service.snapshot().agents.length, 1); assert.equal(f.agent().id, id); assert.equal(f.agent().reviewRevision, review);
    await f.event('session_shutdown'); await f.event('session_shutdown'); await pause(80);
    assert.equal(f.agent().connection, 'disconnected'); assert.equal(f.agent().reviewRevision, review);
  } finally { await f.close(); }
});

test('observer reconnects with full state and missed completion counter; never stalls Pi', async () => {
  const root = await mkdtemp('/tmp/stingray-reconnect-');
  const frames: any[] = [];
  let connections = 0;
  const server = createServer(socket => {
    ++connections; socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); frames.push(frame);
        if (connections === 1 && frame.type === 'state') socket.destroy();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(root + '/socket', resolve));
  const handlers = new Map<string, Parameters<PiObserverAPI['on']>[1]>();
  const env = { STINGRAY_ACTIVITY_SOCKET: root + '/socket', STINGRAY_ACTIVITY_TOKEN: 'a'.repeat(64) };
  registerPiObserver({ on: (name, fn) => { handlers.set(name, fn); } }, '1.5.0', env, 100);
  const emit = (name: string, event = {}) => handlers.get(name)?.(event, { isIdle: () => true });
  try {
    await emit('session_start'); await until(() => frames.some(f => f.type === 'state'));
    await pause(20);
    await emit('agent_start'); await emit('agent_before_settle', { outcome: 'completed' }); await emit('agent_settled');
    await until(() => connections >= 2 && frames.some(f => f.completed === 1));
    const hellos = frames.filter(f => f.type === 'hello');
    assert.equal(hellos[0].run, hellos[1].run); assert.equal(hellos[0].runtime, hellos[1].runtime);
    const states = frames.filter(f => f.type === 'state'); assert.ok(states.at(-1).seq > states[0].seq);
    assert.equal(states.at(-1).phase, 'idle');
  } finally {
    await emit('session_shutdown'); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
});

test('unsupported Pi versions report unavailable, no fabricated state', async () => {
  const f = await fixture('9.0.0');
  try {
    await f.event('session_start'); await until(() => f.agent()?.connection === 'unsupported');
    await f.event('agent_start'); await f.event('agent_before_settle', { outcome: 'completed' }); await f.event('agent_settled');
    await pause(30); assert.equal(f.agent().phase, 'unknown'); assert.equal(f.agent().reviewRevision, null);
  } finally { await f.close(); }
});
