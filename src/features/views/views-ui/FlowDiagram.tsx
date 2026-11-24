import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeChange } from '@xyflow/react';
import { ChevronDown, ExternalLink, LayoutGrid, ListTree, Save, X } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import './er-diagram.css';
import './flow-diagram.css';
import type { ErDiagramProps } from './types';
import type { DiagramGroup, DiagramNode, ViewLocalState } from '../../../../shared/contracts/views';
import type { Positions } from './er-layout';
import { sharedElk } from './elk-client';
import { summarizeFlowchart } from '../../../../shared/views/flowchart-summary';
import { undescribed } from '../../../../shared/views/undescribed';
import { bandEntry, cardTitle, edgeLabel, flowFrames, flowGrid, frameIndex, flowPositions, flowSize } from './flow-layout';
import { FlowGroup, FlowNode, FlowchartNode, StaleMark, ExplanationReason } from './FlowNode';
import { FlowEdge, type FlowTransition } from './FlowEdge';
import { Inspector } from './Inspector';
import { DescribeEditor } from './DescribeEditor';

const nodeTypes = { step: FlowNode, chart: FlowchartNode, frame: FlowGroup };
const edgeTypes = { transition: FlowEdge };
const EDGE_COLOR = '#a28b78';
type Selection = { kind: 'node' | 'edge' | 'group'; id: string } | null;
const DESCRIBABLE = new Set(['decision', 'loop', 'call', 'action', 'start']); // flowchart steps "Describe…" offers; other views: every step but pills

export function FlowDiagram(props: ErDiagramProps) {
  return <ReactFlowProvider><Diagram {...props} /></ReactFlowProvider>;
}

type Point = { x: number; y: number };

