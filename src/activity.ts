// Renderer-safe metadata only. Never include transport credentials or agent content.
export type PiPhase = 'idle' | 'working' | 'waiting' | 'failed' | 'interrupted' | 'unknown';
export type PiActivity = {
  id: string; terminalId: string; workspaceId: string;
  connection: 'connected' | 'disconnected' | 'unsupported';
  phase: PiPhase;
  reviewRevision: number | null;
};
export type ActivitySnapshot = { revision: number; agents: PiActivity[] };
export type ActivityLabel = 'Working' | 'Waiting for you' | 'Needs review' | 'Idle' | 'Failed' | 'Interrupted' | 'Disconnected' | 'Tracking unavailable';
export function activityLabel(agent: PiActivity): ActivityLabel {
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
export function aggregateActivity(agents: PiActivity[]): ActivityLabel | null {
  const labels = agents.map(activityLabel);
  return priority.find(label => labels.includes(label)) ?? null;
}
export function newerActivity(current: ActivitySnapshot, incoming: ActivitySnapshot): ActivitySnapshot {
  return incoming.revision > current.revision ? incoming : current;
}
