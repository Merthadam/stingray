import { AlertCircle, CheckCircle2, Circle, CirclePause, Eye, History, LoaderCircle, Unplug, X } from 'lucide-react';
import { activityLabel, aggregateActivity, harnessLabel, harnessNames, relativeTime } from './activity';
import { type AgentActivity } from '../../../shared/contracts/activity';
import './workspace-activity.css';

export function WorkspaceActivity({ agents, unavailable = false }: { agents: AgentActivity[]; unavailable?: boolean }) {
  const label = unavailable ? 'Tracking unavailable' : aggregateActivity(agents);
  if (!label) return null;
  const harness = harnessLabel(agents);
  const Icon = label === 'Working' ? LoaderCircle : label === 'Waiting for you' ? CirclePause : label === 'Needs review' ? Eye : label === 'Idle' ? CheckCircle2 : label === 'Disconnected' ? Unplug : label === 'Interrupted' ? Circle : AlertCircle;
  const details = unavailable ? 'Activity bridge unavailable; no agent state is inferred.' : agents.map((a, i) =>
    `${harnessNames[a.harness]} ${i + 1}: ${activityLabel(a)} (${a.connection}; last observed phase: ${a.phase})${a.reviewRevision !== null && activityLabel(a) !== 'Needs review' ? '; unseen completion' : ''}${a.harness === 'codex' ? '; Codex reports turn completion only' : ''}`
  ).join('\n');
  return <div className={'workspace-activity activity-' + label.toLowerCase().replaceAll(' ', '-')} role="status" aria-label={`${harness}: ${label}${agents.length > 1 ? ` · ${agents.length} sessions` : ''}`} title={details}>
    <Icon size={12} className={label === 'Working' ? 'spin' : ''} aria-hidden="true" />
    <b className="activity-harness">{harness}</b><span>{label}</span>{agents.length > 1 && <small>{agents.length}</small>}
    {!unavailable && agents.some(a => a.connection !== 'connected') && label === 'Needs review' && <Unplug size={11} aria-label="Tracking disconnected" />}
  </div>;
}

/** Activity restored from the previous app session: its terminals are gone, so it is dismissed, not acknowledged. */
export function PreviousActivity({ agents, onDismiss }: { agents: AgentActivity[]; onDismiss: () => void }) {
  const label = aggregateActivity(agents);
  if (!label) return null;
  const harness = harnessLabel(agents);
  const last = Math.max(...agents.map(a => a.lastEventAt));
  const details = agents.map((a, i) => `${harnessNames[a.harness]} ${i + 1}: ${activityLabel(a)} · ${relativeTime(a.lastEventAt)} (last observed phase: ${a.phase})`).join('\n');
  return <div className={'workspace-activity activity-previous activity-' + label.toLowerCase().replaceAll(' ', '-')} role="status"
    aria-label={`Previous session, ${harness}: ${label}, ${relativeTime(last)}`} title={'Previous Stingray session\n' + details}>
    <History size={12} aria-hidden="true" />
    <b className="activity-harness">{harness}</b><span>{label} · previous session · {relativeTime(last)}</span>{agents.length > 1 && <small>{agents.length}</small>}
    <button type="button" className="icon activity-dismiss" aria-label="Dismiss previous session activity" title="Dismiss" onClick={onDismiss}><X size={10} /></button>
  </div>;
}
