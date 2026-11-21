import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ChevronRight } from 'lucide-react';
import type { DiagramNode } from '../views';
import { showsExplanation } from './flow-layout';

/** Frame header; flowchart call frames open their function's source when clicked and show the function's explanation
 * under the title (clicking it opens the full text in the inspector). */
export function FlowGroup({ data }: NodeProps<Node<{ label: string; explanation?: string | null; onOpen?: () => void; onExplain?: () => void }>>) {
  return <>
    {data.onOpen ? <button className="flow-frame-label flow-frame-open nodrag" aria-label={`Open ${data.label} in editor`} title={`Open ${data.label} in editor`} onClick={data.onOpen}>{data.label}</button>
      : <div className="flow-frame-label" title={data.label}>{data.label}</div>}
    {data.explanation && <button className="flow-frame-explanation nodrag" aria-label={`Explanation of ${data.label}: ${data.explanation}`}
      title={data.explanation} onClick={data.onExplain}><span className="flow-explanation">{data.explanation}</span></button>}
  </>;
}

/** A node's explanation (its symbol's docstring summary), clamped in the card; full text on hover and in the inspector. */
const Explanation = ({ node, chart }: { node: DiagramNode; chart?: boolean }) =>
  showsExplanation(node, chart) ? <p className="flow-explanation" title={node.explanation!}>{node.explanation}</p> : null;

export type FlowStepNode = Node<{ node: DiagramNode }, 'step'>;

const handles = <>
  <Handle type="target" position={Position.Top} id="in" />
  <Handle type="source" position={Position.Bottom} id="out" />
  <Handle type="source" position={Position.Right} id="return-out" style={{ top: '70%' }} />
  <Handle type="target" position={Position.Right} id="return-in" style={{ top: '30%' }} />
</>;

/** Flowchart shapes by node kind: pills (start/end, red error), diamonds (decision/loop), boxes (action, call + chevron). */
export const FlowchartNode = memo(function FlowchartNode({ data }: NodeProps<FlowStepNode>) {
  const n = data.node, sub = n.subtitle || n.detail;
  if (n.kind === 'decision' || n.kind === 'loop') return <div className={`flow-diamond ${n.kind}`}>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="50,1 99,50 50,99 1,50" vectorEffect="non-scaling-stroke" /></svg>
    <strong title={n.detail || n.label}>{n.label}</strong>{handles}</div>;
  if (n.kind === 'start' || n.kind === 'end' || n.kind === 'error') return <div className={`flow-card flow-pill ${n.kind}${n.explanation ? ' explained' : ''}`}>
    <strong title={n.detail || n.label}>{n.label}</strong><Explanation node={n} chart />{handles}</div>;
  return <div className={`flow-card flow-chart-${n.kind}`}>
    <strong title={n.label}>{n.label}{n.kind === 'call' && <ChevronRight size={13} className="flow-call-chevron" aria-label="call" />}</strong>
    {sub && <span className={n.kind === 'call' && n.subtitle ? 'flow-call-hint' : undefined} title={sub}>{sub}</span>}
    <Explanation node={n} chart />{handles}</div>;
});

export const FlowNode = memo(function FlowNode({ data }: NodeProps<FlowStepNode>) {
  const n = data.node;
  return <div className={`flow-card${n.role ? ` flow-pill ${n.role}` : ''}`}>
    <Handle type="target" position={Position.Top} id="in" />
    <strong title={n.label}>{n.label}</strong>
    {!n.role && (n.subtitle || n.detail) && <span title={n.subtitle || n.detail || undefined}>{n.subtitle || n.detail}</span>}
    {!n.role && n.fields.length > 0 && <ul className="flow-fields" aria-label={`Fields of ${n.label}`}>
      {n.fields.map(f => <li key={f.id} title={f.detail ? `${f.label} · ${f.detail}` : f.label}>{f.label}</li>)}</ul>}
    <Explanation node={n} />
    <Handle type="source" position={Position.Bottom} id="out" />
    <Handle type="source" position={Position.Right} id="return-out" style={{ top: '70%' }} />
    <Handle type="target" position={Position.Right} id="return-in" style={{ top: '30%' }} />
  </div>;
});
