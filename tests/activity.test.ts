import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { ActivityService } from '../electron/activity';
import { activityLabel, aggregateActivity, harnessLabel, newerActivity, type AgentActivity } from '../src/activity';

const pause = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => unknown) { for (let i = 0; i < 200; i++) { if (fn()) return; await pause(); } assert.fail('Timed out'); }
async function fixture(lease = 20000, hookWorking?: number) {
  const service = new ActivityService(() => {}, lease, hookWorking); await service.start();
  const terminal = randomUUID(), workspace = randomUUID();
  const env = service.bind(terminal, workspace);
  const sockets: Socket[] = [];
  const open = async () => { const s = createConnection(env.STINGRAY_ACTIVITY_SOCKET); sockets.push(s); s.on('error', () => {}); await new Promise<void>(r => s.once('connect', r)); return s; };
  const hello = (overrides = {}) => ({ type: 'hello', v: 1, token: env.STINGRAY_ACTIVITY_TOKEN, run: randomUUID(), runtime: randomUUID(), supported: true, ...overrides });
  const send = (s: Socket, value: unknown) => s.write(JSON.stringify(value) + '\n');
  return { service, terminal, workspace, env, open, hello, send, close: async () => { sockets.forEach(s => s.destroy()); await service.close(); } };
}
const state = (seq: number, phase = 'idle', completed = 0) => ({ type: 'state', seq, phase, completed });

test('labels do not confuse shell/disconnection/error with idle; deterministic workspace priority', () => {
  const base: AgentActivity = { id: 'a', terminalId: 't', workspaceId: 'w', harness: 'pi', connection: 'connected', phase: 'idle', reviewRevision: null };
  assert.equal(activityLabel(base), 'Idle');
  for (const [phase, label] of [['working','Working'],['waiting','Waiting for you'],['failed','Failed'],['interrupted','Interrupted'],['unknown','Tracking unavailable']] as const) assert.equal(activityLabel({ ...base, phase }), label);
  assert.equal(activityLabel({ ...base, connection: 'disconnected' }), 'Disconnected');
  assert.equal(activityLabel({ ...base, connection: 'unsupported' }), 'Tracking unavailable');
  assert.equal(activityLabel({ ...base, connection: 'disconnected', reviewRevision: 2 }), 'Needs review');
  assert.equal(aggregateActivity([]), null);
  assert.equal(aggregateActivity([base, { ...base, phase: 'working' }, { ...base, phase: 'waiting' }]), 'Waiting for you');
  const current = { revision: 3, agents: [base] };
  assert.equal(newerActivity(current, { revision: 2, agents: [] }), current);
  assert.equal(newerActivity(current, { revision: 3, agents: [] }), current);
  assert.equal(newerActivity(current, { revision: 4, agents: [] }).agents.length, 0);
});

