import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { GitStatus } from './shared';
import { queueWorkspaceRead } from './workspace-read-queue';

// The selected row uses App's existing Git result. Only background rows need
// their own read; leaving the project/unmounting cancels queued work.
export function useSidebarGit(workspaceId: string, enabled: boolean) {
  const [result, setResult] = useState<{ status: GitStatus | null; error: string; busy: boolean }>({ status: null, error: '', busy: false });
  const epoch = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    if (!enabled || document.hidden) return Promise.resolve();
    if (pending.current) return pending.current;
    const current = epoch.current;
    setResult(previous => ({ ...previous, busy: true }));
    const request = queueWorkspaceRead(async () => {
      if (current !== epoch.current || document.hidden) return;
      try {
        const status = await api.gitStatus(workspaceId);
        if (current === epoch.current) setResult({ status, error: '', busy: false });
      } catch {
        if (current === epoch.current) setResult({ status: null, error: 'Git is unavailable for this workspace. Retry after checking repository access.', busy: false });
      }
    }).finally(() => {
      if (pending.current === request) pending.current = null;
      if (current === epoch.current) setResult(previous => ({ ...previous, busy: false }));
    });
    pending.current = request;
    return request;
  }, [workspaceId, enabled]);
  useEffect(() => {
    ++epoch.current; pending.current = null;
    if (!enabled) return;
    void refresh();
    const update = () => { void refresh(); };
    const timer = window.setInterval(update, 10000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { ++epoch.current; clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [enabled, refresh]);
  return { ...result, refresh };
}
