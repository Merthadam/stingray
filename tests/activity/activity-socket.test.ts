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
