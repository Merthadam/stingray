import { useCallback, useEffect, useRef, useState } from 'react';
import { Database, GanttChart, Network, PanelLeftClose, PanelLeftOpen, RefreshCw, Stethoscope, Table2, TriangleAlert, Workflow, X } from 'lucide-react';
import { api } from './api';
import type { Workspace } from './shared';
import type { ViewKind, ViewLocalState, ViewResult, ViewSummary } from './views';
import { EMPTY_LOCAL_STATE } from './views-ui/types';
import { ErDiagram } from './views-ui/ErDiagram';
import { FlowDiagram } from './views-ui/FlowDiagram';
import { TextViewFallback } from './views-ui/TextViewFallback';
import { DiagnosticsDrawer } from './views-ui/DiagnosticsDrawer';
import { SaveViewDialog } from './views-ui/SaveViewDialog';
import { EditorPicker } from './views-ui/EditorPicker';
import { diagnosticCount, flowchartDepth, pickView } from './views-tab-model';
import './views-tab.css';

const KIND_ICONS: Record<ViewKind, typeof Table2> = { tables: Table2, flow: Workflow, timeline: GanttChart, graph: Network, flowchart: Workflow };
const COLLAPSED_KEY = 'stingray-views-collapsed';
const selectedKey = (workspaceId: string) => `stingray-views-selected:${workspaceId}`;
const SAVE_DELAY = 500;
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ } };

type Loaded = { id: string; result: ViewResult | null; error: string; loading: boolean };

