// Renderer-safe metadata only. Never include transport credentials or agent content.
export type AgentPhase = 'idle' | 'working' | 'waiting' | 'failed' | 'interrupted' | 'unknown';
export type HarnessId = 'pi' | 'claude' | 'codex';
export const harnessNames: Record<HarnessId, string> = { pi: 'Pi', claude: 'Claude Code', codex: 'Codex' };
export type AgentActivity = {
  id: string; terminalId: string; workspaceId: string; harness: HarnessId;
  connection: 'connected' | 'disconnected' | 'unsupported';
  phase: AgentPhase;
  reviewRevision: number | null;
};
export type ActivitySnapshot = { revision: number; agents: AgentActivity[] };
export type ActivityLabel = 'Working' | 'Waiting for you' | 'Needs review' | 'Idle' | 'Failed' | 'Interrupted' | 'Disconnected' | 'Tracking unavailable';
export function activityLabel(agent: AgentActivity): ActivityLabel {
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
/** Display name for a set of agents: the shared harness name, or 'Agents' when mixed. */
export function harnessLabel(agents: AgentActivity[]): string {
  const ids = new Set(agents.map(a => a.harness));
  return ids.size === 1 ? harnessNames[[...ids][0]] : 'Agents';
}
