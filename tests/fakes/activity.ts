import type { ActivityConnection, HistoryRepository, ProcessProbe } from '../../electron/core/activity';
import type { ActivityRecord } from '../../electron/core/activity';

export function fakeConnection(): ActivityConnection & { ended: boolean } {
  const c = { ended: false, destroyed: false, end() { c.ended = true; }, destroy() { c.destroyed = true; } };
  return c;
}
export function fakeProbe(pids = new Set<number>()): ProcessProbe & { pids: Set<number> } {
  return { pids, alive: pid => pids.has(pid) };
}
export function memoryHistory(records: ActivityRecord[] = []): HistoryRepository & { saved: ActivityRecord[][] } {
  const saved: ActivityRecord[][] = [];
  return { saved, load: () => structuredClone(records), save: next => { saved.push(structuredClone(next)); } };
}
export function fakeClock(start = 1_000_000) { let now = start; return { now: () => now, advance: (ms: number) => { now += ms; } }; }
