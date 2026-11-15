// ER diagram for `kind: tables` views: React Flow canvas, ELK layout, filters, inspector and live-update hints.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type NodeChange } from '@xyflow/react';
import { ListFilter, LayoutGrid, Save } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import './er-diagram.css';
import type { DiagramNode, ViewLocalState } from '../views';
import type { ErDiagramProps } from './types';
import { cardSize, handleId, layoutPositions, storedPositions, visibleEdges, visibleNodes, type Positions } from './er-layout';
import { hideIsolated, onlyNeighbours } from './er-filter';
import { describeDiff, diffResults } from './er-diff';
import { sharedElk } from './elk-client';
import { TableNode, type TableFlowNode, type TableNodeData } from './TableNode';
import { Inspector } from './Inspector';
import { TablesPopover } from './TablesPopover';

const nodeTypes = { table: TableNode };
const FADE_MS = 600, FLASH_MS = 1200, LAYOUT_TIMEOUT_MS = 10_000;
const EDGE_COLOR = '#8d7b6c';

export function ErDiagram(props: ErDiagramProps) {
  return <ReactFlowProvider><Diagram {...props} /></ReactFlowProvider>;
}

// Caps match the local-state store's limits; positions of nodes no longer in the result are dropped.
function localState(hidden: string[], positions: Positions, expanded: string[], ids: Set<string>): ViewLocalState {
  return {
    hidden: hidden.slice(0, 2000),
    positions: Object.fromEntries(Object.entries(positions).filter(([id]) => ids.has(id)).slice(0, 1000)),
    expanded: expanded.filter(id => ids.has(id)).slice(0, 500),
  };
}

