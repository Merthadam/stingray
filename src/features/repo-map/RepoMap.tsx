import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, FileCode2, RefreshCw, X, Maximize2, Minimize2 } from 'lucide-react';
import { api } from '../../app/api';
import type { FileInspection, RepoFile, RepoMapScope, RepoSnapshot } from '../../../shared/contracts/repo-map';
import type { Workspace } from '../../../shared/contracts/git';
import { fileKind, kindBadges, reconcileSnapshot } from './repo-map-model';
import { RepoMapCanvas } from './RepoMapCanvas';
import { LineCounts } from './LineCounts';
import { CodeView } from './RepoMapCodeView';
import { useGitState } from '../git';
import './repo-map.css';

// Snapshot status reads also update the shared Git state (GitService.onStatus); the map reloads when that state's revision moves.
const scopeKey = 'stingray-repo-map-scope-v1';
const scopeLabels: Record<RepoMapScope, string> = { branch: 'Branch', uncommitted: 'Uncommitted' };
const scopeTitles: Record<RepoMapScope, string> = { branch: 'Changes on this branch: working tree vs the merge-base with origin/main, like the sidebar and a PR diff', uncommitted: 'Uncommitted changes: working tree vs HEAD' };
// Nested folder levels drawn at once; deeper levels open with a click (a whole repo nested at once is overwhelming).
const layersKey = 'stingray-repo-map-layers-v1';
const layerOptions = [{ value: 1, label: '1', title: 'Top layer only: folders and files of the focused folder' }, { value: 2, label: '2', title: 'Two layers: each folder shows its contents' },
  { value: Infinity, label: 'All', title: 'All layers that fit' }] as const;
