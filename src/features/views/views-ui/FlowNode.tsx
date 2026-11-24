import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ChevronRight } from 'lucide-react';
import type { DiagramNode, ExplanationStatus } from '../../../../shared/contracts/views';
import { INFRA_GROUP_ICONS, type InfraProvider } from '../../../../shared/views/infra/catalog';
import { infraIconUrl } from '../infra/icons';
import { cardFields, infraName, showsExplanation } from './flow-layout';

/** Frame header; flowchart call frames open their function's source when clicked and show the function's explanation
 * under the title (clicking it opens the full text in the inspector). */
const STALE = 'may be outdated: the code changed since this explanation was written';
const LEGACY = 'old fingerprint';
/** Marker in front of a view `explain:` text whose fingerprint no longer matches the code ('stale') or uses the old
 * own-body-only format ('legacy', muted). */
export const StaleMark = ({ status }: { status?: ExplanationStatus }) =>
  status === 'stale' ? <b className="flow-explanation-stale" title={STALE}>may be outdated</b>
    : status === 'legacy' ? <b className="flow-explanation-stale legacy" title={LEGACY} aria-label={LEGACY}>{LEGACY}</b> : null;
/** Why a stale or legacy explanation is flagged: the given reason, else a generic note; undefined for other statuses. */
const explanationNote = (status?: ExplanationStatus, reason?: string) =>
  status === 'stale' ? reason ?? STALE : status === 'legacy' ? reason ?? LEGACY : undefined;
/** Hover text of an explanation, with the staleness note. */
export const explanationTitle = (text: string, status?: ExplanationStatus, reason?: string) => {
  const note = explanationNote(status, reason);
  return note ? `${text}\n(${note})` : text;
};
/** Inspector line under a stale or legacy explanation naming what changed. */
export const ExplanationReason = ({ status, reason }: { status?: ExplanationStatus; reason?: string }) =>
  reason && (status === 'stale' || status === 'legacy') ? <p className="flow-inspector-explanation-reason">{reason}</p> : null;

export function FlowGroup({ data }: NodeProps<Node<{ label: string; provider?: InfraProvider; explanation?: string | null; explanationStatus?: ExplanationStatus; explanationReason?: string; onOpen?: () => void; onExplain?: () => void }>>) {
  const note = explanationNote(data.explanationStatus, data.explanationReason);
  return <>
    {data.provider && <img className="flow-frame-cloud-icon" src={infraIconUrl(INFRA_GROUP_ICONS[data.provider])} alt="" draggable={false} />}
    {data.onOpen ? <button className="flow-frame-label flow-frame-open nodrag" aria-label={`Open ${data.label} in editor`} title={`Open ${data.label} in editor`} onClick={data.onOpen}>{data.label}</button>
      : <div className="flow-frame-label" title={data.label}>{data.label}</div>}
    {data.explanation && <button className="flow-frame-explanation nodrag" aria-label={`Explanation of ${data.label}${note ? ` (${note})` : ''}: ${data.explanation}`}
      title={explanationTitle(data.explanation, data.explanationStatus, data.explanationReason)} onClick={data.onExplain}><span className="flow-explanation"><StaleMark status={data.explanationStatus} />{data.explanation}</span></button>}
  </>;
}

/** A node's explanation (its symbol's docstring summary), clamped in the card; full text on hover and in the inspector. */
const Explanation = ({ node, chart }: { node: DiagramNode; chart?: boolean }) =>
  showsExplanation(node, chart) ? <p className="flow-explanation" title={explanationTitle(node.explanation!, node.explanationStatus, node.explanationReason)}>
    <StaleMark status={node.explanationStatus} />{node.explanation}</p> : null;

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

/** A cloud resource drawn like an AWS/Azure architecture diagram: the service icon, the resource name, the service name. */
const InfraCard = ({ node: n }: { node: DiagramNode }) => <div className={`flow-card flow-infra ${n.service!.provider}`}>
  <Handle type="target" position={Position.Top} id="in" />
  <img className="flow-infra-icon" src={infraIconUrl(n.service!.id)} alt="" draggable={false} />
  <strong title={n.label}>{infraName(n)}</strong>
  <span title={n.subtitle ? `${n.service!.name} · ${n.subtitle}` : n.service!.name}>{n.service!.name}</span>
  <Explanation node={n} />
  <Handle type="source" position={Position.Bottom} id="out" />
  <Handle type="source" position={Position.Right} id="return-out" style={{ top: '70%' }} />
  <Handle type="target" position={Position.Right} id="return-in" style={{ top: '30%' }} />
</div>;

export const FlowNode = memo(function FlowNode({ data }: NodeProps<FlowStepNode>) {
  const n = data.node, { fields, more } = cardFields(n);
  if (n.service) return <InfraCard node={n} />;
  return <div className={`flow-card${n.role ? ` flow-pill ${n.role}` : ''}`}>
    <Handle type="target" position={Position.Top} id="in" />
    <strong title={n.label}>{n.label}</strong>
    {!n.role && (n.subtitle || n.detail) && <span title={n.subtitle || n.detail || undefined}>{n.subtitle || n.detail}</span>}
    {!n.role && n.fields.length > 0 && <ul className="flow-fields" aria-label={`Fields of ${n.label}`}>
      {fields.map(f => <li key={f.id} title={f.detail ? `${f.label} · ${f.detail}` : f.label}>{f.label}</li>)}
      {more > 0 && <li className="flow-fields-more">+{more} more</li>}</ul>}
    <Explanation node={n} />
    <Handle type="source" position={Position.Bottom} id="out" />
    <Handle type="source" position={Position.Right} id="return-out" style={{ top: '70%' }} />
    <Handle type="target" position={Position.Right} id="return-in" style={{ top: '30%' }} />
  </div>;
});