test('private socket, metadata-only snapshots, exact acknowledgement and terminal attribution', async () => {
  const f = await fixture();
  try {
    assert.equal((await stat(f.service.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(f.service.endpoint)).mode & 0o777, 0o600);
    const s = await f.open(); f.send(s, f.hello()); f.send(s, state(1, 'working'));
    await until(() => f.service.snapshot().agents[0]?.phase === 'working');
    f.send(s, state(2, 'idle', 1)); await until(() => f.service.snapshot().agents[0]?.reviewRevision);
    const a = f.service.snapshot().agents[0];
    assert.equal(a.workspaceId, f.workspace); assert.equal(a.terminalId, f.terminal);
    assert.deepEqual(Object.keys(a).sort(), ['connection','harness','id','phase','reviewRevision','terminalId','workspaceId']);
    assert.equal(a.harness, 'pi');
    assert.ok(!JSON.stringify(f.service.snapshot()).includes(f.env.STINGRAY_ACTIVITY_TOKEN));
    f.service.acknowledge(a.id, randomUUID(), a.reviewRevision!);
    assert.equal(f.service.snapshot().agents[0].reviewRevision, a.reviewRevision);
    f.send(s, state(3, 'idle', 2)); await until(() => f.service.snapshot().agents[0].reviewRevision !== a.reviewRevision);
    f.service.acknowledge(a.id, f.terminal, a.reviewRevision!);
    const latest = f.service.snapshot().agents[0]; assert.ok(latest.reviewRevision);
    f.service.acknowledge(a.id, f.terminal, latest.reviewRevision!);
    assert.equal(f.service.snapshot().agents[0].reviewRevision, null);
    const revision = f.service.snapshot().revision; f.send(s, state(4, 'idle', 2)); await pause(30);
    assert.equal(f.service.snapshot().revision, revision, 'heartbeats do not rerender');
  } finally { await f.close(); }
});

test('reconnect, runtime replacement and replay retirement retain unseen completion', async () => {
  const f = await fixture();
  try {
    const h = f.hello(); const s = await f.open(); f.send(s, h); f.send(s, state(1, 'idle', 1));
    await until(() => f.service.snapshot().agents[0]?.reviewRevision);
    const original = f.service.snapshot().agents[0]; s.destroy();
    await until(() => f.service.snapshot().agents[0].connection === 'disconnected');
    const s2 = await f.open(); f.send(s2, h); f.send(s2, state(2, 'working', 1));
    await until(() => f.service.snapshot().agents[0].phase === 'working');
    assert.equal(f.service.snapshot().agents[0].reviewRevision, original.reviewRevision);
    const s3 = await f.open(); f.send(s3, { ...h, runtime: randomUUID() }); f.send(s3, state(1));
    await until(() => f.service.snapshot().agents[0].phase === 'idle');
    assert.equal(f.service.snapshot().agents[0].id, original.id);
    assert.equal(f.service.snapshot().agents[0].reviewRevision, original.reviewRevision);
    const stale = await f.open(); f.send(stale, h); await until(() => stale.destroyed);
    assert.equal(f.service.snapshot().agents[0].connection, 'connected');
    f.service.unbind(f.terminal, true); assert.equal(f.service.snapshot().agents.length, 0);
    const revoked = await f.open(); f.send(revoked, f.hello()); await until(() => revoked.destroyed);
    assert.equal(f.service.snapshot().agents.length, 0);
  } finally { await f.close(); }
});

test('authentication, schema, framing and sequence failures fail closed', async () => {
  const f = await fixture();
  try {
    for (const value of [f.hello({ token: '0'.repeat(64) }), f.hello({ workspaceId: f.workspace }), state(1), { ...f.hello(), prompt: 'private' }]) {
      const s = await f.open(); f.send(s, value); await until(() => s.destroyed);
    }
    assert.equal(f.service.snapshot().agents.length, 0);
    for (const value of [state(1), state(2, 'bogus'), { ...state(2), output: 'private' }, state(2, 'idle', 0)]) {
      const s = await f.open(); f.send(s, f.hello()); f.send(s, state(1, 'working', 1));
      await until(() => f.service.snapshot().agents.some(a => a.connection === 'connected'));
      f.send(s, value); await until(() => s.destroyed);
    }
    for (const raw of ['{bad}\n', 'x'.repeat(1025), 'x'.repeat(9000)]) {
      const s = await f.open(); s.write(raw); await until(() => s.destroyed);
    }
    const fragmented = await f.open(); const frame = JSON.stringify(f.hello()) + '\n';
    fragmented.write(frame.slice(0, 20)); await pause(); fragmented.write(frame.slice(20)); f.send(fragmented, state(1));
    await until(() => f.service.snapshot().agents.some(a => a.connection === 'connected' && a.phase === 'idle'));
  } finally { await f.close(); }
});

test('bounded sessions, sockets, rates, lease and unsupported version are explicit', async () => {
  const f = await fixture(100);
  try {
    const unsupported = await f.open(); f.send(unsupported, f.hello({ supported: false })); unsupported.end();
    await until(() => f.service.snapshot().agents[0]?.connection === 'unsupported');
    const lease = await f.open(); f.send(lease, f.hello()); f.send(lease, state(1, 'working'));
    const drip = setInterval(() => { if (!lease.destroyed) lease.write(' '); }, 20);
    try { await until(() => lease.destroyed); } finally { clearInterval(drip); }
    assert.equal(f.service.snapshot().agents[1].connection, 'disconnected');
    const flood = await f.open(); f.send(flood, f.hello());
    flood.write(Array.from({ length: 101 }, (_, i) => JSON.stringify(state(i + 1))).join('\n') + '\n');
    await until(() => flood.destroyed);
  } finally { await f.close(); }
  const g = await fixture();
  try {
    for (let i = 0; i < 8; i++) { const s = await g.open(); g.send(s, g.hello()); g.send(s, state(1, 'idle', 1)); }
    await until(() => g.service.snapshot().agents.length === 8);
    const ninth = await g.open(); g.send(ninth, g.hello()); await until(() => ninth.destroyed);
    assert.equal(g.service.snapshot().agents.length, 8);
    const sockets = await Promise.all(Array.from({ length: 57 }, () => g.open()));
    await until(() => sockets.some(s => s.destroyed));
  } finally { await g.close(); }
});

const hookEvent = (token: string, overrides = {}) => ({ type: 'event', v: 2, token, harness: 'claude', session: 'session-1', pid: process.pid, at: Date.now(), phase: 'working', completed: false, ended: false, ...overrides });
async function hook(f: Awaited<ReturnType<typeof fixture>>, value: unknown) {
  const s = await f.open(); f.send(s, value); await until(() => s.destroyed);
}

test('hello v2 names the harness; v1 stays Pi; only Pi streams over a socket', async () => {
  const f = await fixture();
  try {
    const s = await f.open(); f.send(s, f.hello({ v: 2, harness: 'pi' })); f.send(s, state(1, 'working'));
    await until(() => f.service.snapshot().agents[0]?.phase === 'working');
    assert.equal(f.service.snapshot().agents[0].harness, 'pi');
    for (const value of [f.hello({ v: 2, harness: 'claude' }), f.hello({ v: 2 }), f.hello({ harness: 'pi' })]) {
      const bad = await f.open(); f.send(bad, value); await until(() => bad.destroyed);
    }
    assert.equal(f.service.snapshot().agents.length, 1);
  } finally { await f.close(); }
});

test('hook-style one-shot events: per-session identity, ordering, review, clean end', async () => {
  const f = await fixture();
  try {
    const token = f.env.STINGRAY_ACTIVITY_TOKEN, t0 = Date.now();
    await hook(f, hookEvent(token, { at: t0, phase: 'idle' }));
    await until(() => f.service.snapshot().agents[0]?.phase === 'idle');
    const a = f.service.snapshot().agents[0];
    assert.deepEqual([a.harness, a.connection, a.terminalId, a.workspaceId], ['claude', 'connected', f.terminal, f.workspace]);
    await hook(f, hookEvent(token, { at: t0 + 2, phase: 'waiting' }));
    await hook(f, hookEvent(token, { at: t0 + 1, phase: 'working' })); // a racing older hook is ignored
    await until(() => f.service.snapshot().agents[0].phase === 'waiting'); await pause(30);
    assert.equal(f.service.snapshot().agents[0].phase, 'waiting');
    const revision = f.service.snapshot().revision;
    await hook(f, hookEvent(token, { at: t0 + 3, phase: 'waiting' }));
    assert.equal(f.service.snapshot().revision, revision, 'repeated phases do not rerender');
    await hook(f, hookEvent(token, { at: t0 + 4, phase: 'idle', completed: true }));
    await until(() => f.service.snapshot().agents[0].reviewRevision);
    // A second session (e.g. after /clear) is a separate entry; codex sessions never alias claude ones.
    await hook(f, hookEvent(token, { session: 'session-2', at: t0 + 5 }));
    await hook(f, hookEvent(token, { harness: 'codex', at: t0 + 5, phase: 'unknown' }));
    await until(() => f.service.snapshot().agents.length === 3);
    // Clean end: removed without unseen review, kept as disconnected with it.
    await hook(f, hookEvent(token, { session: 'session-2', at: t0 + 6, ended: true }));
    await hook(f, hookEvent(token, { at: t0 + 6, ended: true }));
    await until(() => f.service.snapshot().agents.length === 2);
    const ended = f.service.snapshot().agents.find(x => x.harness === 'claude')!;
    assert.equal(ended.connection, 'disconnected'); assert.ok(ended.reviewRevision);
    assert.ok(!JSON.stringify(f.service.snapshot()).includes(token));
    assert.ok(!JSON.stringify(f.service.snapshot()).includes('session-1'));
  } finally { await f.close(); }
});

test('hook events fail closed on bad tokens, payload fields and identities', async () => {
  const f = await fixture();
  try {
    const token = f.env.STINGRAY_ACTIVITY_TOKEN;
    for (const value of [hookEvent('0'.repeat(64)), hookEvent(token, { prompt: 'private' }), hookEvent(token, { harness: 'pi' }),
      hookEvent(token, { session: '../x' }), hookEvent(token, { session: 'x'.repeat(129) }), hookEvent(token, { pid: 1 }), hookEvent(token, { phase: 'done' }), hookEvent(token, { v: 1 }),
      hookEvent(token, { token: undefined, run: 'a'.repeat(64) }), hookEvent(token, { token: undefined })]) {
      await hook(f, value);
    }
    await hook(f, hookEvent(token, { ended: true })); // an end for an unknown session creates nothing
    assert.equal(f.service.snapshot().agents.length, 0);
    f.service.unbind(f.terminal, true); await hook(f, hookEvent(token));
    assert.equal(f.service.snapshot().agents.length, 0);
  } finally { await f.close(); }
});

test('hook-reported agents disconnect when their process exits, not on socket close', async () => {
  const f = await fixture(50);
  try {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await hook(f, hookEvent(f.env.STINGRAY_ACTIVITY_TOKEN, { pid: child.pid }));
    await pause(150);
    assert.equal(f.service.snapshot().agents[0].connection, 'connected');
    child.kill(); await until(() => f.service.snapshot().agents[0].connection === 'disconnected');
  } finally { await f.close(); }
});

test('async resume hooks only leave Waiting; a late one never re-opens a finished turn', async () => {
  const f = await fixture();
  try {
    const token = f.env.STINGRAY_ACTIVITY_TOKEN, t0 = Date.now();
    await hook(f, hookEvent(token, { at: t0, resume: true })); // creates nothing
    assert.equal(f.service.snapshot().agents.length, 0);
    await hook(f, hookEvent(token, { at: t0 + 1, phase: 'waiting' }));
    await hook(f, hookEvent(token, { at: t0 + 2, resume: true }));
    await until(() => f.service.snapshot().agents[0]?.phase === 'working');
    await hook(f, hookEvent(token, { at: t0 + 3, phase: 'idle', completed: true }));
    await hook(f, hookEvent(token, { at: t0 + 4, resume: true }));
    await pause(30); assert.equal(f.service.snapshot().agents[0].phase, 'idle');
  } finally { await f.close(); }
});

test('codex notify authenticates with the registered per-run nonce only while the run is live', async () => {
  const f = await fixture(50);
  try {
    const token = f.env.STINGRAY_ACTIVITY_TOKEN, nonce = 'a'.repeat(64), t0 = Date.now();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const codex = (overrides = {}) => ({ ...hookEvent(token, { harness: 'codex', session: String(child.pid), pid: child.pid, phase: 'unknown' }), ...overrides });
    const notify = (at: number, overrides = {}) => { const { token: _, ...rest } = codex({ run: nonce, at, completed: true, ...overrides }); return rest; };
    await hook(f, notify(t0)); // not registered yet
    assert.equal(f.service.snapshot().agents.length, 0);
    await hook(f, codex({ run: nonce, at: t0 + 1 }));
    await until(() => f.service.snapshot().agents[0]?.harness === 'codex');
    for (const bad of [notify(t0 + 2, { run: 'b'.repeat(64) }), notify(t0 + 2, { harness: 'claude' }), notify(t0 + 2, { session: '1' })]) await hook(f, bad);
    await pause(30); assert.equal(f.service.snapshot().agents[0].reviewRevision, null);
    await hook(f, notify(t0 + 3));
    await until(() => f.service.snapshot().agents[0].reviewRevision);
    const id = f.service.snapshot().agents[0].id;
    f.service.acknowledge(id, f.terminal, f.service.snapshot().agents[0].reviewRevision!);
    child.kill(); await until(() => f.service.snapshot().agents[0].connection === 'disconnected');
    await hook(f, notify(t0 + 4)); // a dead run's nonce is useless
    await pause(30); assert.deepEqual([f.service.snapshot().agents[0].connection, f.service.snapshot().agents[0].reviewRevision], ['disconnected', null]);
  } finally { await f.close(); }
});

test('hook Working without events expires to unknown while the process lives', async () => {
  const f = await fixture(50, 100);
  try {
    await hook(f, hookEvent(f.env.STINGRAY_ACTIVITY_TOKEN));
    await until(() => f.service.snapshot().agents[0]?.phase === 'working');
    await until(() => f.service.snapshot().agents[0].phase === 'unknown');
    assert.equal(f.service.snapshot().agents[0].connection, 'connected');
  } finally { await f.close(); }
});

test('sidebar harness label names a single harness, else Agents', () => {
  const base: AgentActivity = { id: 'a', terminalId: 't', workspaceId: 'w', harness: 'claude', connection: 'connected', phase: 'idle', reviewRevision: null };
  assert.equal(harnessLabel([base]), 'Claude Code');
  assert.equal(harnessLabel([{ ...base, harness: 'codex' }]), 'Codex');
  assert.equal(harnessLabel([base, { ...base, harness: 'pi' }]), 'Agents');
  assert.equal(harnessLabel([]), 'Agents');
});
