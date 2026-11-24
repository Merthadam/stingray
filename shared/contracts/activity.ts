import { z } from 'zod';
import { idSchema } from './common';
import { defineContract, event, returns } from './define';

// Renderer-safe metadata only. Never include transport credentials or agent content.
export type AgentPhase = 'idle' | 'working' | 'waiting' | 'failed' | 'interrupted' | 'unknown';
export type HarnessId = 'pi' | 'claude' | 'codex';
export type AgentActivity = {
  id: string; terminalId: string; workspaceId: string; harness: HarnessId;
  connection: 'connected' | 'disconnected' | 'unsupported';
  phase: AgentPhase;
  reviewRevision: number | null;
  /** From a previous app session: its terminal is gone, so it is dismissed rather than acknowledged. */
  restored: boolean;
  lastEventAt: number;
};
export type ActivitySnapshot = { revision: number; agents: AgentActivity[] };

export const activityContract = defineContract('activity', {
  invoke: {
    activity: [z.tuple([]), returns<ActivitySnapshot>()],
    activityView: [z.tuple([z.array(idSchema).max(2)]), returns<void>()],
    acknowledgeActivity: [z.tuple([idSchema, idSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]), returns<void>()],
    /** Dismiss a workspace's restored (previous session) activity. */
    dismissActivity: [z.tuple([idSchema]), returns<void>()],
  },
  events: { onActivity: event<ActivitySnapshot>() },
});
