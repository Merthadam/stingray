import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Check, FileCode2, RefreshCw, X, Maximize2, Minimize2 } from 'lucide-react';
import { api } from './api';
import type { FileInspection, GitStatus, RepoFile, RepoSnapshot, TerminalInfo, Workspace, SnapshotHint } from './shared';
import { fileKind, kindBadges } from './repo-map-model';
import { RepoMapCanvas } from './RepoMapCanvas';
import { LineCounts } from './LineCounts';
import { CodeView } from './RepoMapCodeView';
import './repo-map.css';

type Props = { workspace: Workspace; terminals: TerminalInfo[]; onStatus: (status: GitStatus) => void; onPreview: () => void };
export function RepoMap({ workspace, terminals, onStatus, onPreview }: Props) {
  const [snapshot, setSnapshot] = useState<RepoSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [changedOnly, setChangedOnly] = useState(false);
  const [selected, setSelected] = useState('');
  const [panel, setPanel] = useState<'file' | 'agents' | null>(null);
  const [mode, setMode] = useState<'diff' | 'file' | 'preview'>('diff');
  const [inspection, setInspection] = useState<FileInspection | null>(null);
  const [fileError, setFileError] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [reviewed, setReviewed] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(900);
  const [preferredWidth, setPreferredWidth] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const hint = useRef<SnapshotHint>({});
  const navigateBack = useRef<() => void>(() => {});
  const dismissSearch = useRef<() => boolean>(() => false);
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
  const refresh = useCallback(async () => {
    if (inFlight.current || !alive.current) return;
    inFlight.current = true; setBusy(true);
    const request = generation.current;
    try {
      const requestedHint = hint.current;
      let next: RepoSnapshot;
      try { next = await api.repoSnapshot(workspace.id, requestedHint); }
      catch (e) {
        if (!alive.current || request !== generation.current) return;
        if (!requestedHint.file && !requestedHint.scope) throw e;
        // A selected untracked file/folder can disappear between refreshes.
        // Keep strict service-side hint validation, but retry once without
        // optional priority rather than pinning the UI to stale inventory.
        if (hint.current === requestedHint) hint.current = {};
        next = await api.repoSnapshot(workspace.id);
      }
      if (alive.current && request === generation.current) { setSnapshot(next); setError(''); onStatusRef.current(next); refreshFile.current(); }
    } catch (e) { if (alive.current && request === generation.current) setError((e as Error).message); }
    finally { if (request === generation.current) { inFlight.current = false; if (alive.current) setBusy(false); } }
  }, [workspace.id]);
  const onHint = useCallback((next: SnapshotHint) => { hint.current = next; void refresh(); }, [refresh]);
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
    const load = async () => {
      if (running) return;
      running = true; setFileBusy(true);
      try {
        const next = await api.inspectFile(workspace.id, selected);
        if (!cancelled) { setInspection(next); setFileError(''); }
      } catch (e) {
        if (!cancelled) { setInspection(null); setFileError((e as Error).message); }
      } finally { running = false; if (!cancelled) setFileBusy(false); }
    };
    refreshFile.current = () => { void load(); };
    void load();
    return () => { cancelled = true; refreshFile.current = () => {}; };
  }, [workspace.id, selected]);
  const selectedFile = snapshot?.files.find(file => file.path === selected);
  function closeInspector() {
    setPanel(null); setExpanded(false); setSelected(''); setInspection(null); setReviewed('');
    hint.current = { scope: hint.current.scope };
    viewport.current?.focus({ preventScroll: true });
  }
  function openFile(file: RepoFile) {
    if (selected !== file.path) { setInspection(null); setReviewed(''); }
    setSelected(file.path); setPanel('file'); setMode(file.status ? 'diff' : 'file');
    hint.current = { ...hint.current, file: file.path }; void refresh();
  }
  const hasDiff = !!inspection?.staged || !!inspection?.unstaged;
  return <section className="repo-map-view" aria-label="Repository map" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (dismissSearch.current()) return; if (expanded) setExpanded(false); else if (panel) closeInspector(); else navigateBack.current(); }
  }}>
    <div className="repo-map-toolbar">
      <div className="map-title"><span className="map-eyebrow">REVIEW YOUR WORKTREE</span><h2>Repo map <span>{snapshot?.changes.length ?? '—'} changes</span></h2></div>
      <button className={'icon ' + (panel === 'agents' ? 'toggled' : '')} aria-label="Toggle agent tracker" title="Agent tracker" aria-expanded={panel === 'agents'} onClick={() => panel === 'agents' ? closeInspector() : setPanel('agents')}><Bot size={17} /></button>
      <label className="map-filter"><input type="checkbox" checked={changedOnly} onChange={e => setChangedOnly(e.target.checked)} /> Only changes</label>
      <button className="icon" aria-label="Refresh repository map" title="Refresh repository map" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} className={busy ? 'spin' : ''} /></button>
    </div>
    {error && <div role="alert" className="inline-error">{error}{snapshot && ' · Showing the last successful map.'}</div>}
    <div ref={body} className={'repo-map-body ' + (expandedReader ? 'reader-expanded' : '')}>
      <RepoMapCanvas snapshot={snapshot} busy={busy} changedOnly={changedOnly} onFile={openFile} viewportRef={viewport} onShowAll={() => setChangedOnly(false)} onHint={onHint} backRef={navigateBack} dismissSearchRef={dismissSearch} />
      {panel && !expandedReader && <div className="inspector-divider" role="separator" tabIndex={0} aria-label="Resize inspector" aria-orientation="vertical" aria-valuemin={210} aria-valuemax={Math.max(210, bodyWidth - 180)} aria-valuenow={Math.round(inspectorWidth)}
        onPointerDown={event => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && body.current) setPreferredWidth(clampWidth(body.current.getBoundingClientRect().right - event.clientX)); }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPreferredWidth(clampWidth(inspectorWidth + (event.key === 'ArrowLeft' ? 20 : -20))); } }} />}
      {panel && <aside className="map-inspector" style={{ width: expandedReader ? '100%' : inspectorWidth }} aria-label="Repository inspector">
        <div className="inspector-header"><div className="inspector-switch" role="tablist" aria-label="Inspector views"><button role="tab" aria-selected={panel === 'file'} onClick={() => setPanel('file')}><FileCode2 size={14} /> File inspector</button><button role="tab" aria-selected={panel === 'agents'} onClick={() => setPanel('agents')}><Bot size={15} /> Agent tracker</button></div><button className="icon" aria-label={expandedReader ? 'Restore inspector' : 'Expand inspector'} title={expandedReader ? 'Restore sidebar' : 'Expand reader'} disabled={bodyWidth < 400} onClick={() => setExpanded(value => !value)}>{expandedReader ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button><button className="icon" aria-label="Close inspector" title="Close inspector · Esc" onClick={closeInspector}><X size={16} /></button></div>
        {panel === 'agents' ? <div className="tracker-content"><span className="map-eyebrow">AGENT ACTIVITY</span><h3>No agent integrations connected</h3><p>Structured agent events are not available yet. File reads, edits, parent/subagent relationships and task status cannot be inferred reliably from terminal output.</p><div className="tracker-callout">Git colors show file changes—not who made them.</div><h4>Workspace terminals <span>{terminals.length}</span></h4>{terminals.length ? terminals.map(terminal => <div className="tracker-terminal" key={terminal.id}><span className={terminal.exited ? 'terminal-idle' : 'activity-dot'} /><div>{terminal.title}<small>{terminal.exited ? 'Exited' : 'Shell running'} · agent identity unavailable</small></div></div>) : <p>No terminals in this workspace.</p>}</div> : !selected ? <div className="map-empty inspector-empty"><FileCode2 size={30} strokeWidth={1.3} /><h3>Follow the changes.</h3><p>Choose a file on the map to inspect its diff or read the full file.</p><span>Read-only · nothing is staged or changed</span></div> : <>
          <div className="inspector-file-heading"><span className={`map-badge ${fileKind(selectedFile?.status || '')}`}>{kindBadges[fileKind(selectedFile?.status || '')]}</span><strong title={selected}>{selected}</strong><LineCounts added={selectedFile?.lines?.added || 0} removed={selectedFile?.lines?.removed || 0} unknown={!selectedFile || (selectedFile.status && selectedFile.lines == null) ? 1 : 0} notice={selectedFile?.lineNotice} /></div>
          {selectedFile?.originalPath && <p className="inspector-rename">Renamed from {selectedFile.originalPath}</p>}
          <div className="inspector-modes" role="tablist" aria-label="File views">{(['diff', 'file', 'preview'] as const).map(value => <button key={value} role="tab" aria-selected={mode === value} onClick={() => setMode(value)}>{value === 'diff' ? 'Git diff' : value === 'file' ? 'Whole file' : 'Preview'}</button>)}</div>
          {fileError && <div className="inline-error" role="alert">{fileError}</div>}
          {fileBusy && !inspection && <p className="inspector-notice" role="status">Reading file…</p>}
          {mode === 'preview' ? <div className="map-empty"><FileCode2 size={28} /><h3>No component preview configured</h3><p>A component needs a running preview route or story with its props and providers. Source files aren’t executed automatically.</p><button className="secondary" onClick={onPreview}>Open workspace browser</button><span>This opens the app preview, not an isolated component.</span></div> : inspection && <>
            {inspection.notice && <p className="inspector-notice">{inspection.notice}</p>}
            {mode === 'file' ? <><div className="inspector-source">{inspection.source} · read-only</div>{inspection.content !== null && <CodeView content={inspection.content} />}</> : <div className="diff-scroll">{inspection.staged && <><h4 className="diff-label">Staged · HEAD → index</h4><CodeView content={inspection.staged} diff /></>}{inspection.unstaged && <><h4 className="diff-label">{selectedFile?.status === '??' || selectedFile?.untrackedReplacement ? 'New untracked file' : 'Unstaged · index → working tree'}</h4><CodeView content={inspection.unstaged} diff /></>}{!hasDiff && <div className="map-empty"><Check size={24} /><h3>{inspection.notice ? 'No text diff to display' : 'No content changes'}</h3><p>{inspection.notice ? 'See the notice above for details.' : 'Switch to File to read the current contents.'}</p></div>}</div>}
            <div className="inspector-footer"><span>{fileBusy ? 'Checking for updates…' : 'Read-only inspection'}</span>{inspection.content !== null && !inspection.notice && <button disabled={fileBusy || !!error} onClick={() => setReviewed(reviewed === inspection.revision ? '' : inspection.revision)} aria-pressed={reviewed === inspection.revision}><Check size={13} />{reviewed === inspection.revision ? 'Reviewed' : 'Mark reviewed'}</button>}</div>
          </>}
        </>}
      </aside>}
    </div>
  </section>;
}
