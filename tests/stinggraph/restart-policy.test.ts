import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RestartPolicy } from '../../electron/core/stinggraph';

function clock() { let now = 1_000_000; return { now: () => now, advance: (ms: number) => { now += ms; } }; }

test('backoff is 1, 2, 4 s for quick crashes; the 4th quick crash stops automatic restarts', () => {
  const c = clock(), p = new RestartPolicy({ now: c.now });
  const delays: (number | null)[] = [];
  for (let i = 0; i < 4; i++) { p.started(); c.advance(100); delays.push(p.crashed(true)); p.timerFired(); }
  assert.deepEqual(delays, [1000, 2000, 4000, null]);
});

test('no restart without active graphs', () => {
  const c = clock(), p = new RestartPolicy({ now: c.now });
  p.started(); assert.equal(p.crashed(false), null);
});

test('open() may respawn only without a pending timer and outside the 30 s crash-limit window', () => {
  const c = clock(), p = new RestartPolicy({ now: c.now });
  assert.equal(p.mayRespawnOnOpen(), true);
  p.started(); c.advance(10); p.crashed(true);
  assert.equal(p.mayRespawnOnOpen(), false, 'backoff timer pending');
  p.timerFired();
  for (let i = 0; i < 3; i++) { p.started(); c.advance(10); p.crashed(true); p.timerFired(); }
  assert.equal(p.mayRespawnOnOpen(), false, 'limit reached, last crash < 30 s ago');
  c.advance(30_001);
  assert.equal(p.mayRespawnOnOpen(), true);
});

test('a child that lived 30 s resets the crash count', () => {
  const c = clock(), p = new RestartPolicy({ now: c.now });
  for (let i = 0; i < 3; i++) { p.started(); c.advance(10); p.crashed(true); p.timerFired(); }
  p.started(); c.advance(30_000); assert.equal(p.crashed(true), 1000);
});
