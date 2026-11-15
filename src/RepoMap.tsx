import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, FileCode2, RefreshCw, X, Maximize2, Minimize2 } from 'lucide-react';
import { api } from './api';
import type { FileInspection, GitStatus, RepoFile, RepoSnapshot, Workspace } from './shared';
import { fileKind, kindBadges, reconcileSnapshot, sameGitStatus } from './repo-map-model';
import { RepoMapCanvas } from './RepoMapCanvas';
import { LineCounts } from './LineCounts';
import { CodeView } from './RepoMapCodeView';
import './repo-map.css';

type Props = { workspace: Workspace; onStatus: (status: GitStatus) => void; reveal: { path: string; line: number | null; nonce: number } | null };
export function RepoMap({ workspace, onStatus, reveal }: Props) {
  const [snapshot, setSnapshot] = useState<RepoSnapshot | null>(null);
  const snapshotRef = useRef<RepoSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [changedOnly, setChangedOnly] = useState(false);
  const [selected, setSelected] = useState('');
  const [panel, setPanel] = useState<'file' | null>(null);
  const [mode, setMode] = useState<'diff' | 'file'>('diff');
  const [inspection, setInspection] = useState<FileInspection | null>(null);
  const [fileError, setFileError] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [targetLine, setTargetLine] = useState<number | null>(null);
  const [revealError, setRevealError] = useState('');
  const revealed = useRef<number | null>(null);
  const revealFile = useRef<(file: RepoFile) => void>(() => {});
  const viewport = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(900);
  const [preferredWidth, setPreferredWidth] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const navigateBack = useRef<() => void>(() => {});
  const generation = useRef(0);
  const expandedReader = !!panel && (expanded || bodyWidth < 400);
  const clampWidth = (width: number) => Math.max(210, Math.min(bodyWidth - 180, width));
  const inspectorWidth = clampWidth(preferredWidth ?? bodyWidth * .4);
  useEffect(() => {
    const element = body.current; if (!element) return;
    const observer = new ResizeObserver(() => setBodyWidth(element.clientWidth));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const inFlight = useRef(false);
  const refreshFile = useRef<() => void>(() => {});
  const alive = useRef(false);
  const onStatusRef = useRef(onStatus); onStatusRef.current = onStatus;
  const refresh = useCallback(async (manual = false) => {
    if (inFlight.current || !alive.current) return;
    const foreground = manual || !snapshotRef.current;
    inFlight.current = true; if (foreground) setBusy(true);
    const request = generation.current;
    try {
      const next = await api.repoSnapshot(workspace.id);
      if (alive.current && request === generation.current) {
        const previous = snapshotRef.current;
        const reconciled = reconcileSnapshot(previous, next);
        snapshotRef.current = reconciled;
        if (reconciled !== previous) setSnapshot(reconciled);
        setError('');
        if (!previous || !sameGitStatus(previous, next)) onStatusRef.current(next);
        // File contents can change without changing Git status or line counts.
        // Keep checking the reader, but don't flash loading UI on idle polls.
        refreshFile.current();
      }
    } catch (e) { if (alive.current && request === generation.current) setError((e as Error).message); }
    finally { if (request === generation.current) { inFlight.current = false; if (foreground && alive.current) setBusy(false); } }
  }, [workspace.id]);
  useEffect(() => {
    generation.current++; inFlight.current = false;
    alive.current = true; void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { alive.current = false; generation.current++; window.clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    let running = false;
    setFileError('');
    if (!selected) { setInspection(null); setFileBusy(false); return; }
    const load = async (foreground = false) => {
      if (running) return;
      running = true; if (foreground) setFileBusy(true);
      try {
        const next = await api.inspectFile(workspace.id, selected);
        if (!cancelled) { setInspection(previous => previous?.revision === next.revision ? previous : next); setFileError(''); }
      } catch (e) {
        if (!cancelled) { setInspection(null); setFileError((e as Error).message); }
      } finally { running = false; if (foreground && !cancelled) setFileBusy(false); }
    };
    refreshFile.current = () => { void load(); };
    void load(true);
    return () => { cancelled = true; refreshFile.current = () => {}; };
  }, [workspace.id, selected]);
  const selectedFile = snapshot?.files.find(file => file.path === selected);
  function closeInspector() {
    setPanel(null); setExpanded(false); setSelected(''); setInspection(null);
    viewport.current?.focus({ preventScroll: true });
  }
  const openFile = useCallback((file: RepoFile) => {
    if (selected !== file.path) { setInspection(null); }
    setTargetLine(null); setRevealError('');
    setSelected(file.path); setPanel('file'); setMode(file.status ? 'diff' : 'file');
  }, [selected]);
  useEffect(() => {
    if (!reveal || !snapshot || revealed.current === reveal.nonce) return;
    revealed.current = reveal.nonce;
    const file = snapshot.files.find(file => file.path === reveal.path);
    if (!file) { setRevealError(`File is not in this workspace’s Git inventory: ${reveal.path}`); return; }
    openFile(file); setMode('file'); setTargetLine(reveal.line); revealFile.current(file);
  }, [reveal, snapshot, openFile]);
  const showAll = useCallback(() => setChangedOnly(false), []);
  const hasDiff = !!inspection?.staged || !!inspection?.unstaged;
  return <section className="repo-map-view" aria-label="Repository map" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (query) { setQuery(''); return; } if (expanded) setExpanded(false); else if (panel) closeInspector(); else navigateBack.current(); }
  }}>
    <div className="repo-map-toolbar">
      <div className="map-title"><span className="map-eyebrow">REVIEW YOUR WORKTREE</span><h2>Repo map <span>{snapshot?.changes.length ?? '—'} changes</span></h2></div>
      <label className="map-filter"><input type="checkbox" checked={changedOnly} onChange={e => setChangedOnly(e.target.checked)} /> Only changes</label>
      <button className="icon" aria-label="Refresh repository map" title="Refresh repository map" disabled={busy} onClick={() => void refresh(true)}><RefreshCw size={15} className={busy ? 'spin' : ''} /></button>
    </div>
    {error && <div role="alert" className="inline-error">{error}{snapshot && ' · Showing the last successful map.'}</div>}
    {revealError && <div role="alert" className="inline-error">{revealError}</div>}
    <div ref={body} className={'repo-map-body ' + (expandedReader ? 'reader-expanded' : '')}>
      <RepoMapCanvas snapshot={snapshot} busy={busy} changedOnly={changedOnly} onFile={openFile} viewportRef={viewport} onShowAll={showAll} backRef={navigateBack} revealRef={revealFile} query={query} onQueryChange={setQuery} />
      {panel && !expandedReader && <div className="inspector-divider" role="separator" tabIndex={0} aria-label="Resize inspector" aria-orientation="vertical" aria-valuemin={210} aria-valuemax={Math.max(210, bodyWidth - 180)} aria-valuenow={Math.round(inspectorWidth)}
        onPointerDown={event => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && body.current) setPreferredWidth(clampWidth(body.current.getBoundingClientRect().right - event.clientX)); }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPreferredWidth(clampWidth(inspectorWidth + (event.key === 'ArrowLeft' ? 20 : -20))); } }} />}
      {panel && <aside className="map-inspector" style={{ width: expandedReader ? '100%' : inspectorWidth }} aria-label="Repository inspector">
        <div className="inspector-header"><div className="inspector-title"><FileCode2 size={14} /> File inspector</div><button className="icon" aria-label={expandedReader ? 'Restore inspector' : 'Expand inspector'} title={expandedReader ? 'Restore sidebar' : 'Expand reader'} disabled={bodyWidth < 400} onClick={() => setExpanded(value => !value)}>{expandedReader ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button><button className="icon" aria-label="Close inspector" title="Close inspector · Esc" onClick={closeInspector}><X size={16} /></button></div>
        {!selected ? <div className="map-empty inspector-empty"><FileCode2 size={30} strokeWidth={1.3} /><h3>Follow the changes.</h3><p>Choose a file on the map to inspect its diff or read the full file.</p><span>Read-only · nothing is staged or changed</span></div> : <>
          <div className="inspector-file-heading"><span className={`map-badge ${fileKind(selectedFile?.status || '')}`}>{kindBadges[fileKind(selectedFile?.status || '')]}</span><strong title={selected}>{selected}</strong><LineCounts added={selectedFile?.lines?.added || 0} removed={selectedFile?.lines?.removed || 0} unknown={!selectedFile || (selectedFile.status && selectedFile.lines == null) ? 1 : 0} notice={selectedFile?.lineNotice} /></div>
          {selectedFile?.originalPath && <p className="inspector-rename">Renamed from {selectedFile.originalPath}</p>}
          <div className="inspector-modes" role="tablist" aria-label="File views">{(['diff', 'file'] as const).map(value => <button key={value} role="tab" aria-selected={mode === value} onClick={() => setMode(value)}>{value === 'diff' ? 'Git diff' : 'Whole file'}</button>)}</div>
          {fileError && <div className="inline-error" role="alert">{fileError}</div>}
          {fileBusy && !inspection && <p className="inspector-notice" role="status">Reading file…</p>}
          {inspection && <>
            {inspection.notice && <p className="inspector-notice">{inspection.notice}</p>}
            {mode === 'file' ? <><div className="inspector-source">{inspection.source} · read-only</div>{inspection.content !== null && <CodeView key={`${selected}:${reveal?.nonce}`} content={inspection.content} path={selected} line={targetLine} />}</> : <div className="diff-scroll">{inspection.staged && <><h4 className="diff-label">Staged · HEAD → index</h4><CodeView content={inspection.staged} path={selected} diff /></>}{inspection.unstaged && <><h4 className="diff-label">{selectedFile?.status === '??' || selectedFile?.untrackedReplacement ? 'New untracked file' : 'Unstaged · index → working tree'}</h4><CodeView content={inspection.unstaged} path={selected} diff /></>}{!hasDiff && <div className="map-empty"><Check size={24} /><h3>{inspection.notice ? 'No text diff to display' : 'No content changes'}</h3><p>{inspection.notice ? 'See the notice above for details.' : 'Switch to File to read the current contents.'}</p></div>}</div>}
            <div className="inspector-footer"><span>{fileBusy ? 'Checking for updates…' : 'Read-only inspection'}</span></div>
          </>}
        </>}
      </aside>}
    </div>
  </section>;
}
