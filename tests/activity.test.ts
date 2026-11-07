import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { ActivityService } from '../electron/activity';
import { activityLabel, aggregateActivity, newerActivity, type PiActivity } from '../src/activity';

const pause = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => unknown) { for (let i = 0; i < 200; i++) { if (fn()) return; await pause(); } assert.fail('Timed out'); }
async function fixture(lease = 20000) {
  const service = new ActivityService(() => {}, lease); await service.start();
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
  const base: PiActivity = { id: 'a', terminalId: 't', workspaceId: 'w', connection: 'connected', phase: 'idle', reviewRevision: null };
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
    assert.deepEqual(Object.keys(a).sort(), ['connection','id','phase','reviewRevision','terminalId','workspaceId']);
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
