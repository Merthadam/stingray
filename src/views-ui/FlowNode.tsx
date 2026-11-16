import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { DiagramNode } from '../views';

export function FlowGroup({ data }: NodeProps<Node<{ label: string }>>) {
  return <div className="flow-frame-label" title={data.label}>{data.label}</div>;
}

export type FlowStepNode = Node<{ node: DiagramNode }, 'step'>;

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
