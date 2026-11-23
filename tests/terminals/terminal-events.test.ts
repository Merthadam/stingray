import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalEvents } from '../../src/features/terminals/terminal-events';
import type { TerminalEvent } from '../../shared/contracts/terminals';

test('subscribers get only their terminal’s events; the IPC listener exists only while someone listens', () => {
  let ipc: ((e: TerminalEvent) => void) | null = null, subscriptions = 0;
  const events = createTerminalEvents(listener => { subscriptions++; ipc = listener; return () => { ipc = null; }; });
  const a: TerminalEvent[] = [], b: TerminalEvent[] = [], all: TerminalEvent[] = [];
  const offA = events.on('a', e => a.push(e)), offB = events.on('b', e => b.push(e)), offAll = events.on(null, e => all.push(e));
  assert.equal(subscriptions, 1, 'one IPC subscription');
  ipc!({ id: 'a', data: 'x', sequence: 1 }); ipc!({ id: 'b', data: 'y', sequence: 1 });
  assert.deepEqual([a.length, b.length, all.length], [1, 1, 2]);
  offA(); offB();
  assert.notEqual(ipc, null);
  offAll();
  assert.equal(ipc, null, 'unsubscribing the last removes the IPC listener');
});
