// Agent activity metadata kept across app restarts, in the `agent_activity` table of the app database. Only
// renderer-safe metadata: never tokens, sockets, prompts or output. Rows go with their workspace (ON DELETE CASCADE).
import { z } from 'zod';

export const MAX_ACTIVITY_PER_WORKSPACE = 20, MAX_ACTIVITY_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const recordSchema = z.strictObject({
  id: z.string().uuid(), workspaceId: z.string().uuid(), terminalId: z.string().uuid(),
  harness: z.enum(['pi', 'claude', 'codex']),
  phase: z.enum(['idle', 'working', 'waiting', 'failed', 'interrupted', 'unknown']),
  needsReview: z.boolean(), startedAt: time, lastEventAt: time, completedAt: time.nullable(),
});
export type ActivityRecord = z.infer<typeof recordSchema>;
