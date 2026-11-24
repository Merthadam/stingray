import type { TerminalEvent } from '../../../shared/contracts/terminals';

type Listener = (event: TerminalEvent) => void;
/** One api.onTerminal subscription shared by every pane and the app shell; listeners by terminal id, or null for all. */
export function createTerminalEvents(subscribe: (listener: Listener) => () => void) {
  const byId = new Map<string, Set<Listener>>(), all = new Set<Listener>();
  let off: (() => void) | null = null;
  const dispatch: Listener = event => { byId.get(event.id)?.forEach(l => l(event)); all.forEach(l => l(event)); };
  return {
    on(id: string | null, listener: Listener): () => void {
      off ??= subscribe(dispatch);
      if (id === null) all.add(listener); else { let set = byId.get(id); if (!set) byId.set(id, set = new Set()); set.add(listener); }
      return () => {
        if (id === null) all.delete(listener); else { const set = byId.get(id); set?.delete(listener); if (set && !set.size) byId.delete(id); }
        if (off && !all.size && !byId.size) { off(); off = null; }
      };
    },
  };
}
