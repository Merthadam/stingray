import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import { shortEdgeLabel, type bandEntry } from './flow-layout';

export type FlowTransition = Edge<{ returnX?: number; entry?: ReturnType<typeof bandEntry>; onSelect: () => void }, 'transition'>;

export function FlowEdge(props: EdgeProps<FlowTransition>) {
  const { sourceX, sourceY, targetX, targetY, data, label, selected } = props;
  const [forward] = getSmoothStepPath(props);
  const lane = data?.returnX, entry = data?.entry;
  // Forward labels sit just above their target so each branch reads next to the step it leads to.
  // Return edges use a corridor outside the group's cards; distinct right handles keep self-loops visible.
  // Edges into an explained frame go around its side and enter under the explanation, labelled on the lane above the frame.
  const path = entry ? `M ${sourceX} ${sourceY} V ${entry.aboveY} H ${entry.laneX} V ${entry.belowY} H ${targetX} V ${targetY}`
    : lane === undefined ? forward : `M ${sourceX} ${sourceY} H ${lane} V ${targetY} H ${targetX}`;
  const [labelX, labelY] = entry ? [entry.laneX, entry.labelY] : lane === undefined ? [targetX, targetY - 26] : [lane, (sourceY + targetY) / 2];
  return <>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} interactionWidth={20} />
    {typeof label === 'string' && label && <EdgeLabelRenderer>
      <button className={`flow-edge-label nodrag nopan${selected ? ' selected' : ''}`} title={label}
        aria-label={`Select transition ${label}`} onClick={data?.onSelect}
        style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
        {shortEdgeLabel(label)}
      </button>
    </EdgeLabelRenderer>}
  </>;
}
