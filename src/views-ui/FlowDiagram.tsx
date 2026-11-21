import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeChange } from '@xyflow/react';
import { ExternalLink, LayoutGrid, Save, X } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import './er-diagram.css';
import './flow-diagram.css';
import type { ErDiagramProps } from './types';
import type { DiagramNode, ViewLocalState } from '../views';
import type { Positions } from './er-layout';
import { sharedElk } from './elk-client';
import { bandEntry, flowFrames, frameIndex, flowPositions, flowSize } from './flow-layout';
import { FlowGroup, FlowNode, FlowchartNode } from './FlowNode';
import { FlowEdge, type FlowTransition } from './FlowEdge';
import { Inspector } from './Inspector';

const nodeTypes = { step: FlowNode, chart: FlowchartNode, frame: FlowGroup };
const edgeTypes = { transition: FlowEdge };
const EDGE_COLOR = '#a28b78';
type Selection = { kind: 'node' | 'edge' | 'group'; id: string } | null;

export function FlowDiagram(props: ErDiagramProps) {
  return <ReactFlowProvider><Diagram {...props} /></ReactFlowProvider>;
}

function Diagram({ result, initialState, onStateChange, onOpenSource, onSaveAs, toolbarExtra }: ErDiagramProps) {
  const flow = useReactFlow();
  const chart = result.kind === 'flowchart';
  const size = useCallback((n: DiagramNode) => flowSize(n, chart), [chart]);
  const [positions, setPositions] = useState<Positions>(() => ({ ...result.layout?.positions, ...initialState.positions }));
  const [selected, setSelected] = useState<Selection>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const positionsRef = useRef(positions); positionsRef.current = positions;
  const stateCallback = useRef(onStateChange); stateCallback.current = onStateChange;
  const byId = useMemo(() => new Map(result.nodes.map(n => [n.id, n])), [result]);
  const state = useMemo<ViewLocalState>(() => ({ hidden: [], expanded: [],
    positions: Object.fromEntries(Object.entries(positions).filter(([id]) => byId.has(id)).slice(0, 1000)),
  }), [positions, byId]);

  useEffect(() => { if (ready) stateCallback.current(state); }, [state, ready]);
  useEffect(() => {
    let live = true, timer = 0;
    setError('');
    const timeout = new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error('Flow layout timed out')), 10_000); });
    Promise.race([flowPositions(sharedElk(), result), timeout]).then(next => {
      if (!live) return;
      // Flowchart ids are kind@line: after a code edit other nodes take the old ids, so stored positions are kept only
      // when they are for exactly these nodes.
      const fixed = !chart || (Object.keys(positionsRef.current).length === result.nodes.length && result.nodes.every(n => positionsRef.current[n.id]))
        ? positionsRef.current : {};
      setPositions(Object.fromEntries(result.nodes.map(n => [n.id, fixed[n.id] ?? next[n.id]])));
      setReady(true);
    }).catch(e => { if (live) setError(`Could not lay out the flow: ${e.message}`); })
      .finally(() => window.clearTimeout(timer));
    return () => { live = false; window.clearTimeout(timer); };
  }, [result, revision, chart]);

  const frames = useMemo(() => flowFrames(result, positions), [result, positions]);
  const framesBy = useMemo(() => frameIndex(result, frames), [result, frames]);
  const nodes = useMemo<Node[]>(() => [
    ...frames.map((f, i) => ({ id: `flow-frame:${i}`, type: 'frame', position: { x: f.x, y: f.y },
      data: { label: f.group.label, explanation: f.group.explanation, onExplain: () => setSelected({ kind: 'group', id: f.group.id }), onOpen: chart && f.group.source ? () => onOpenSource(f.group.source!.file, f.group.source!.line) : undefined }, style: { width: f.width, height: f.height }, className: 'flow-frame',
      draggable: false, selectable: false, focusable: false, zIndex: -1,
    })),
    ...result.nodes.filter(n => positions[n.id]).map(n => ({
      id: n.id, type: chart ? 'chart' : 'step', position: positions[n.id], data: { node: n }, ...size(n),
      ariaLabel: chart ? `${n.kind} ${n.label}` : `${n.role ? n.role : 'Step'} ${n.label}`, selected: selected?.kind === 'node' && selected.id === n.id,
    })),
  ], [result, positions, frames, selected, chart, size, onOpenSource]);
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
        id: e.id, source: e.from, target: e.to, type: 'transition', label: e.label ?? undefined,
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
    for (const c of changes) if (c.type === 'position' && c.position && byId.has(c.id)) {
      moved[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
    }
    if (Object.keys(moved).length) setPositions(p => ({ ...p, ...moved }));
  }, [byId]);
  const focusNode = (id: string) => {
    setSelected({ kind: 'node', id });
    const p = positions[id], n = byId.get(id);
    if (p && n) void flow.setCenter(p.x + size(n).width / 2, p.y + size(n).height / 2, { zoom: Math.max(flow.getZoom(), 0.8), duration: 250 });
  };
  const node = selected?.kind === 'node' ? byId.get(selected.id) : undefined;
  const edge = selected?.kind === 'edge' ? result.edges.find(e => e.id === selected.id) : undefined;
  const group = selected?.kind === 'group' ? result.groups.find(g => g.id === selected.id) : undefined;
  return <div className="er-diagram flow-diagram" data-testid="flow-diagram" onKeyDown={e => { if (e.key === 'Escape') setSelected(null); }}>
    <div className="er-toolbar" role="toolbar" aria-label="Diagram">
      <span className="er-count">{result.nodes.length} nodes · {result.edges.length} transitions</span>
      <button aria-label="Re-layout the diagram" onClick={() => { positionsRef.current = {}; setPositions({}); setReady(false); setRevision(r => r + 1); }}><LayoutGrid size={13} />Re-layout</button>
      <button aria-label="Save as view" disabled={!ready || !onSaveAs}
        title={onSaveAs ? undefined : 'Set the depth back to the view’s own to save it'} onClick={() => onSaveAs?.(state)}><Save size={13} />Save as view…</button>
      <div className="er-toolbar-extra">{toolbarExtra}</div>
    </div>
    <div className="er-body">
      <div className="er-canvas">
        {error ? <p className="er-status" role="alert">{error}. Use Re-layout to retry.</p>
          : !result.nodes.length ? <p className="er-status">No steps found in this worktree.</p>
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
      {node && <Inspector variant="flow" node={node} nodes={byId} edges={result.edges} onSelect={focusNode}
        onClose={() => setSelected(null)} onOpenSource={onOpenSource} />}
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
      {group && <aside className="er-inspector" aria-label={`Function ${group.label}`}>
        <header><div><strong>{group.label}</strong><span>expanded call</span></div>
          <button className="icon" aria-label="Close inspector" onClick={() => setSelected(null)}><X size={14} /></button></header>
        {group.source && <div className="er-inspector-source"><code title={`${group.source.file}:${group.source.line}`}>{group.source.file}:{group.source.line}</code>
          <button aria-label="Open function in editor" onClick={() => onOpenSource(group.source!.file, group.source!.line)}><ExternalLink size={12} />Open in editor</button></div>}
        {group.explanation && <p className="flow-inspector-explanation">{group.explanation}</p>}
      </aside>}
    </div>
  </div>;
}
