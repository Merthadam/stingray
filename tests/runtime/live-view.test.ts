import test from 'node:test';
import assert from 'node:assert/strict';
import { framePoint, keyInput } from '../../src/features/runtime/live-view';
import { liveViewInputSchema, type LiveViewEvent } from '../../shared/contracts/runtime';
import { APP_PAGE, LiveViews, MAX_LIVE_VIEWS, pickTarget, toCdpInput } from '../../electron/core/runtime/live-view';

const keys = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
const meta = { deviceWidth: 1440, deviceHeight: 900 };

test('input schema accepts normalized events and rejects out-of-range, unknown or oversized fields', () => {
  assert.ok(liveViewInputSchema.safeParse({ type: 'mouse', action: 'mousePressed', x: 0.5, y: 1, button: 'left', clickCount: 1, modifiers: 0 }).success);
  assert.ok(liveViewInputSchema.safeParse({ type: 'text', text: 'hello' }).success);
  for (const bad of [
    { type: 'mouse', action: 'mousePressed', x: 1.2, y: 0, button: 'left', clickCount: 1, modifiers: 0 },
    { type: 'mouse', action: 'mouseWheel', x: 0, y: 0, button: 'left', clickCount: 1, modifiers: 0 },
    { type: 'mouse', action: 'mouseMoved', x: 0, y: 0, button: 'none', clickCount: 0, modifiers: 16 },
    { type: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: Infinity, modifiers: 0 },
    { type: 'key', action: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, extra: true },
    { type: 'text', text: '' }, { type: 'text', text: 'x'.repeat(10_001) }, { type: 'eval', expression: '1' },
  ]) assert.equal(liveViewInputSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('framePoint normalizes inside the letterboxed image and ignores the bars', () => {
  const box = { left: 100, top: 50, width: 800, height: 600 }; // 16:10 frame in a 4:3 box: bars top and bottom
  const frame = { width: 1600, height: 1000 }; // shown 800x500 at y 100..600
  assert.deepEqual(framePoint(100, 100, box, frame), { x: 0, y: 0 });
  assert.deepEqual(framePoint(500, 350, box, frame), { x: 0.5, y: 0.5 });
  assert.deepEqual(framePoint(900, 600, box, frame), { x: 1, y: 1 });
  assert.equal(framePoint(500, 80, box, frame), null);
  assert.equal(framePoint(500, 350, box, { width: 0, height: 0 }), null);
});

test('keyInput types printable keys and Enter, but not shortcuts or key-ups', () => {
  assert.deepEqual(keyInput('keyDown', { ...keys, shiftKey: true, key: 'A', code: 'KeyA', keyCode: 65 }),
    { type: 'key', action: 'keyDown', key: 'A', code: 'KeyA', keyCode: 65, modifiers: 8, text: 'A' });
  assert.equal((keyInput('keyDown', { ...keys, key: 'Enter', code: 'Enter', keyCode: 13 }) as { text?: string }).text, '\r');
  assert.equal((keyInput('keyDown', { ...keys, metaKey: true, key: 'a', code: 'KeyA', keyCode: 65 }) as { text?: string }).text, undefined);
  assert.equal((keyInput('keyDown', { ...keys, key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }) as { text?: string }).text, undefined);
  assert.equal((keyInput('keyUp', { ...keys, key: 'a', code: 'KeyA', keyCode: 65 }) as { text?: string }).text, undefined);
  assert.equal(keyInput('keyDown', { ...keys, key: 'Unidentified', code: '', keyCode: 0 }), null);
  for (const key of ['A', 'Enter', 'ArrowLeft', 'é']) assert.ok(liveViewInputSchema.safeParse(keyInput('keyDown', { ...keys, key, code: '', keyCode: 0 })).success);
});

test('toCdpInput scales to page CSS pixels and picks the CDP key event type', () => {
  assert.deepEqual(toCdpInput({ type: 'mouse', action: 'mousePressed', x: 0.25, y: 0.5, button: 'left', clickCount: 2, modifiers: 2 }, meta),
    ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 360, y: 450, button: 'left', clickCount: 2, modifiers: 2 }]);
  assert.deepEqual(toCdpInput({ type: 'wheel', x: 1, y: 0, deltaX: 0, deltaY: 120, modifiers: 0 }, meta),
    ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1440, y: 0, button: 'none', deltaX: 0, deltaY: 120, modifiers: 0 }]);
  assert.equal(toCdpInput({ type: 'key', action: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, text: 'a', modifiers: 0 }, meta)[1].type, 'keyDown');
  assert.equal(toCdpInput({ type: 'key', action: 'keyDown', key: 'Tab', code: 'Tab', keyCode: 9, modifiers: 0 }, meta)[1].type, 'rawKeyDown');
  assert.equal(toCdpInput({ type: 'key', action: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0 }, meta)[1].type, 'keyUp');
  assert.deepEqual(toCdpInput({ type: 'text', text: 'hi' }, meta), ['Input.insertText', { text: 'hi' }]);
});