export function ViewsTab({ workspace, onOpenInMap }: { workspace: Workspace; onOpenInMap: (file: string, line: number | null) => void }) {
  const ws = workspace.id;
  const active = useRef(false);
  const [list, setList] = useState<ViewSummary[] | null>(null);
  const [listError, setListError] = useState('');
  const [selected, setSelected] = useState<string | null>(() => read(selectedKey(ws)));
  const [collapsed, setCollapsed] = useState(() => read(COLLAPSED_KEY) === '1');
  const [view, setView] = useState<Loaded | null>(null);
  const [local, setLocal] = useState<{ id: string; state: ViewLocalState; readOnly?: boolean } | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const [saveAs, setSaveAs] = useState<ViewLocalState | null>(null);
  const [actionError, setActionError] = useState('');
  // Flowchart depth overrides by view id: session-only, never written back to the view file.
  const [depths, setDepths] = useState<Record<string, number>>({});
  const depthsRef = useRef(depths); depthsRef.current = depths;
  const listSequence = useRef(0), viewSequence = useRef(0);
  const summary = list?.find(v => v.id === selected) ?? null;
  const current = summary && !summary.error ? summary.id : null; // the view to fetch
  const currentRef = useRef(current); currentRef.current = current;

  const loadList = useCallback(async () => {
    const request = ++listSequence.current;
    try {
      const next = await api.views(ws);
      if (request !== listSequence.current) return;
      setList(next); setListError('');
      setSelected(id => pickView(next, id));
    } catch (e) { if (request === listSequence.current) setListError((e as Error).message); }
  }, [ws]);

  // Keeps the last good result of the same view while refetching; never flashes empty.
  const loadView = useCallback(async (id: string) => {
    const request = ++viewSequence.current;
    setView(v => v?.id === id ? { ...v, loading: true } : { id, result: null, error: '', loading: true });
    try {
      const depth = depthsRef.current[id];
      const result = await api.view(ws, id, depth === undefined ? undefined : { depth });
      if (request === viewSequence.current) setView({ id, result, error: '', loading: false });
    } catch (e) {
      if (request === viewSequence.current) setView(v => ({ id, result: v?.id === id ? v.result : null, error: (e as Error).message, loading: false }));
    }
  }, [ws]);

  useEffect(() => { active.current = true; void loadList(); return () => { active.current = false; }; }, [loadList]);
  useEffect(() => { if (selected) write(selectedKey(ws), selected); }, [ws, selected]);
  useEffect(() => api.onViewsChanged(event => {
    if (event.workspaceId !== ws) return;
    if (event.listChanged) void loadList();
    if (currentRef.current && event.viewIds.includes(currentRef.current)) void loadView(currentRef.current);
  }), [ws, loadList, loadView]);

  // Local state loads alongside the view; the diagram mounts only once both are there.
  useEffect(() => {
    if (!current) { setView(null); return; }
    let live = true;
    setLocal(null);
    void loadView(current);
    // If the stored state can't be read, show defaults but never save over it.
    api.viewState(ws, current).then(state => ({ state: state ?? EMPTY_LOCAL_STATE, readOnly: false }), e => {
      console.warn('Could not load view state:', e); return { state: EMPTY_LOCAL_STATE, readOnly: true };
    }).then(({ state, readOnly }) => { if (live) setLocal({ id: current, state, readOnly }); });
    return () => { live = false; };
  }, [ws, current, loadView]);

  // Debounced persistence of the diagram's local state; flushed on view switch and unmount.
  const pending = useRef<{ id: string; state: ViewLocalState } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const next = pending.current; pending.current = null;
    if (next) api.saveViewState(ws, next.id, next.state).catch(e => console.warn('Could not save view state:', e));
  }, [ws]);
  useEffect(() => flush, [current, flush]);
  useEffect(() => { window.addEventListener('pagehide', flush); return () => window.removeEventListener('pagehide', flush); }, [flush]);
  const readOnlyRef = useRef(false); readOnlyRef.current = !!local?.readOnly;
  const onStateChange = useCallback((state: ViewLocalState) => {
    // Layouts at an overridden depth are not saved: they would misplace the nodes of the file's depth.
    if (!currentRef.current || readOnlyRef.current || depthsRef.current[currentRef.current] !== undefined) return;
    pending.current = { id: currentRef.current, state };
    clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY);
  }, [flush]);
  const onOpenSource = useCallback(async (file: string, line: number | null) => {
    try {
      const settings = await api.editorSettings();
      if (!active.current) return;
      if (settings.selected === 'repo-map') onOpenInMap(file, line);
      else await api.openSource(ws, file, line);
    } catch (e) { setActionError((e as Error).message); }
  }, [ws, onOpenInMap]);

  const toggleCollapsed = () => setCollapsed(v => { write(COLLAPSED_KEY, v ? '0' : '1'); return !v; });
  const result = view?.id === current ? view?.result ?? null : null;
  const loading = !!view?.loading;
  const issues = result ? diagnosticCount(result) : 0;
  const refresh = () => { void loadList(); if (current) void loadView(current); };
  const chartDepth = current ? flowchartDepth(result, depths[current]) : null;
  const changeDepth = (depth: number) => {
    if (!current) return;
    depthsRef.current = { ...depthsRef.current, [current]: depth };
    setDepths(depthsRef.current); void loadView(current);
  };
  const tools = <>
    {chartDepth !== null && <label className="views-depth" title="Call levels expanded inline (this session only)">Depth
      <input type="range" min={0} max={4} step={1} value={chartDepth} aria-label="Flowchart depth" onChange={e => changeDepth(Number(e.target.value))} />
      <span aria-hidden="true">{chartDepth}</span></label>}
    <button className={'views-tool ' + (diagnostics ? 'toggled' : '')} aria-pressed={diagnostics} disabled={!result} onClick={() => setDiagnostics(v => !v)}>
      <Stethoscope size={13} /> Diagnostics{issues > 0 && <span className="views-count" aria-label={`${issues} issues`}>{issues}</span>}</button>
    <button className="icon" aria-label="Refresh view" title="Refresh view" onClick={refresh}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
    <EditorPicker />
  </>;

  const Diagram = result?.kind === 'flow' || result?.kind === 'flowchart' ? FlowDiagram : ErDiagram;
  let main;
  if (!list) main = listError ? <Empty title="Couldn’t list the views" detail={listError} onRetry={() => void loadList()} />
    : <div className="views-empty" role="status"><RefreshCw size={22} className="spin" /><p>Loading views…</p></div>;
  else if (!summary) main = list.length ? <div className="views-empty" role="status"><RefreshCw size={22} className="spin" /></div>
    : <Empty title="No views" detail="This worktree has no views." />;
  else if (summary.error) main = <div className="views-empty views-invalid">
    <TriangleAlert size={28} strokeWidth={1.4} /><h3>{summary.name} can’t be shown</h3>
    {summary.file && <button className="views-source-link" onClick={() => onOpenSource(summary.file!, null)}>{summary.file}</button>}
    <p role="alert" className="views-invalid-error">{summary.error}</p><p className="views-muted">Fix the view file; the list updates when it changes.</p></div>;
  else if (!result) main = view?.error ? <Empty title={`Couldn’t compute ${summary.name}`} detail={view.error} onRetry={() => void loadView(summary.id)} />
    : <div className="views-empty" role="status"><RefreshCw size={22} className="spin" /><p>Computing {summary.name}…</p></div>;
  else main = <>
    {view?.error && <div className="inline-error views-banner" role="alert">{view.error} · Showing the last result.
      <button className="secondary" onClick={() => void loadView(summary.id)}>Retry</button></div>}
    <div className="views-content">
      {result.kind !== 'tables' && result.kind !== 'flow' && result.kind !== 'flowchart' ? <TextViewFallback result={result} toolbar={tools} />
        : local?.id === current ? <div className="views-diagram" data-testid="views-diagram">
          <Diagram key={`${ws}:${current}:${result.diagnostics?.flowchart?.depth ?? ''}`} result={result}
            initialState={depths[current!] === undefined ? local.state : { ...local.state, positions: {} }} onStateChange={onStateChange}
            onOpenSource={onOpenSource} onSaveAs={setSaveAs} toolbarExtra={tools} /></div>
        : <div className="views-empty" role="status"><RefreshCw size={22} className="spin" /></div>}
    </div>
    {diagnostics && <DiagnosticsDrawer result={result} onOpenSource={onOpenSource} onClose={() => setDiagnostics(false)} />}
  </>;

  return <section className="views-tab" aria-label="Views">
    <nav className={'views-list' + (collapsed ? ' collapsed' : '')} aria-label="Views list">
      <div className="views-list-head">{!collapsed && <span>VIEWS</span>}
        <button className="icon" aria-label={collapsed ? 'Expand views list' : 'Collapse views list'} onClick={toggleCollapsed}>
          {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}</button></div>
      {listError && list && !collapsed && <p className="views-list-error" role="alert">{listError}</p>}
      {list?.map(v => {
        const Icon = v.builtin && v.id === 'database' ? Database : KIND_ICONS[v.kind];
        return <button key={v.id} className="views-item" aria-current={v.id === selected ? 'true' : undefined}
          title={v.error ? `${v.name}: ${v.error}` : v.description || v.name} aria-label={v.name + (v.error ? ' (invalid)' : '')}
          onClick={() => { setSelected(v.id); setActionError(''); }}>
          <Icon size={14} />{!collapsed && <span className="views-item-name">{v.name}</span>}
          {v.error && <TriangleAlert size={12} className="views-item-warning" />}
        </button>;
      })}
    </nav>
    <div className="views-main">
      {actionError && <div className="inline-error views-banner" role="alert">{actionError}
        <button className="icon" aria-label="Dismiss" onClick={() => setActionError('')}><X size={13} /></button></div>}
      {main}
    </div>
    {saveAs && result && <SaveViewDialog workspaceId={ws} result={result} state={saveAs} onClose={() => setSaveAs(null)}
      onSaved={saved => { setSaveAs(null); setSelected(saved.id); void loadList(); }} />}
  </section>;
}

function Empty({ title, detail, onRetry }: { title: string; detail: string; onRetry?: () => void }) {
  return <div className="views-empty"><h3>{title}</h3><p role="alert">{detail}</p>
    {onRetry && <button className="secondary" onClick={onRetry}><RefreshCw size={14} /> Retry</button>}</div>;
}
