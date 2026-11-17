import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ChevronRight } from 'lucide-react';
import type { DiagramNode } from '../views';

/** Frame header; flowchart call frames open their function's source when clicked. */
export function FlowGroup({ data }: NodeProps<Node<{ label: string; onOpen?: () => void }>>) {
  return data.onOpen ? <button className="flow-frame-label flow-frame-open nodrag" title={`Open ${data.label} in editor`} onClick={data.onOpen}>{data.label}</button>
    : <div className="flow-frame-label" title={data.label}>{data.label}</div>;
}

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
  if (n.kind === 'start' || n.kind === 'end' || n.kind === 'error') return <div className={`flow-card flow-pill ${n.kind}`}>
    <strong title={n.detail || n.label}>{n.label}</strong>{handles}</div>;
  return <div className={`flow-card flow-chart-${n.kind}`}>
    <strong title={n.label}>{n.label}{n.kind === 'call' && <ChevronRight size={13} className="flow-call-chevron" aria-label="call" />}</strong>
    {sub && <span className={n.kind === 'call' && n.subtitle ? 'flow-call-hint' : undefined} title={sub}>{sub}</span>}
    {handles}</div>;
});

export const FlowNode = memo(function FlowNode({ data }: NodeProps<FlowStepNode>) {
  const n = data.node;
  return <div className={`flow-card${n.role ? ` flow-pill ${n.role}` : ''}`}>
    <Handle type="target" position={Position.Top} id="in" />
    <strong title={n.label}>{n.label}</strong>
    {!n.role && (n.subtitle || n.detail) && <span title={n.subtitle || n.detail || undefined}>{n.subtitle || n.detail}</span>}
    <Handle type="source" position={Position.Bottom} id="out" />
    <Handle type="source" position={Position.Right} id="return-out" style={{ top: '70%' }} />
    <Handle type="target" position={Position.Right} id="return-in" style={{ top: '30%' }} />
  </div>;
});
