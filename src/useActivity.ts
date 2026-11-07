import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from './api';
import { newerActivity, type ActivitySnapshot } from './activity';

export function useActivity(visibleIds: string[]) {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>({ revision: -1, agents: [] });
  const [unavailable, setUnavailable] = useState(false);
  const latest = useRef(snapshot); latest.current = snapshot;
  const view = visibleIds.join(',');
  const visible = useRef(view); visible.current = view;
  const viewReady = useRef<Promise<void>>(Promise.resolve());
  useLayoutEffect(() => {
    viewReady.current = api.activityView(view ? view.split(',') : []).catch(() => { setUnavailable(true); });
  }, [view]);
  useEffect(() => {
    let disposed = false;
    const accept = (incoming: ActivitySnapshot) => {
      if (disposed) return;
      setSnapshot(current => newerActivity(current, incoming)); setUnavailable(false);
    };
    // Full revisioned snapshots make replay bounded and prevent a slow initial
    // read from overwriting an event received after subscription.
    const off = api.onActivity(accept);
    void api.activity().then(accept).catch(() => { if (!disposed) setUnavailable(true); });
    return () => { disposed = true; off(); };
  }, []);
  const acknowledge = useCallback((terminalId: string, stillObserved: () => boolean) => {
    const capturedView = visible.current;
    if (document.hidden || !document.hasFocus() || !capturedView.split(',').includes(terminalId)) return;
    // Capture exact revisions at the observation; a later completion is not seen.
    const reviews = latest.current.agents.filter(a => a.terminalId === terminalId && a.reviewRevision !== null);
    void viewReady.current.then(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))).then(async () => {
      if (visible.current !== capturedView || document.hidden || !document.hasFocus() || !stillObserved()) return;
      await Promise.all(reviews.map(a => api.acknowledgeActivity(a.id, terminalId, a.reviewRevision!)));
    }).catch(() => { setUnavailable(true); });
  }, []);
  return { agents: snapshot.agents, unavailable, acknowledge };
}
