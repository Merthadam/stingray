// React Flow node for one table card: header, explanation band (when explained), field rows with one source/target handle each, "+N more" toggle.
import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { DiagramNode } from '../../shared/contracts/views';
import { cardRows } from './er-layout';
import { StaleMark, explanationTitle } from './FlowNode';

export interface TableNodeData extends Record<string, unknown> {
  node: DiagramNode;
  expanded: boolean;
  activeField: string | null;     // field whose edges are highlighted
  onToggle(id: string): void;
  onField(nodeId: string, fieldId: string): void;
}
export type TableFlowNode = Node<TableNodeData, 'table'>;

function Handles({ id }: { id: string }) {
  return <>
    <Handle type="target" position={Position.Left} id={`${id}:t`} isConnectable={false} />
    <Handle type="source" position={Position.Right} id={`${id}:s`} isConnectable={false} />
  </>;
}

export const TableNode = memo(function TableNode({ data }: NodeProps<TableFlowNode>) {
  const { node, expanded, activeField, onToggle, onField } = data;
  const { rows, more, toggle } = cardRows(node, expanded);
  return <div className="er-card">
    <div className="er-card-header" title={node.label}>
      <Handles id="card" />
      <strong>{node.label}</strong>
      {node.subtitle && <span>{node.subtitle}</span>}
    </div>
    {node.explanation && <div className="er-card-explanation" title={explanationTitle(node.explanation, node.explanationStatus, node.explanationReason)}><span><StaleMark status={node.explanationStatus} />{node.explanation}</span></div>}
    {rows.map(f => <div key={f.id} className={`er-row${f.id === activeField ? ' active' : ''}`} title={f.detail ?? undefined}
      onClick={() => onField(node.id, f.id)}>
      <Handles id={`f:${f.id}`} />
      <span className="er-row-name">{f.label}</span>
      <span className="er-badges">{f.badges.map(b => <b key={b} className={`er-badge ${b.toLowerCase()}`}>{b}</b>)}</span>
      <span className="er-row-type">{f.type ?? '?'}</span>
    </div>)}
    {toggle && <button className="er-row er-more nodrag" aria-label={expanded ? `Show fewer columns of ${node.label}` : `Show ${more} more columns of ${node.label}`}
      aria-expanded={expanded} onClick={event => { event.stopPropagation(); onToggle(node.id); }}>
      <Handles id="more" />
      {expanded ? 'Show less' : `+${more} more`}
    </button>}
  </div>;
});
