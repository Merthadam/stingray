// Clickable live view of a Stingray test instance (scripts/test-env.sh): CDP screencast of its window, forwarded input.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LiveViewEvent, LiveViewInput, LiveViewSession } from '../src/live-view';

export const APP_PAGE = 'file:///app/dist/index.html'; // the test container's renderer; also keeps us off any other CDP endpoint's pages
export const MAX_LIVE_VIEWS = 4;
const targetSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9-]{1,128}$/), type: z.string(), url: z.string().max(8192), title: z.string().max(1000).catch('') });
const frameSchema = z.object({
  sessionId: z.number().int(), data: z.string().max(32 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  metadata: z.object({ deviceWidth: z.number().positive(), deviceHeight: z.number().positive() }),
});
type Metadata = z.infer<typeof frameSchema>['metadata'];
export type LiveViewStartOptions = { port: number; maxWidth?: number; maxHeight?: number };

/** The Stingray window among /json/list entries; entries that fail validation are ignored. */
export function pickTarget(list: unknown) {
  return z.array(z.unknown()).max(1000).parse(list).flatMap(item => { const r = targetSchema.safeParse(item); return r.success ? [r.data] : []; })
    .find(t => t.type === 'page' && t.url.startsWith(APP_PAGE)) ?? null;
}

/** CDP command for a validated input, scaled from frame-normalized to page CSS pixels. */
export function toCdpInput(input: LiveViewInput, metadata: Metadata): [string, Record<string, unknown>] {
  const point = (x: number, y: number) => ({ x: x * metadata.deviceWidth, y: y * metadata.deviceHeight });
  switch (input.type) {
    case 'mouse': return ['Input.dispatchMouseEvent', { type: input.action, ...point(input.x, input.y), button: input.button,
      clickCount: input.clickCount, modifiers: input.modifiers }];
    case 'wheel': return ['Input.dispatchMouseEvent', { type: 'mouseWheel', ...point(input.x, input.y), button: 'none',
      deltaX: input.deltaX, deltaY: input.deltaY, modifiers: input.modifiers }];
    case 'key': return ['Input.dispatchKeyEvent', { type: input.action === 'keyUp' ? 'keyUp' : input.text ? 'keyDown' : 'rawKeyDown',
      key: input.key, code: input.code, windowsVirtualKeyCode: input.keyCode, modifiers: input.modifiers, ...(input.text ? { text: input.text, unmodifiedText: input.text } : {}) }];
    case 'text': return ['Input.insertText', { text: input.text }];
  }
}

type Session = { socket: WebSocket; nextId: number; pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  metadata: Metadata | null; size: { maxWidth?: number; maxHeight?: number }; stopped: boolean; unacked: number[] };
export class LiveViews {
  private sessions = new Map<string, Session>();
  private starting = 0;
  /** Bumped by stopAll() so starts still connecting at that moment are discarded. */
  private generation = 0;
  constructor(private emit: (event: LiveViewEvent) => void) {}
  async start(options: LiveViewStartOptions): Promise<LiveViewSession> {
    if (this.sessions.size + this.starting >= MAX_LIVE_VIEWS) throw new Error(`Close a live view before opening another (limit ${MAX_LIVE_VIEWS}).`);
    this.starting++;
    try { return await this.connect(options, this.generation); } finally { this.starting--; }
  }
  private async connect({ port, ...size }: LiveViewStartOptions, generation: number): Promise<LiveViewSession> {
    let list: unknown;
    try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json(); }
    catch { throw new Error(`No test instance answers on 127.0.0.1:${port}. Is it running?`); }
    const target = pickTarget(list);
    if (!target) throw new Error(`No Stingray window found on 127.0.0.1:${port}.`);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${target.id}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Timed out connecting to the test instance.')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to the test instance.')); }, { once: true });
    });
    if (generation !== this.generation) { socket.close(); throw new Error('The live view was closed.'); }
    const id = randomUUID(), session: Session = { socket, nextId: 1, pending: new Map(), metadata: null, size, stopped: false, unacked: [] };
    this.sessions.set(id, session);
    socket.addEventListener('message', ({ data }) => {
      let message: { id?: number; method?: string; params?: unknown; error?: { message?: string }; result?: unknown };
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.id !== undefined) {
        const call = session.pending.get(message.id); session.pending.delete(message.id);
        if (message.error) call?.reject(new Error(String(message.error.message || 'CDP error'))); else call?.resolve(message.result);
      } else if (message.method === 'Page.screencastFrame') {
        const frame = frameSchema.safeParse(message.params);
        if (!frame.success) return;
        session.metadata = frame.data.metadata;
        // Acked once the renderer displayed it (ack()), so Chrome sends no faster than frames are shown.
        session.unacked.push(frame.data.sessionId);
        this.emit({ sessionId: id, kind: 'frame', data: frame.data.data });
      } else if (message.method === 'Inspector.detached' || message.method === 'Inspector.targetCrashed') socket.close();
    });
    socket.addEventListener('close', () => {
      this.sessions.delete(id);
      for (const call of session.pending.values()) call.reject(new Error('The live view disconnected.'));
      session.pending.clear();
      if (!session.stopped) this.emit({ sessionId: id, kind: 'closed', reason: 'The test instance disconnected.' });
    });
    try { await this.screencast(session); } catch (error) { this.stop(id); throw error; }
    return { sessionId: id, targetUrl: target.url, title: target.title };
  }
  async input(id: string, input: LiveViewInput) {
    const session = this.get(id);
    if (input.type !== 'text' && !session.metadata) return; // no frame yet: nothing was visible to aim at
    const [method, params] = toCdpInput(input, session.metadata!);
    await this.call(session, method, params);
  }
  async resize(id: string, maxWidth: number, maxHeight: number) {
    const session = this.get(id);
    session.size = { maxWidth, maxHeight };
    await this.call(session, 'Page.stopScreencast', {});
    await this.screencast(session);
  }
  /** The renderer displayed the latest frame: release every frame Chrome is waiting on (at most a few). */
  ack(id: string) {
    const session = this.sessions.get(id);
    for (const frame of session?.unacked.splice(0) ?? []) this.call(session!, 'Page.screencastFrameAck', { sessionId: frame }).catch(() => {});
  }
  stop(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.stopped = true; this.sessions.delete(id); session.socket.close();
  }
  stopAll() { this.generation++; for (const id of [...this.sessions.keys()]) this.stop(id); }
  private get(id: string) { const s = this.sessions.get(id); if (!s) throw new Error('This live view is closed. Reconnect.'); return s; }
  private screencast(session: Session) {
    return this.call(session, 'Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1, ...session.size });
  }
  private call(session: Session, method: string, params: Record<string, unknown>) {
    if (session.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('The live view disconnected.'));
    const id = session.nextId++;
    return new Promise((resolve, reject) => { session.pending.set(id, { resolve, reject }); session.socket.send(JSON.stringify({ id, method, params })); });
  }
}
