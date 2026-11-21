import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, Globe, ShieldCheck, X, LoaderCircle, Maximize2, Minimize2 } from 'lucide-react';
import type { Workspace } from './shared';
import { urlSchema } from './shared';
import { api } from './api';

type Guest = HTMLElement & { src: string; reload(): void; goBack(): void; goForward(): void; canGoBack(): boolean; canGoForward(): boolean; getURL(): string };
export function BrowserPane({ workspace, onNavigate, onClose, revealRequest = 0, hidden = false, maximized = false, onToggleMaximized }: { workspace: Workspace; onNavigate: (url: string) => Promise<void>; onClose: () => void; revealRequest?: number; hidden?: boolean; maximized?: boolean; onToggleMaximized: () => void }) {
  const [address, setAddress] = useState(workspace.previewUrl);
  const [url, setUrl] = useState(workspace.previewUrl);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [history, setHistory] = useState({ back: false, forward: false });
  const [reload, setReload] = useState(0);
  const pane = useRef<HTMLElement>(null);
  useEffect(() => { if (revealRequest) pane.current?.scrollIntoView({ block: 'nearest' }); }, [revealRequest]);
  const host = useRef<HTMLDivElement>(null);
  const guest = useRef<Guest | null>(null);
  useEffect(() => {
    setAddress(workspace.previewUrl); setUrl(workspace.previewUrl); setError('');
  }, [workspace.previewUrl]);
  useEffect(() => {
    setWaiting(false);
    if (!loading) return;
    const timer = window.setTimeout(() => setWaiting(true), 8000);
    return () => clearTimeout(timer);
  }, [loading]);
  useEffect(() => {
    setLoading(Boolean(url)); setHistory({ back: false, forward: false });
    if (!url || api.mode !== 'desktop' || !host.current) return;
    const view = document.createElement('webview') as Guest;
    view.setAttribute('partition', 'persist:stingray-' + workspace.id);
    view.setAttribute('aria-label', 'Workspace browser preview');
    view.src = url;
    const start = () => { setLoading(true); setError(''); };
    const stop = () => { setLoading(false); setHistory({ back: view.canGoBack(), forward: view.canGoForward() }); setAddress(view.getURL()); };
    const fail = (event: Event) => {
      const e = event as Event & { errorCode: number; isMainFrame: boolean };
      if (e.errorCode !== -3 && e.isMainFrame) { setError('Could not load this page. Check that your development server is running.'); setLoading(false); }
    };
    view.addEventListener('did-start-loading', start);
    view.addEventListener('did-stop-loading', stop);
    view.addEventListener('did-fail-load', fail);
    host.current.append(view); guest.current = view;
    return () => { guest.current = null; view.removeEventListener('did-start-loading', start); view.removeEventListener('did-stop-loading', stop); view.removeEventListener('did-fail-load', fail); view.remove(); };
  }, [url, workspace.id, reload]);
  async function navigate(event: React.FormEvent) {
    event.preventDefault(); setError('');
    const value = address.includes('://') ? address : 'http://' + address;
    if (!urlSchema.safeParse(value).success) { setError('Use an HTTP or HTTPS address without credentials.'); return; }
    try { await onNavigate(value); setAddress(value); setUrl(value); } catch (e) { setError((e as Error).message); }
  }
  return <section ref={pane} className="browser-pane" hidden={hidden} aria-label="Browser preview">
    <form className="browser-toolbar" onSubmit={navigate}>
      <button type="button" className="icon" aria-label="Go back" disabled={!history.back} onClick={() => guest.current?.goBack()}><ArrowLeft size={14} /></button>
      <button type="button" className="icon" aria-label="Go forward" disabled={!history.forward} onClick={() => guest.current?.goForward()}><ArrowRight size={14} /></button>
      <button type="button" className="icon" aria-label="Reload preview" disabled={!url} onClick={() => { setError(''); if (guest.current) guest.current.reload(); else setReload(x => x + 1); }}><RotateCw size={14} /></button>
      <label className="address" title={api.mode === 'desktop' ? 'Workspace-isolated session · permissions and popups blocked' : 'Demo iframe · no desktop privileges'}><Globe size={12} /><input aria-label="Preview URL" placeholder="http://localhost:3000" value={address} onChange={e => setAddress(e.target.value)} /></label>
      <button type="submit" className="icon" aria-label="Load preview">{loading ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />}</button>
      <button type="button" className={'icon ' + (maximized ? 'toggled' : '')} title={(maximized ? 'Restore split view' : 'Maximize preview') + ' · ⌘ ⇧ B'} aria-label={maximized ? 'Restore split view' : 'Maximize preview'} onClick={onToggleMaximized}>{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
      <button type="button" className="icon" title="Close preview · ⌘ B" aria-label="Close preview" onClick={onClose}><X size={14} /></button>
    </form>
    {error && <div className="inline-error" role="alert">{error} Use Reload preview to retry.</div>}
    {loading && !error && <div className="preview-loading" role="status"><LoaderCircle size={12} className="spin" />{waiting ? 'Still waiting for the server… Check its terminal output.' : 'Loading preview…'}</div>}
    {!url ? <div className="preview-empty"><div className="empty-orbit"><Globe size={28} /></div><h2>Your app, right here.</h2><p>Start your dev server in a terminal,<br />then enter its address above.</p><div className="preview-hint"><ShieldCheck size={13} /> Isolated from your terminal and files</div></div>
      : api.mode === 'desktop' ? <div className="guest-host" ref={host} /> : <iframe key={url + reload} title="Browser demo preview" className="demo-frame" src={url} onLoad={() => setLoading(false)} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />}
  </section>;
}
const splitKey = 'stingray.browserSplit';
const clampSplit = (value: number) => Math.min(.8, Math.max(.2, value));
/** Browser width as a fraction of the workspace content, persisted across launches. */
export function useBrowserSplit() {
  const [value, setValue] = useState(() => { try { const v = Number(localStorage.getItem(splitKey)); return v ? clampSplit(v) : .47; } catch { return .47; } });
  useEffect(() => { try { localStorage.setItem(splitKey, String(value)); } catch { /* Split width is optional. */ } }, [value]);
  return [value, (next: number) => setValue(clampSplit(next))] as const;
}
/** Vertical divider between terminals and the browser; the parent toggles `resizing` so webviews stop swallowing the drag. */
export function BrowserSplitter({ value, onChange, onResizing }: { value: number; onChange: (value: number) => void; onResizing: (resizing: boolean) => void }) {
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    onChange((box.right - e.clientX) / box.width);
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => { e.currentTarget.releasePointerCapture(e.pointerId); onResizing(false); };
  return <div className="browser-splitter" role="separator" tabIndex={0} aria-label="Resize browser preview" aria-orientation="vertical" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round((1 - value) * 100)}
    onPointerDown={e => { if (e.button) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); onResizing(true); }} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
    onKeyDown={e => { const step = e.key === 'ArrowLeft' ? .02 : e.key === 'ArrowRight' ? -.02 : 0; if (step) { e.preventDefault(); onChange(value + step); } }} />;
}