function Diagram({ result, initialState, onStateChange, onOpenSource, onSaveAs, toolbarExtra }: ErDiagramProps) {
  const flow = useReactFlow<TableFlowNode>();
  const [hidden, setHidden] = useState(initialState.hidden);
  const [expanded, setExpanded] = useState(initialState.expanded);
  const [positions, setPositions] = useState(initialState.positions);
  const [useFilePositions, setUseFilePositions] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [activeField, setActiveField] = useState<{ node: string; field: string } | null>(null);
  const [hops, setHops] = useState(1);
  const [popover, setPopover] = useState(false);
  const [ghosts, setGhosts] = useState<{ node: DiagramNode; position: { x: number; y: number } }[]>([]);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [change, setChange] = useState('');
  const [centreOn, setCentreOn] = useState<string | null>(null);
  const measured = useRef(new Map<string, { width: number; height: number }>());
  const positionsRef = useRef<Positions>({});
  const callbacks = useRef({ onStateChange });
  callbacks.current.onStateChange = onStateChange;

  const ids = useMemo(() => new Set(result.nodes.map(n => n.id)), [result]);
  const byId = useMemo(() => new Map(result.nodes.map(n => [n.id, n])), [result]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  const visible = useMemo(() => visibleNodes(result, hiddenSet), [result, hiddenSet]);
  const stored = useMemo(() => storedPositions(result, positions, useFilePositions), [result, positions, useFilePositions]);
  positionsRef.current = stored; // what is drawn: local positions over the view file's layout
  const shown = useMemo(() => visible.filter(n => stored[n.id]), [visible, stored]);
  const edges = useMemo(() => visibleEdges(result, shown), [result, shown]);
  const state = useMemo(() => localState(hidden, positions, expanded, ids), [hidden, positions, expanded, ids]);

  const firstState = useRef(true);
  useEffect(() => {
    if (firstState.current) { firstState.current = false; return; }
    callbacks.current.onStateChange(state);
  }, [state]);

  // Lay out nodes without a stored position; one ELK run per distinct missing set.
  const missing = useMemo(() => visible.filter(n => !stored[n.id]).map(n => n.id).join('\n'), [visible, stored]);
  const run = useRef({ id: 0, missing: '' });
  useEffect(() => {
    if (!missing || run.current.missing === missing) return;
    const id = ++run.current.id;
    run.current.missing = missing;
    // elk-api never rejects when its worker fails to load, so a timeout makes the grid fallback reachable.
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error('ELK layout timed out')), LAYOUT_TIMEOUT_MS); });
    Promise.race([layoutPositions(sharedElk(), result, hidden, expanded, stored), timeout]).finally(() => window.clearTimeout(timer)).catch(error => {
      console.error('ER layout failed; using a grid', error);
      return Object.fromEntries(visible.map((n, i) => [n.id, stored[n.id] ?? { x: (i % 6) * 320, y: Math.floor(i / 6) * 420 }])) as Positions;
    }).then(next => {
      if (run.current.id !== id) return;
      run.current.missing = '';
      const rounded = Object.fromEntries(Object.entries(next).map(([k, p]) => [k, { x: Math.round(p.x), y: Math.round(p.y) }]));
      setPositions(p => ({ ...p, ...rounded }));
    });
  }, [missing, result, hidden, expanded, stored, visible]);

  // Live updates: flash changed cards, fade removed ones, describe the change in the toolbar.
  const previous = useRef(result);
  useEffect(() => {
    const prev = previous.current;
    previous.current = result;
    if (prev === result) return;
    const d = diffResults(prev, result);
    setChange(describeDiff(d));
    setFlash(new Set(d.changed));
    setGhosts(d.removed.filter(n => positionsRef.current[n.id]).map(n => ({ node: n, position: positionsRef.current[n.id] })));
    const flashTimer = window.setTimeout(() => setFlash(new Set()), FLASH_MS);
    const fadeTimer = window.setTimeout(() => setGhosts([]), FADE_MS);
    return () => { window.clearTimeout(flashTimer); window.clearTimeout(fadeTimer); };
  }, [result]);

  const centre = useCallback((id: string) => {
    const p = positionsRef.current[id], n = byId.get(id);
    if (!p || !n) return;
    const { width, height } = cardSize(n, expandedSet.has(id));
    void flow.setCenter(p.x + width / 2, p.y + height / 2, { zoom: Math.max(flow.getZoom(), 0.8), duration: 300 });
  }, [byId, expandedSet, flow]);
  useEffect(() => {
    if (centreOn && stored[centreOn]) { centre(centreOn); setCentreOn(null); }
  }, [centreOn, stored, centre]);
  const focusTable = useCallback((id: string) => {
    setHidden(h => h.includes(id) ? h.filter(x => x !== id) : h);
    setSelected(id);
    setCentreOn(id);
  }, []);

  const relayout = () => { setPositions({}); setUseFilePositions(false); };
  // Filter re-layouts drop only local positions, so a committed `layout:` in the view file keeps applying.
  const filter = (next: string[], fresh: boolean) => { setHidden(next); if (fresh) setPositions({}); };

  const onToggle = useCallback((id: string) => setExpanded(x => x.includes(id) ? x.filter(e => e !== id) : [...x, id]), []);
  const onField = useCallback((node: string, field: string) =>
    setActiveField(a => a?.node === node && a.field === field ? null : { node, field }), []);

  const dataCache = useRef(new Map<string, TableNodeData>());
  const dataFor = (n: DiagramNode): TableNodeData => {
    const isExpanded = expandedSet.has(n.id);
    const field = activeField?.node === n.id ? activeField.field : null;
    const prev = dataCache.current.get(n.id);
    if (prev && prev.node === n && prev.expanded === isExpanded && prev.activeField === field) return prev;
    const next = { node: n, expanded: isExpanded, activeField: field, onToggle, onField };
    dataCache.current.set(n.id, next);
    return next;
  };

  const lit = useMemo(() => {
    if (!hovered) return null;
    const s = new Set([hovered]);
    for (const e of edges) if (e.from === hovered || e.to === hovered) { s.add(e.from); s.add(e.to); }
    return s;
  }, [hovered, edges]);

  const rfNodes = useMemo<TableFlowNode[]>(() => {
    const cls = (id: string) => ['er-node', lit && (lit.has(id) ? 'er-hl' : 'er-dim'), selected === id && 'er-selected', flash.has(id) && 'er-flash']
      .filter(Boolean).join(' ');
    const node = (n: DiagramNode, position: { x: number; y: number }, className: string, draggable = true): TableFlowNode => ({
      id: n.id, type: 'table', position, data: dataFor(n), className, draggable, ...cardSize(n, expandedSet.has(n.id)),
      measured: measured.current.get(n.id),
    });
    return [
      ...shown.map(n => node(n, stored[n.id], cls(n.id))),
      ...ghosts.filter(g => !ids.has(g.node.id)).map(g => node(g.node, g.position, 'er-node er-removed', false)),
    ];
  }, [shown, stored, ghosts, ids, lit, selected, flash, expandedSet, activeField]); // dataFor reads expandedSet + activeField

  const rfEdges = useMemo<Edge[]>(() => edges.map(e => {
    const fk = e.kind === 'foreign-key';
    const on = hovered ? e.from === hovered || e.to === hovered
      : activeField ? (e.from === activeField.node && e.fromField === activeField.field) || (e.to === activeField.node && e.toField === activeField.field)
      : selected !== null && (e.from === selected || e.to === selected);
    const dim = (hovered !== null || activeField !== null) && !on;
    return {
      id: e.id, source: e.from, target: e.to, type: 'smoothstep',
      sourceHandle: handleId(byId.get(e.from)!, e.fromField, expandedSet.has(e.from), 's'),
      targetHandle: handleId(byId.get(e.to)!, e.toField, expandedSet.has(e.to), 't'),
      label: fk ? undefined : e.label ?? undefined,
      markerEnd: fk ? { type: MarkerType.ArrowClosed, width: 14, height: 14, color: EDGE_COLOR } : undefined,
      className: ['er-edge', fk ? 'fk' : 'rel', (e.style === 'dashed' || !e.certain) && 'dashed', on && 'er-hl', dim && 'er-dim'].filter(Boolean).join(' '),
      selectable: false, focusable: false,
    };
  }), [edges, hovered, activeField, selected, byId, expandedSet]);

  const onNodesChange = useCallback((changes: NodeChange<TableFlowNode>[]) => {
    let moved: Positions | null = null;
    for (const c of changes) {
      if (c.type === 'dimensions' && c.dimensions) measured.current.set(c.id, c.dimensions);
      else if (c.type === 'position' && c.position) (moved ??= {})[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
    }
    if (moved) setPositions(p => ({ ...p, ...moved }));
  }, []);

  const selectedNode = selected !== null && !hiddenSet.has(selected) ? byId.get(selected) : undefined;
  const ready = shown.length > 0 || visible.length === 0;

  return <div className="er-diagram" data-testid="er-diagram" tabIndex={-1} onKeyDown={event => {
    if (event.key !== 'Escape') return;
    if (popover) setPopover(false);
    else { setSelected(null); setActiveField(null); }
  }}>
    <div className="er-toolbar" role="toolbar" aria-label="Diagram">
      <span className="er-count">{visible.length} of {result.nodes.length} tables
        {visible.length < result.nodes.length && <> · <button className="er-link" aria-label="Show all tables" onClick={() => filter([], true)}>Reset</button></>}</span>
      <div className="er-popover-anchor">
        <button aria-label="Choose tables" aria-haspopup="dialog" aria-expanded={popover} onClick={() => setPopover(p => !p)}><ListFilter size={13} />Tables</button>
        {popover && <TablesPopover result={result} hidden={hiddenSet} onHidden={next => filter(next, false)} onFind={id => { focusTable(id); setPopover(false); }} />}
      </div>
      {selectedNode && <div className="er-toolbar-group" aria-label={`Selected table ${selectedNode.label}`}>
        <button aria-label={`Show only ${selectedNode.label} and its neighbours`} onClick={() => filter(onlyNeighbours(result, selectedNode.id, hops), true)}>Only this + neighbours</button>
        <select aria-label="Neighbour distance" value={hops} onChange={e => setHops(Number(e.target.value))}>
          <option value={1}>1 hop</option><option value={2}>2 hops</option>
        </select>
        <button aria-label={`Hide ${selectedNode.label}`} onClick={() => { filter([...hidden, selectedNode.id], false); setSelected(null); }}>Hide</button>
      </div>}
      <button aria-label="Hide tables without relations" onClick={() => filter(hideIsolated(result, hidden), true)}>Hide tables without relations</button>
      <button aria-label="Re-layout the diagram" onClick={relayout}><LayoutGrid size={13} />Re-layout</button>
      <button aria-label="Save as view" onClick={() => onSaveAs({ ...state, positions: Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id))) })}><Save size={13} />Save as view…</button>
      <UpdatedNote at={result.computedAt} change={change} />
      <div className="er-toolbar-extra">{toolbarExtra}</div>
    </div>
    <div className="er-body">
      <div className="er-canvas">
        {!ready ? <p className="er-status">Laying out {visible.length} tables…</p>
          : !result.nodes.length ? <p className="er-status">No tables found in this worktree.</p>
          : <ReactFlow<TableFlowNode> nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
            onNodeClick={(_, n) => { if (ids.has(n.id)) setSelected(n.id); }}
            onNodeMouseEnter={(_, n) => setHovered(n.id)} onNodeMouseLeave={() => setHovered(null)}
            onPaneClick={() => { setSelected(null); setActiveField(null); setPopover(false); }}
            nodesConnectable={false} elementsSelectable={false} colorMode="dark" minZoom={0.1} fitView
            fitViewOptions={{ padding: 0.1, maxZoom: 1 }}>
            <Background gap={20} size={0.8} color="#50413666" />
            <MiniMap pannable zoomable nodeColor="#3a2f27" maskColor="#0e0c0bcc" ariaLabel="Diagram overview" />
            <Controls showInteractive={false} />
          </ReactFlow>}
      </div>
      {selectedNode && <Inspector node={selectedNode} nodes={byId} edges={result.edges} onSelect={focusTable}
        onClose={() => setSelected(null)} onOpenSource={onOpenSource} />}
    </div>
  </div>;
}

function UpdatedNote({ at, change }: { at: number; change: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const s = Math.max(0, Math.round((now - at) / 1000));
  const ago = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  return <span className="er-updated">Updated {ago} ago{change && <span role="status"> · {change}</span>}</span>;
}
