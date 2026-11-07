import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { PullRequestStatus } from './shared';
import { queueWorkspaceRead } from './workspace-read-queue';

export function usePullRequest(workspaceId: string, branch: string | undefined) {
  const key = JSON.stringify([workspaceId, branch]);
  const [record, setRecord] = useState<{ key: string; value: PullRequestStatus | null; busy: boolean }>();
  const generation = useRef(0);
  const mounted = useRef(true);
  const activeKey = useRef(key);
  activeKey.current = key;
  const pending = useRef(new Map<string, Promise<PullRequestStatus>>());
  const refresh = useCallback(async (force = false) => {
    if (!branch || document.hidden) return;
    const current = ++generation.current;
    setRecord(previous => ({ key, value: previous?.key === key ? previous.value : null, busy: true }));
    try {
      let request = pending.current.get(key);
      if (!request) {
        request = queueWorkspaceRead(() => {
          if (!mounted.current || activeKey.current !== key || document.hidden) throw new Error('Lookup no longer visible');
          return api.pullRequest(workspaceId, force);
        }).finally(() => pending.current.delete(key));
        pending.current.set(key, request);
      }
      const value = await request;
      if (current === generation.current) setRecord({ key, busy: false, value: value.branch === branch ? value :
        { kind: 'unavailable', branch, message: 'The branch changed during lookup. Refresh Git and PR status to check the current branch.' } });
    } catch {
      if (current === generation.current) setRecord({ key, busy: false, value:
        { kind: 'unavailable', branch, message: 'PR status is unavailable. Retry after checking workspace access.' } });
    }
  }, [workspaceId, branch, key]);

  useEffect(() => {
    mounted.current = true;
    if (!branch) { ++generation.current; return () => { mounted.current = false; ++generation.current; }; }
    let lastAttempt = Date.now();
    void refresh();
    const update = () => {
      if (document.hidden || Date.now() - lastAttempt < 10000) return;
      lastAttempt = Date.now(); void refresh();
    };
    const timer = window.setInterval(update, 60000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { mounted.current = false; ++generation.current; clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [branch, refresh]);
  return { value: record?.key === key ? record.value : null, busy: !record || record.key !== key || record.busy, refresh };
}