const readLayers = () => { try { const v = localStorage.getItem(layersKey); return v === 'all' ? Infinity : v === '2' ? 2 : 1; } catch { return 1; } };
const untrackedNote = 'untracked files are shown on the map but not counted.';
type Props = { workspace: Workspace; reveal: { path: string; line: number | null; nonce: number } | null };
export function RepoMap({ workspace, reveal }: Props) {
  const [snapshot, setSnapshot] = useState<RepoSnapshot | null>(null);
  const snapshotRef = useRef<RepoSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [changedOnly, setChangedOnly] = useState(false);
  const [scope, setScope] = useState<RepoMapScope>(() => localStorage.getItem(scopeKey) === 'uncommitted' ? 'uncommitted' : 'branch');
  const [layers, setLayers] = useState<number>(readLayers);
  const changeLayers = (next: number) => { setLayers(next); try { localStorage.setItem(layersKey, next === Infinity ? 'all' : String(next)); } catch { /* Optional preference. */ } };
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
  const inFlight = useRef(false), manualQueued = useRef(false);
  const refreshFile = useRef<() => void>(() => {});
  const alive = useRef(false);
  const { state: gitState } = useGitState(workspace.id);
  const latestRevision = useRef(0), loadedRevision = useRef(0);
  latestRevision.current = gitState?.revision ?? 0;
  const fileStamp = useRef('');
  const refresh = useCallback(async (manual = false) => {
    if (!alive.current) return;
    // A click during a background load must not be dropped: that load may predate the edit the user is refreshing for.
    if (inFlight.current) { if (manual) { manualQueued.current = true; setBusy(true); } return; }
    const requested = latestRevision.current;
    const foreground = manual || !snapshotRef.current;
    inFlight.current = true; if (foreground) setBusy(true);
    const request = generation.current;
    try {
      const next = await api.repoSnapshot(workspace.id, scope);
      if (alive.current && request === generation.current) {
        const previous = snapshotRef.current;
        const reconciled = reconcileSnapshot(previous, next);
        snapshotRef.current = reconciled;
        if (reconciled !== previous) setSnapshot(reconciled);
        setError('');
        // File contents can change without changing Git status or line counts.
        // Keep checking the reader, but don't flash loading UI on idle polls.
        refreshFile.current();
      }
    } catch (e) { if (alive.current && request === generation.current) setError((e as Error).message); }
    finally {
      if (request === generation.current) {
        const queued = manualQueued.current; manualQueued.current = false;
        inFlight.current = false; if (foreground && alive.current && !queued) setBusy(false);
        // Settled for `requested` even on failure (a failing map is not retried until the revision moves again).
        loadedRevision.current = Math.max(loadedRevision.current, requested);
        if (alive.current && (queued || latestRevision.current > loadedRevision.current)) queueMicrotask(() => { void refresh(queued); });
      }
    }
  }, [workspace.id, scope]);
  useEffect(() => {
    generation.current++; inFlight.current = false; manualQueued.current = false; loadedRevision.current = 0;
    alive.current = true; void refresh();
    return () => { alive.current = false; generation.current++; };
  }, [refresh]);
  // One clock (audit 12): reload when the shared Git state moved past the snapshot shown; no poll of our own.
  useEffect(() => { if (alive.current && latestRevision.current > loadedRevision.current) void refresh(); }, [gitState?.revision, refresh]);
  useEffect(() => {
    let cancelled = false;
    let running = false;
    setFileError('');
    if (!selected) { setInspection(null); setFileBusy(false); return; }
    const load = async (foreground = false) => {
      if (running) return;
      running = true; if (foreground) setFileBusy(true);
      let stamp = '';
      try {
        stamp = JSON.stringify(await api.statFile(workspace.id, selected).catch(() => null));
        const next = await api.inspectFile(workspace.id, selected, scope);
        if (!cancelled) { fileStamp.current = stamp; setInspection(previous => previous?.revision === next.revision ? previous : next); setFileError(''); }
      } catch (e) {
        // Record the stamp anyway so the 5s stat check retries only after the file changes again.
        if (!cancelled) { fileStamp.current = stamp; setInspection(null); setFileError((e as Error).message); }
      } finally { running = false; if (foreground && !cancelled) setFileBusy(false); }
    };
    refreshFile.current = () => { void load(); };
    void load(true);
    return () => { cancelled = true; refreshFile.current = () => {}; };
  }, [workspace.id, selected, scope]);
  // Same-line edits keep counts and status: a cheap stat of the open file (no git) re-inspects when it changed.
  useEffect(() => {
    if (!selected) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void api.statFile(workspace.id, selected).then(stamp => { if (JSON.stringify(stamp) !== fileStamp.current) refreshFile.current(); }, () => {});
    }, 5000);
    return () => window.clearInterval(timer);
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
  // The other scope's map must not stay on screen under the new label: clear it so the reload is a foreground one.
  function changeScope(next: RepoMapScope) {
    if (next === scope) return;
    localStorage.setItem(scopeKey, next);
    snapshotRef.current = null; setSnapshot(null); setScope(next);
  }
  const hasDiff = !!inspection?.committed || !!inspection?.staged || !!inspection?.unstaged;
  const changedFiles = snapshot?.files.filter(file => file.status).length;
  // Branch totals are the sidebar's (GitStatus.lines); without a merge-base the map compares with HEAD like the sidebar's fallback.
  const branchBase = scope === 'branch' && !!snapshot?.baseCommit;
  const headerLines = snapshot && (branchBase ? snapshot.lines : snapshot.uncommitted);
  const headerTitle = scope === 'uncommitted' ? `Uncommitted tracked changes vs HEAD; ${untrackedNote}` : branchBase
    ? `vs merge-base with origin/main (as of last fetch); ${untrackedNote}`
    : `No local origin/main shares history with this branch, so Branch falls back to uncommitted changes vs HEAD; ${untrackedNote}`;
  return <section className="repo-map-view" aria-label="Repository map" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (query) { setQuery(''); return; } if (expanded) setExpanded(false); else if (panel) closeInspector(); else navigateBack.current(); }
  }}>
    <div className="repo-map-toolbar">
      <div className="map-title"><span className="map-eyebrow">REVIEW YOUR WORKTREE</span><h2>Repo map <span title={headerTitle}><span className="map-change-count">{changedFiles ?? '—'} changed files</span>{headerLines && (headerLines.kind === 'available'
        ? <LineCounts added={headerLines.added} removed={headerLines.deleted} notice={headerTitle} />
        : <LineCounts added={0} removed={0} unknown={1} notice={headerLines.message} />)}{snapshot && scope === 'branch' && !branchBase && <small className="map-scope-fallback">vs HEAD · no origin/main</small>}</span></h2></div>
      <div className="map-scope" role="radiogroup" aria-label="Compare the map against">{(['branch', 'uncommitted'] as const).map(value =>
        <button key={value} role="radio" aria-checked={scope === value} title={scopeTitles[value]} onClick={() => changeScope(value)}>{scopeLabels[value]}</button>)}</div>
      <div className="map-scope map-layers" role="radiogroup" aria-label="Map layers"><span aria-hidden="true">Layers</span>{layerOptions.map(option =>
        <button key={option.label} role="radio" aria-checked={layers === option.value} aria-label={`${option.label === 'All' ? 'All' : option.label} ${option.value === 1 ? 'layer' : 'layers'}`} title={option.title} onClick={() => changeLayers(option.value)}>{option.label}</button>)}</div>
      <label className="map-filter"><input type="checkbox" checked={changedOnly} onChange={e => setChangedOnly(e.target.checked)} /> Only changes</label>
      <button className="icon" aria-label="Refresh repository map" title="Refresh repository map" disabled={busy} onClick={() => void refresh(true)}><RefreshCw size={15} className={busy ? 'spin' : ''} /></button>
    </div>
    {error && <div role="alert" className="inline-error">{error}{snapshot && ' · Showing the last successful map.'}</div>}
    {revealError && <div role="alert" className="inline-error">{revealError}</div>}
    <div ref={body} className={'repo-map-body ' + (expandedReader ? 'reader-expanded' : '')}>
      <RepoMapCanvas snapshot={snapshot} scope={scope} layers={layers} busy={busy} changedOnly={changedOnly} onFile={openFile} viewportRef={viewport} onShowAll={showAll} backRef={navigateBack} revealRef={revealFile} query={query} onQueryChange={setQuery} />
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
            {mode === 'file' ? <><div className="inspector-source">{inspection.source} · read-only</div>{inspection.content !== null && <CodeView key={`${selected}:${reveal?.nonce}`} content={inspection.content} path={selected} line={targetLine} />}</> : <div className="diff-scroll">{inspection.committed && <><h4 className="diff-label">Committed · origin/main → HEAD</h4><CodeView content={inspection.committed} path={selected} diff /></>}{inspection.staged && <><h4 className="diff-label">Staged · HEAD → index</h4><CodeView content={inspection.staged} path={selected} diff /></>}{inspection.unstaged && <><h4 className="diff-label">{selectedFile?.status === '??' || selectedFile?.untrackedReplacement ? 'New untracked file' : 'Unstaged · index → working tree'}</h4><CodeView content={inspection.unstaged} path={selected} diff /></>}{!hasDiff && <div className="map-empty"><Check size={24} /><h3>{inspection.notice ? 'No text diff to display' : 'No content changes'}</h3><p>{inspection.notice ? 'See the notice above for details.' : 'Switch to File to read the current contents.'}</p></div>}</div>}
            <div className="inspector-footer"><span>{fileBusy ? 'Checking for updates…' : 'Read-only inspection'}</span></div>
          </>}
        </>}
      </aside>}
    </div>
  </section>;
}
