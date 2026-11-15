import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import { shortEdgeLabel } from './flow-layout';

export type FlowTransition = Edge<{ returnX?: number; onSelect: () => void }, 'transition'>;

export function FlowEdge(props: EdgeProps<FlowTransition>) {
  const { sourceX, sourceY, targetX, targetY, data, label, selected } = props;
  const [forward] = getSmoothStepPath(props);
  const lane = data?.returnX;
  // Forward labels sit just above their target so each branch reads next to the step it leads to.
  // Return edges use a corridor outside the group's cards; distinct right handles keep self-loops visible.
  const path = lane === undefined ? forward : `M ${sourceX} ${sourceY} H ${lane} V ${targetY} H ${targetX}`;
  return <>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} interactionWidth={20} />
    {typeof label === 'string' && label && <EdgeLabelRenderer>
      <button className={`flow-edge-label nodrag nopan${selected ? ' selected' : ''}`} title={label}
        aria-label={`Select transition ${label}`} onClick={data?.onSelect}
        style={{ transform: `translate(-50%, -50%) translate(${lane === undefined ? targetX : lane}px, ${lane === undefined ? targetY - 26 : (sourceY + targetY) / 2}px)` }}>
        {shortEdgeLabel(label)}
      </button>
    </EdgeLabelRenderer>}
  </>;
}
