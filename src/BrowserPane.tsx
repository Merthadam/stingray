import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, Globe, ShieldCheck, X, LoaderCircle } from 'lucide-react';
import type { Workspace } from './shared';
import { urlSchema } from './shared';
import { api } from './api';

type Guest = HTMLElement & { src: string; reload(): void; goBack(): void; goForward(): void; canGoBack(): boolean; canGoForward(): boolean; getURL(): string };
export function BrowserPane({ workspace, onNavigate, onClose, revealRequest = 0 }: { workspace: Workspace; onNavigate: (url: string) => Promise<void>; onClose: () => void; revealRequest?: number }) {
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
  return <section ref={pane} className="browser-pane" aria-label="Browser preview">
    <div className="pane-heading"><span><Globe size={14} /> Browser preview</span><button className="icon" title="Close preview" aria-label="Close preview" onClick={onClose}><X size={14} /></button></div>
    <form className="browser-toolbar" onSubmit={navigate}>
      <button type="button" className="icon" aria-label="Go back" disabled={!history.back} onClick={() => guest.current?.goBack()}><ArrowLeft size={14} /></button>
      <button type="button" className="icon" aria-label="Go forward" disabled={!history.forward} onClick={() => guest.current?.goForward()}><ArrowRight size={14} /></button>
      <button type="button" className="icon" aria-label="Reload preview" disabled={!url} onClick={() => { setError(''); if (guest.current) guest.current.reload(); else setReload(x => x + 1); }}><RotateCw size={14} /></button>
      <label className="address"><Globe size={13} /><input aria-label="Preview URL" placeholder="http://localhost:3000" value={address} onChange={e => setAddress(e.target.value)} /></label>
      <button type="submit" className="icon" aria-label="Load preview">{loading ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={14} />}</button>
    </form>
    {error && <div className="inline-error" role="alert">{error} Use Reload preview to retry.</div>}
    {loading && !error && <div className="preview-loading" role="status"><LoaderCircle size={12} className="spin" />{waiting ? 'Still waiting for the server… Check its terminal output.' : 'Loading preview…'}</div>}
    {!url ? <div className="preview-empty"><div className="empty-orbit"><Globe size={28} /></div><h2>Your app, right here.</h2><p>Start your dev server in a terminal,<br />then enter its address above.</p><div className="preview-hint"><ShieldCheck size={13} /> Isolated from your terminal and files</div></div>
      : api.mode === 'desktop' ? <div className="guest-host" ref={host} /> : <iframe key={url + reload} title="Browser demo preview" className="demo-frame" src={url} onLoad={() => setLoading(false)} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />}
    <div className="preview-footer"><ShieldCheck size={12} /><span>{api.mode === 'desktop' ? 'Workspace-isolated session · permissions and popups blocked' : 'Demo iframe · no desktop privileges'}</span></div>
  </section>;
}
