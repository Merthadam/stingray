import type { ActivitySnapshot, AgentActivity, HarnessId } from '../shared/contracts/activity';
export const harnessNames: Record<HarnessId, string> = { pi: 'Pi', claude: 'Claude Code', codex: 'Codex' };
export type ActivityLabel = 'Working' | 'Waiting for you' | 'Needs review' | 'Idle' | 'Failed' | 'Interrupted' | 'Disconnected' | 'Tracking unavailable';
export function activityLabel(agent: AgentActivity): ActivityLabel {
  if (agent.restored) return agent.reviewRevision !== null ? 'Needs review' : agent.phase === 'failed' ? 'Failed'
    : agent.phase === 'interrupted' ? 'Interrupted' : agent.phase === 'idle' ? 'Idle' : 'Disconnected';
  if (agent.connection === 'connected' && agent.phase === 'waiting') return 'Waiting for you';
  if (agent.connection === 'connected' && agent.phase === 'working') return 'Working';
  if (agent.reviewRevision !== null) return 'Needs review';
  if (agent.connection === 'unsupported') return 'Tracking unavailable';
  if (agent.connection === 'disconnected') return 'Disconnected';
  if (agent.phase === 'failed') return 'Failed';
  if (agent.phase === 'interrupted') return 'Interrupted';
  if (agent.phase === 'unknown') return 'Tracking unavailable';
  return 'Idle';
}
const priority: ActivityLabel[] = ['Waiting for you', 'Working', 'Needs review', 'Failed', 'Interrupted', 'Disconnected', 'Tracking unavailable', 'Idle'];
export function aggregateActivity(agents: AgentActivity[]): ActivityLabel | null {
  const labels = agents.map(activityLabel);
  return priority.find(label => labels.includes(label)) ?? null;
}
export function newerActivity(current: ActivitySnapshot, incoming: ActivitySnapshot): ActivitySnapshot {
  return incoming.revision > current.revision ? incoming : current;
}
/** Coarse age for restored activity, e.g. '5m ago', '3h ago', '2d ago'. */
export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
/** Display name for a set of agents: the shared harness name, or 'Agents' when mixed. */
export function harnessLabel(agents: AgentActivity[]): string {
  const ids = new Set(agents.map(a => a.harness));
  return ids.size === 1 ? harnessNames[[...ids][0]] : 'Agents';
}