test('pickTarget finds the Stingray page and skips invalid or foreign targets', () => {
  const page = { id: 'ABC-123', type: 'page', url: APP_PAGE + '#x', title: 'Stingray', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ABC-123' };
  assert.equal(pickTarget([{ id: '../evil', type: 'page', url: APP_PAGE }, { id: 'W', type: 'service_worker', url: APP_PAGE },
    { id: 'O', type: 'page', url: 'https://example.com' }, 'junk', page])?.id, 'ABC-123');
  assert.equal(pickTarget([{ id: 'O', type: 'page', url: 'https://example.com' }]), null);
  assert.throws(() => pickTarget({ not: 'a list' }));
});

// Minimal CDP stand-ins: fetch answers /json/list, the socket opens when told to and records sent commands.
class FakeSocket {
  static OPEN = 1; static sockets: FakeSocket[] = [];
  readyState = 0; sent: { id: number; method: string; params: Record<string, unknown> }[] = [];
  private listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeSocket.sockets.push(this); }
  addEventListener(type: string, listener: (event: { data?: string }) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  dispatch(type: string, event: { data?: string } = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  open() { this.readyState = 1; this.dispatch('open'); }
  send(raw: string) {
    const message = JSON.parse(raw); this.sent.push(message);
    queueMicrotask(() => this.dispatch('message', { data: JSON.stringify({ id: message.id, result: {} }) }));
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatch('close'); }
  frame(sessionId: number) {
    this.dispatch('message', { data: JSON.stringify({ method: 'Page.screencastFrame', params: { sessionId, data: 'AAAA', metadata: { deviceWidth: 10, deviceHeight: 10 } } }) });
  }
}
async function withFakeCdp(run: () => Promise<void>) {
  const saved = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
  FakeSocket.sockets = [];
  globalThis.fetch = (async () => ({ json: async () => [{ id: 'T', type: 'page', url: APP_PAGE, title: 'Stingray' }] })) as unknown as typeof fetch;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  try { await run(); } finally { Object.assign(globalThis, saved); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const acks = (socket: FakeSocket) => socket.sent.filter(m => m.method === 'Page.screencastFrameAck').map(m => m.params.sessionId);

test('frames are acked to Chrome only after the renderer displayed them', () => withFakeCdp(async () => {
  const events: LiveViewEvent[] = [];
  const views = new LiveViews(event => events.push(event));
  const started = views.start({ port: 9222 });
  await tick(); FakeSocket.sockets[0].open();
  const { sessionId } = await started;
  const socket = FakeSocket.sockets[0];
  socket.frame(1); socket.frame(2);
  assert.equal(events.filter(e => e.kind === 'frame').length, 2);
  assert.deepEqual(acks(socket), [], 'not acked before display');
  views.ack(sessionId);
  assert.deepEqual(acks(socket), [1, 2]);
  views.ack(sessionId);
  assert.deepEqual(acks(socket), [1, 2], 'nothing pending: no extra acks');
  views.stopAll();
}));

test('stopAll() discards starts still connecting, and pending starts count toward the limit', () => withFakeCdp(async () => {
  const views = new LiveViews(() => {});
  const starts = Array.from({ length: MAX_LIVE_VIEWS }, () => views.start({ port: 9222 }));
  await assert.rejects(views.start({ port: 9222 }), /limit/);
  await tick();
  views.stopAll(); // e.g. the renderer reloaded
  for (const socket of FakeSocket.sockets) socket.open();
  for (const start of starts) await assert.rejects(start, /closed/);
  assert.ok(FakeSocket.sockets.every(socket => socket.readyState === 3), 'late sockets are closed');
  const again = views.start({ port: 9222 });
  await tick(); FakeSocket.sockets.at(-1)!.open();
  assert.ok((await again).sessionId);
  views.stopAll();
}));
