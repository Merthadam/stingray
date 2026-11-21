import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import { TerminalMirror } from '../electron/terminal-mirror';
// CommonJS bundles: Node's ESM loader (tests) cannot see their named exports.
const Terminal = headless.Terminal; type Terminal = InstanceType<typeof Terminal>;
const { Unicode11Addon } = unicode11;

/** Replays a snapshot the way a new renderer pane does. */
async function restore(data: string, cols: number, rows: number) {
  const t = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon()); t.unicode.activeVersion = '11';
  const seen = new Map<number, boolean>();
  for (const final of ['h', 'l']) t.parser.registerCsiHandler({ prefix: '?', final }, params => {
    for (const p of params) if (typeof p === 'number') seen.set(p, final === 'h');
    return false;
  });
  await new Promise<void>(resolve => t.write(data, resolve));
  return { t, seen };
}
const text = (t: Terminal, y: number) => t.buffer.active.getLine(y)?.translateToString(true) ?? '';

test('restores a fullscreen TUI whose modes were set long before the last 128 KB', async () => {
  const mirror = new TerminalMirror(40, 10);
  let sequence = 0;
  mirror.write('shell history\r\n$ pi\r\n', ++sequence);
  mirror.write('\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?25l', ++sequence);
  const frame = (n: number) => '\x1b[H\x1b[2J' + 'frame ' + n + ' ✅\r\n' + 'x'.repeat(30);
  for (let n = 0; n < 6000; n++) mirror.write(frame(n), ++sequence); // far beyond the old 128 KB tail
  const snapshot = await mirror.snapshot();
  assert.equal(snapshot.sequence, sequence);
  const { t, seen } = await restore(snapshot.data, 40, 10);
  assert.equal(t.buffer.active.type, 'alternate', 'alternate screen restored');
  assert.equal(text(t, 0), 'frame 5999 ✅');
  assert.equal(t.modes.bracketedPasteMode, true, 'paste keeps arriving bracketed');
  assert.equal(t.modes.mouseTrackingMode, 'vt200', 'wheel keeps going to the TUI');
  assert.equal(seen.get(1006), true, 'SGR mouse encoding restored');
  assert.equal(seen.get(25), false, 'cursor stays hidden');
  assert.equal(t.buffer.normal.getLine(0)?.translateToString(true), 'shell history', 'shell screen behind the TUI kept');
  mirror.dispose(); t.dispose();
});

test('restores scrollback and leaving a TUI restores the earlier shell screen', async () => {
  const mirror = new TerminalMirror(30, 5);
  for (let i = 0; i < 50; i++) mirror.write('line ' + i + '\r\n', i + 1);
  mirror.write('\x1b[?1049h\x1b[?2004hTUI', 51);
  mirror.write('\x1b[?2004l\x1b[?1049l', 52);
  const { t } = await restore((await mirror.snapshot()).data, 30, 5);
  assert.equal(t.buffer.active.type, 'normal');
  assert.equal(t.modes.bracketedPasteMode, false);
  assert.equal(t.buffer.active.length, 51, 'all lines plus the cursor line');
  assert.equal(text(t, 0), 'line 0');
  mirror.dispose(); t.dispose();
});

test('snapshots follow resizes and report the sequence they include', async () => {
  const mirror = new TerminalMirror(20, 4);
  mirror.write('abc', 1);
  mirror.resize(50, 8);
  mirror.write('\r\n' + 'y'.repeat(45), 2);
  const snapshot = await mirror.snapshot();
  assert.equal(snapshot.sequence, 2);
  const { t } = await restore(snapshot.data, 50, 8);
  assert.equal(text(t, 1), 'y'.repeat(45), 'no wrap at the old width');
  mirror.dispose(); t.dispose();
});

test('a pending snapshot fails instead of hanging when the terminal closes', async () => {
  const mirror = new TerminalMirror(20, 4);
  mirror.write('x'.repeat(200_000), 1);
  const pending = mirror.snapshot();
  mirror.dispose();
  await assert.rejects(pending, /closed/);
});

test('keeps OSC 8 hyperlinks in a restored pane', async () => {
  const mirror = new TerminalMirror(40, 5);
  mirror.write('see \x1b]8;;file:///tmp/x.txt\x07LINK\x1b]8;;\x07 done\r\n', 1);
  const { data } = await mirror.snapshot();
  assert.doesNotMatch(data, /\x1b\[4m/, "link cells are not given a real underline");
  assert.match(data, /\x1b\]8;[^;]*;file:\/\/\/tmp\/x\.txt(\x07|\x1b\\)LINK\x1b\]8;;(\x07|\x1b\\) done/);
  const { t } = await restore(data, 40, 5);
  assert.equal(text(t, 0), 'see LINK done');
  // Re-serialising the restored pane must produce the same link again.
  const again = new TerminalMirror(40, 5);
  again.write(data, 1);
  assert.match((await again.snapshot()).data, /file:\/\/\/tmp\/x\.txt/);
  mirror.dispose(); again.dispose(); t.dispose();
});
