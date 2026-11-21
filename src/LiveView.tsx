import { useEffect, useRef, useState } from 'react';
import { MonitorPlay, RotateCw, X } from 'lucide-react';
import { api } from './api';
import type { LiveViewTarget } from './shared';
import { framePoint, keyInput, modifierBits, type LiveViewEvent, type LiveViewInput, type LiveViewSession } from './live-view';
import './live-view.css';

const BUTTONS = ['left', 'middle', 'right'] as const;
const frameSize = (el: HTMLElement | null) => {
  const clamp = (n: number) => Math.min(8192, Math.max(16, Math.round(n * devicePixelRatio)));
  return el ? { maxWidth: clamp(el.clientWidth), maxHeight: clamp(el.clientHeight) } : {};
};
/** Clickable screencast of a test instance's Stingray window; captures mouse, wheel and keyboard while focused. */
export function LiveView({ target, onClose }: { target: LiveViewTarget; onClose: () => void }) {
  const [status, setStatus] = useState<'connecting' | 'live' | 'disconnected'>('connecting');
  const [error, setError] = useState('');
  const [session, setSession] = useState<LiveViewSession | null>(null);
  const [attempt, setAttempt] = useState(0);
  const surface = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const sessionId = useRef('');
  const moving = useRef(false);
  useEffect(() => {
    let cancelled = false, early: LiveViewEvent | null = null;
    setStatus('connecting'); setError(''); setSession(null);
    const show = (event: LiveViewEvent) => {
      if (event.kind === 'frame') { if (image.current) image.current.src = 'data:image/jpeg;base64,' + event.data; setStatus('live'); }
      else { sessionId.current = ''; setStatus('disconnected'); setError(event.reason); }
    };
    // The first frame can arrive before liveViewStart resolves; keep the latest one until the session id is known.
    const off = api.onLiveView(event => { if (event.sessionId === sessionId.current) show(event); else if (!sessionId.current) early = event; });
    api.liveViewStart({ port: target.port, ...frameSize(surface.current) }).then(started => {
      if (cancelled) { void api.liveViewStop(started.sessionId); return; }
      sessionId.current = started.sessionId; setSession(started);
      if (early?.sessionId === started.sessionId) show(early); else ack(); // a missed early frame must not stall the stream
    }, e => { if (!cancelled) { setStatus('disconnected'); setError((e as Error).message); } });
    return () => { cancelled = true; off(); if (sessionId.current) void api.liveViewStop(sessionId.current); sessionId.current = ''; };
  }, [target.port, attempt]);
  useEffect(() => {
    let timer = 0;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const size = frameSize(surface.current);
        if (sessionId.current && size.maxWidth) api.liveViewResize(sessionId.current, size.maxWidth, size.maxHeight).catch(() => {});
      }, 250);
    });
    if (surface.current) observer.observe(surface.current);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, []);
  const ack = () => { if (sessionId.current) api.liveViewAck(sessionId.current).catch(() => {}); };
  const send = (input: LiveViewInput) => sessionId.current ? api.liveViewInput(sessionId.current, input).catch(e => setError((e as Error).message)) : Promise.resolve();
  const point = (e: React.MouseEvent) => {
    const img = image.current;
    return img ? framePoint(e.clientX, e.clientY, img.getBoundingClientRect(), { width: img.naturalWidth, height: img.naturalHeight }) : null;
  };
  const mouse = (action: 'mousePressed' | 'mouseReleased', e: React.MouseEvent) => {
    const p = point(e);
    if (p) void send({ type: 'mouse', action, ...p, button: BUTTONS[e.button] ?? 'none', clickCount: Math.min(3, Math.max(1, e.detail)), modifiers: modifierBits(e) });
  };
  const key = (action: 'keyDown' | 'keyUp', e: React.KeyboardEvent) => {
    e.stopPropagation(); // keep Stingray's own shortcuts (⌘K, ⌘T…) out of the remote session
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return; // let the paste event carry the clipboard text
    e.preventDefault();
    const input = keyInput(action, e);
    if (input) void send(input);
  };
  const label = { connecting: 'Connecting…', live: 'Live', disconnected: 'Disconnected' }[status];
  return <section className="live-view" aria-label="Live view">
    <div className="live-view-bar">
      <span className={'live-view-status ' + status} role="status"><MonitorPlay size={13} />{label}</span>
      <span className="live-view-url" title={session?.targetUrl || target.url}>{session?.targetUrl || target.url} · 127.0.0.1:{target.port}</span>
      {status === 'disconnected' && <button className="secondary" onClick={() => setAttempt(n => n + 1)}><RotateCw size={13} /> Reconnect</button>}
      <button className="icon" aria-label="Close live view" title="Close live view" onClick={onClose}><X size={14} /></button>
    </div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div ref={surface} className="live-view-surface" tabIndex={0} aria-label="Remote Stingray window. Click to focus; keyboard and mouse go to the test instance."
      onMouseDown={e => { surface.current?.focus(); e.preventDefault(); mouse('mousePressed', e); }}
      onMouseUp={e => mouse('mouseReleased', e)}
      onMouseMove={e => {
        const p = point(e);
        if (!p || moving.current) return; // drop moves while one is in flight
        moving.current = true;
        void send({ type: 'mouse', action: 'mouseMoved', ...p, button: e.buttons & 1 ? 'left' : 'none', clickCount: 0, modifiers: modifierBits(e) }).finally(() => { moving.current = false; });
      }}
      onWheel={e => { const p = point(e), scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        if (p) void send({ type: 'wheel', ...p, deltaX: Math.max(-1e4, Math.min(1e4, e.deltaX * scale)), deltaY: Math.max(-1e4, Math.min(1e4, e.deltaY * scale)), modifiers: modifierBits(e) }); }}
      onKeyDown={e => key('keyDown', e)} onKeyUp={e => key('keyUp', e)}
      onPaste={e => { e.preventDefault(); const text = e.clipboardData.getData('text/plain').slice(0, 10_000); if (text) void send({ type: 'text', text }); }}
      onContextMenu={e => e.preventDefault()}>
      <img ref={image} alt="" draggable={false} onLoad={ack} onError={ack} />
    </div>
  </section>;
}
