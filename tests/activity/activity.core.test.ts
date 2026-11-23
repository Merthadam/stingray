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