function Diagram({ result: full, initialState, onStateChange, onOpenSource, onOpenServiceDocs, onSaveAs, saveAsDisabled, onToggleCall, onSaveExplanation, saveExplanationDisabled, toolbarExtra }: ErDiagramProps) {
  const flow = useReactFlow();
  const chart = full.kind === 'flowchart';
  // Flowcharts open as a summary (shared/views/flowchart-summary.ts): undescribed library steps hidden, guards folded into
  // "can fail" badges. "All steps" in the toolbar shows everything; a frame's switch shows one function's steps.
  const [allSteps, setAllSteps] = useState(false);
  const [fullGroups, setFullGroups] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { setFullGroups(new Set()); }, [full.id]);
  const summary = useMemo(() => summarizeFlowchart(full, { allStepsIn: fullGroups }), [full, fullGroups]);
  const result = allSteps ? full : summary.result;
  const touched = useMemo(() => new Set([...summarizeFlowchart(full).touched, ...fullGroups]), [full, fullGroups]);
  const toggleGroup = useCallback((id: string) => setFullGroups(g => { const next = new Set(g); if (!next.delete(id)) next.add(id); return next; }), []);
  const size = useCallback((n: DiagramNode) => flowSize(n, chart), [chart]);
  const [positions, setPositions] = useState<Positions>(() => ({ ...result.layout?.positions, ...initialState.positions }));
  const [selected, setSelected] = useState<Selection>(null);
  const [revision, setRevision] = useState(0);
  const [gridded, setGridded] = useState(false);
  const [ready, setReady] = useState(false);
  const [laidOut, setLaidOut] = useState<object | null>(null); // the result `positions` were laid out for
  // A call opened or closed here: after the new result is laid out, the frame (opened) or call card (closed) that replaces
  // the clicked one is moved under the same screen point.
  const anchor = useRef<{ path: string; open: boolean; at: Point; from: object } | null>(null);
  const positionsRef = useRef(positions); positionsRef.current = positions;
  // Rebuilt nodes keep their measured size: without it React Flow drops their handles, so edges and frames blink out until re-measured.
  const measured = useRef(new Map<string, { width: number; height: number }>());
  const stateCallback = useRef(onStateChange); stateCallback.current = onStateChange;
  const userMoved = useRef(false); // only a drag or Re-layout persists positions
  const byId = useMemo(() => new Map(result.nodes.map(n => [n.id, n])), [result]);
  const state = useMemo<ViewLocalState>(() => ({ hidden: [], expanded: [],
    positions: Object.fromEntries(Object.entries(positions).filter(([id]) => byId.has(id)).slice(0, 1000)),
  }), [positions, byId]);

  useEffect(() => { if (ready && userMoved.current) stateCallback.current(state); }, [state, ready]);
  useEffect(() => {
    let live = true, timer = 0;
    setGridded(false);
    // elk-api never rejects when its worker fails to load, so a timeout makes the grid fallback reachable.
    const timeout = new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error('Flow layout timed out')), 10_000); });
    Promise.race([flowPositions(sharedElk(), result), timeout]).finally(() => window.clearTimeout(timer)).catch(error => {
      console.error('Flow layout failed; using a grid', error);
      if (live) setGridded(true);
      return flowGrid(result);
    }).then(next => {
      if (!live) return;
      // Flowchart ids are kind@line: after a code edit other nodes take the old ids, so stored positions are kept only
      // when they are for exactly these nodes.
      const fixed = !chart || (Object.keys(positionsRef.current).length === result.nodes.length && result.nodes.every(n => positionsRef.current[n.id]))
        ? positionsRef.current : {};
      setPositions(Object.fromEntries(result.nodes.map(n => [n.id, fixed[n.id] ?? next[n.id]])));
      setLaidOut(result);
      setReady(true);
    });
    return () => { live = false; window.clearTimeout(timer); };
  }, [result, revision, chart]);

  const frames = useMemo(() => flowFrames(result, positions), [result, positions]);
  const framesBy = useMemo(() => frameIndex(result, frames), [result, frames]);
  const toggleCall = useCallback((path: string, open: boolean, at: Point | undefined) => {
    anchor.current = at ? { path, open, at, from: result } : null;
    onToggleCall?.(path, open);
  }, [onToggleCall, result]);
  useEffect(() => {
    const a = anchor.current;
    if (!a || laidOut !== result || result === a.from) return;
    anchor.current = null;
    const frame = a.open ? frames.find(f => f.group.callPath === a.path) : undefined;
    const p = frame ?? (a.open ? undefined : positions[result.nodes.find(n => n.callPath === a.path)?.id ?? '']);
    if (!p) return;
    const { x, y, zoom } = flow.getViewport();
    void flow.setViewport({ x: x + (a.at.x - p.x) * zoom, y: y + (a.at.y - p.y) * zoom, zoom });
  }, [laidOut, result, frames, positions, flow]);
  const expandCall = (n: DiagramNode) => chart && onToggleCall && n.expandable && n.callPath ? () => toggleCall(n.callPath!, true, positions[n.id]) : undefined;
  const collapseCall = (g: DiagramGroup) => chart && onToggleCall && g.callPath
    ? () => { const f = frames.find(x => x.group.id === g.id); toggleCall(g.callPath!, false, f && { x: f.x, y: f.y }); } : undefined;
  const nodes = useMemo<Node[]>(() => [
    ...frames.map((f, i) => ({ id: `flow-frame:${i}`, type: 'frame', position: { x: f.x, y: f.y },
      data: { label: f.group.label, file: chart ? undefined : f.group.source?.file, provider: f.group.provider, explanation: f.group.explanation, explanationStatus: f.group.explanationStatus, explanationReason: f.group.explanationReason, onExplain: () => setSelected({ kind: 'group', id: f.group.id }),
        onSelect: chart ? undefined : () => setSelected({ kind: 'group', id: f.group.id }), onOpen: chart && f.group.source ? () => onOpenSource(f.group.source!.file, f.group.source!.line) : undefined,
        steps: chart && !allSteps && touched.has(f.group.id) ? { all: fullGroups.has(f.group.id), toggle: () => toggleGroup(f.group.id) } : undefined, onCollapse: collapseCall(f.group) }, style: { width: f.width, height: f.height }, className: f.group.provider ? `flow-frame cloud ${f.group.provider}` : 'flow-frame',
      draggable: false, selectable: false, focusable: false, zIndex: -1, measured: measured.current.get(`flow-frame:${i}`),
    })),
    ...result.nodes.filter(n => positions[n.id]).map(n => ({
      id: n.id, type: chart ? 'chart' : 'step', position: positions[n.id], data: { node: n, todo: undescribed(n, result.kind), onExpand: expandCall(n) }, ...size(n), measured: measured.current.get(n.id),
      ariaLabel: chart ? `${n.kind} ${n.label}` : n.service ? `${n.service.name} ${n.label}` : `${n.role ? n.role : 'Step'} ${cardTitle(n)}`, selected: selected?.kind === 'node' && selected.id === n.id,
    })),
  ], [result, positions, frames, selected, chart, size, onOpenSource, allSteps, touched, fullGroups, toggleGroup, toggleCall]);
  const edges = useMemo<FlowTransition[]>(() => {
    const lanes = new Map<string, number>();
    return result.edges.filter(e => positions[e.from] && positions[e.to]).map(e => {
      const source = byId.get(e.from)!, target = byId.get(e.to)!;
      const returning = positions[e.to].y <= positions[e.from].y + size(source).height;
      const frame = source.group ? framesBy.byGroup.get(source.group) : undefined;
      const key = source.group ?? e.from, lane = lanes.get(key) ?? 0;
      if (returning) lanes.set(key, lane + 1);
      const right = Math.max(frame ? frame.x + frame.width - 60 : 0,
        positions[e.from].x + size(source).width, positions[e.to].x + size(target).width);
      return {
        id: e.id, source: e.from, target: e.to, type: 'transition', label: edgeLabel(e) ?? undefined,
        sourceHandle: returning ? 'return-out' : 'out', targetHandle: returning ? 'return-in' : 'in',
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR, width: 16, height: 16 },
        selected: selected?.kind === 'edge' && selected.id === e.id,
        className: `flow-edge${e.style === 'dashed' || e.kind === 'branch' || !e.certain ? ' dashed' : ''}`,
        ariaLabel: `${source.label} to ${target.label}${e.label ? `: ${e.label}` : ''}`,
        data: { returnX: returning ? right + 30 + lane * 24 : undefined,
          entry: returning ? undefined : bandEntry(result, framesBy, positions, source, target), onSelect: () => setSelected({ kind: 'edge', id: e.id }) },
      };
    });
  }, [result, positions, byId, framesBy, selected, size]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const moved: Positions = {};
    for (const c of changes) {
      if (c.type === 'position' && c.dragging === false) userMoved.current = true;
      if (c.type === 'dimensions' && c.dimensions) measured.current.set(c.id, c.dimensions);
      else if (c.type === 'position' && c.position && byId.has(c.id)) moved[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
    }
    if (Object.keys(moved).length) setPositions(p => ({ ...p, ...moved }));
  }, [byId]);
  const focusNode = (id: string) => {
    setSelected({ kind: 'node', id });
    const p = positions[id], n = byId.get(id);
    if (p && n) void flow.setCenter(p.x + size(n).width / 2, p.y + size(n).height / 2, { zoom: Math.max(flow.getZoom(), 0.8), duration: 250 });
  };
  const describe = (id: string) => ({ onSave: onSaveExplanation && ((text: string) => onSaveExplanation(id, text)), disabled: saveExplanationDisabled });
  const node = selected?.kind === 'node' ? byId.get(selected.id) : undefined;
  const edge = selected?.kind === 'edge' ? result.edges.find(e => e.id === selected.id) : undefined;
  const group = selected?.kind === 'group' ? result.groups.find(g => g.id === selected.id) : undefined;
  return <div className="er-diagram flow-diagram" data-testid="flow-diagram" onKeyDown={e => { if (e.key === 'Escape') setSelected(null); }}>
    <div className="er-toolbar" role="toolbar" aria-label="Diagram">
      <span className="er-count">{result.nodes.length} nodes · {result.edges.length} transitions{gridded && ' · automatic layout failed, showing a grid'}</span>
      {chart && (allSteps || summary.hidden + summary.folded > 0) && <button aria-pressed={allSteps} onClick={() => { setAllSteps(a => !a); setSelected(null); }}
        aria-label={allSteps ? 'Show the summary' : 'Show all steps'}
        title={allSteps ? 'Hide undescribed library steps and fold guards into “can fail”' : `${summary.hidden} undescribed step${summary.hidden === 1 ? '' : 's'} hidden, ${summary.folded} guard${summary.folded === 1 ? '' : 's'} folded`}>
        <ListTree size={13} />{allSteps ? 'Summary' : `All steps (+${summary.hidden + summary.folded})`}</button>}
      <button aria-label="Re-layout the diagram" onClick={() => { userMoved.current = true; positionsRef.current = {}; setPositions({}); setReady(false); setRevision(r => r + 1); }}><LayoutGrid size={13} />Re-layout</button>
      <button aria-label="Save as view" disabled={!ready || !onSaveAs}
        title={onSaveAs ? undefined : saveAsDisabled ?? 'Set the depth back to the view’s own to save it'} onClick={() => onSaveAs?.(state)}><Save size={13} />Save as view…</button>
      <div className="er-toolbar-extra">{toolbarExtra}</div>
    </div>
    <div className="er-body">
      <div className="er-canvas">
        {!result.nodes.length ? <p className="er-status">No steps found in this worktree.</p>
          : !ready ? <p className="er-status">Laying out {result.nodes.length} nodes…</p>
          : <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange}
            onNodeClick={(_, n) => { if (byId.has(n.id)) setSelected({ kind: 'node', id: n.id }); }}
            onEdgeClick={(_, e) => setSelected({ kind: 'edge', id: e.id })} onPaneClick={() => setSelected(null)}
            nodesConnectable={false} deleteKeyCode={null} colorMode="dark" minZoom={0.1} fitView fitViewOptions={{ padding: 0.12, maxZoom: 1 }}>
            <Background gap={20} size={0.8} color="#50413666" />
            <MiniMap pannable zoomable nodeColor="#3a2f27" maskColor="#0e0c0bcc" ariaLabel="Diagram overview" />
            <Controls showInteractive={false} />
          </ReactFlow>}
      </div>
      {node && <Inspector variant="flow" node={node} nodes={byId} edges={result.edges} onSelect={focusNode} onExpand={expandCall(node)}
        describe={chart ? DESCRIBABLE.has(node.kind) ? describe(node.id) : undefined : node.role ? undefined : describe(node.id)} onClose={() => setSelected(null)} onOpenSource={onOpenSource} onOpenServiceDocs={onOpenServiceDocs} />}
      {edge && <aside className="er-inspector" aria-label="Transition details">
        <header><div><strong>{byId.get(edge.from)?.label} → {byId.get(edge.to)?.label}</strong>
          <span>{edge.kind}{!edge.certain && ' · uncertain'}</span></div>
          <button className="icon" aria-label="Close inspector" onClick={() => setSelected(null)}><X size={14} /></button></header>
        {edge.label && <p className="flow-inspector-detail">{edge.label}</p>}
        {edge.source && <div className="er-inspector-source"><code title={`${edge.source.file}:${edge.source.line}`}>{edge.source.file}:{edge.source.line}</code>
          <button aria-label="Open transition in editor" onClick={() => onOpenSource(edge.source!.file, edge.source!.line)}><ExternalLink size={12} />Open in editor</button></div>}
        <h4>Steps</h4>
        {[edge.from, edge.to].map((id, i) => <button key={i} className="er-relation" onClick={() => focusNode(id)}>{i === 0 ? 'From' : 'To'}: {byId.get(id)?.label}</button>)}
      </aside>}
      {group && <aside className="er-inspector" aria-label={`${chart ? 'Function' : 'Group'} ${group.label}`}>
        <header><div><strong>{group.label}</strong><span>{chart ? 'expanded call' : 'group'}</span></div>
          <button className="icon" aria-label="Close inspector" onClick={() => setSelected(null)}><X size={14} /></button></header>
        {group.source && <div className="er-inspector-source"><code title={`${group.source.file}:${group.source.line}`}>{group.source.file}:{group.source.line}</code>
          <button aria-label={`Open ${chart ? 'function' : 'group'} in editor`} onClick={() => onOpenSource(group.source!.file, group.source!.line)}><ExternalLink size={12} />Open in editor</button></div>}
        {group.explanation && <p className="flow-inspector-explanation"><StaleMark status={group.explanationStatus} />{group.explanation}</p>}
        {group.explanation && <ExplanationReason status={group.explanationStatus} reason={group.explanationReason} />}
        <DescribeEditor key={group.id} target={group} decision={false} {...describe(group.id)} />
        {collapseCall(group) && <div className="flow-inspector-actions"><button title="Close this call back into one step" onClick={collapseCall(group)}>
          <ChevronDown size={12} />Collapse</button></div>}
      </aside>}
    </div>
  </div>;
}
