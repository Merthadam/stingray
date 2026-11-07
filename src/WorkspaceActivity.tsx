import { AlertCircle, CheckCircle2, Circle, CirclePause, Eye, LoaderCircle, Unplug } from 'lucide-react';
import { activityLabel, aggregateActivity, type PiActivity } from './activity';
import './workspace-activity.css';

export function WorkspaceActivity({ agents, unavailable = false }: { agents: PiActivity[]; unavailable?: boolean }) {
  const label = unavailable ? 'Tracking unavailable' : aggregateActivity(agents);
  if (!label) return null;
  const Icon = label === 'Working' ? LoaderCircle : label === 'Waiting for you' ? CirclePause : label === 'Needs review' ? Eye : label === 'Idle' ? CheckCircle2 : label === 'Disconnected' ? Unplug : label === 'Interrupted' ? Circle : AlertCircle;
  const details = unavailable ? 'Activity bridge unavailable; no agent state is inferred.' : agents.map((a, i) =>
    `Pi ${i + 1}: ${activityLabel(a)} (${a.connection}; last observed phase: ${a.phase})${a.reviewRevision !== null && activityLabel(a) !== 'Needs review' ? '; unseen completion' : ''}`
  ).join('\n');
  return <div className={'workspace-activity activity-' + label.toLowerCase().replaceAll(' ', '-')} role="status" aria-label={`Pi: ${label}${agents.length > 1 ? ` · ${agents.length} sessions` : ''}`} title={details}>
    <Icon size={12} className={label === 'Working' ? 'spin' : ''} aria-hidden="true" />
    <span>{label}</span>{agents.length > 1 && <small>{agents.length}</small>}
    {!unavailable && agents.some(a => a.connection !== 'connected') && label === 'Needs review' && <Unplug size={11} aria-label="Tracking disconnected" />}
  </div>;
}
