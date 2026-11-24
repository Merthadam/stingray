import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terminals } from '../../electron/core/terminals';
import { TerminalMirror } from '../../electron/adapters/driven/pty/terminal-mirror';
import type { TerminalEvent } from '../../shared/contracts/terminals';
import { fakeMirrors, fakeSpawner } from '../fakes/terminals';

const ws = '00000000-0000-4000-8000-0000000000c1';
function setup(mirrorFactory?: ConstructorParameters<typeof Terminals>[0]['mirrors']) {
  const events: TerminalEvent[] = [];
  const { spawner, processes } = fakeSpawner();
  const m = fakeMirrors();
  const terminals = new Terminals({ send: e => events.push(e), pty: spawner, mirrors: mirrorFactory ?? m.factory });
  return { terminals, events, processes, mirrors: m.mirrors };
}

test('child environment drops Electron/Stingray control variables', () => {
  const s = setup();
  s.terminals.create(ws, '/ws');
  assert.equal(s.processes[0].env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(s.processes[0].env.STINGRAY_DATA_DIR, undefined);
  assert.equal(s.processes[0].env.NODE_OPTIONS, undefined);
  assert.equal(s.processes[0].env.TERM, 'xterm-256color');
});

test('close before exit kills, removes, and ignores a later exit or data', () => {
  const s = setup();
  const t = s.terminals.create(ws, '/ws');
  s.terminals.close(t.id);
  assert.equal(s.processes[0].killed, true);
  assert.deepEqual(s.terminals.list(), []);
  const before = s.events.length;
  assert.doesNotThrow(() => { s.processes[0].exitWith(0); s.processes[0].emit('late'); });
  assert.deepEqual(s.terminals.list(), []);
  assert.equal(s.events.slice(before).filter(e => e.data !== undefined).length, 0, 'no data events after close');
});

test('exit then snapshot keeps the written data and the exit code; write after exit throws', async () => {
  const s = setup();
  const t = s.terminals.create(ws, '/ws');
  s.processes[0].emit('hello'); s.processes[0].exitWith(3);
  const snap = await s.terminals.snapshot(t.id);
  assert.equal(snap.data, 'hello'); assert.equal(snap.exitCode, 3);
  assert.throws(() => s.terminals.write(t.id, 'x'), /This terminal has exited\. Open a new one\./);
});

test('the 25th terminal is refused', () => {
  const s = setup();
  for (let i = 0; i < 24; i++) s.terminals.create(ws, '/ws');
  assert.throws(() => s.terminals.create(ws, '/ws'), /Close a terminal before opening another \(limit 24\)\./);
});

test('titles stay unique after closing one', () => {
  const s = setup();
  const a = s.terminals.create(ws, '/ws'); s.terminals.create(ws, '/ws');
  s.terminals.close(a.id);
  const c = s.terminals.create(ws, '/ws');
  assert.deepEqual(s.terminals.list().map(t => t.title).sort(), ['Terminal 2', 'Terminal 3']);
  assert.equal(c.title, 'Terminal 3');
});

test('flow control: a fast producer pauses the PTY above 1 MiB queued and resumes below 256 KiB', () => {
  const s = setup();
  s.terminals.create(ws, '/ws');
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 32; i++) s.processes[0].emit(chunk); // 2 MiB, mirror not drained
  assert.equal(s.processes[0].pauses, 1);
  assert.equal(s.events.filter(e => e.data).length, 32, 'every chunk still reaches the renderer');
  s.mirrors[0].drain();
  assert.equal(s.processes[0].resumes, 1);
});

test('flow control resumes exactly when the queue drops below 256 KiB', () => {
  const s = setup();
  s.terminals.create(ws, '/ws');
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 32; i++) s.processes[0].emit(chunk);
  s.mirrors[0].drainSome(28); // 4 chunks = 256 KiB still queued: not below LOW
  assert.equal(s.processes[0].resumes, 0);
  s.mirrors[0].drainSome(1); // 192 KiB queued
  assert.equal(s.processes[0].resumes, 1);
});

test('a mirror whose write throws does not stop later data events', () => {
  const s = setup((cols, rows) => {
    const mirror = new TerminalMirror(cols, rows);
    (mirror as unknown as { terminal: { write: () => never } }).terminal.write = () => { throw new Error('parser error'); };
    return mirror;
  });
  s.terminals.create(ws, '/ws');
  const error = console.error; console.error = () => {};
  try { s.processes[0].emit('a'); s.processes[0].emit('b'); } finally { console.error = error; }
  assert.deepEqual(s.events.filter(e => e.data).map(e => e.data), ['a', 'b']);
});
