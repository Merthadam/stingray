import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

export type Discovery<T> = { data: T[]; loading: boolean; refreshing: boolean; error: string };
function useDiscovery<T>(load: () => Promise<T[]>, interval: number, enabled: boolean, revision: string) {
  const [value, setValue] = useState<Discovery<T>>({ data: [], loading: true, refreshing: false, error: '' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      setValue(v => ({ ...v, refreshing: true }));
      try {
        const data = await load();
        if (!disposed) setValue({ data, loading: false, refreshing: false, error: '' });
      } catch (error) {
        if (!disposed) setValue(v => ({ ...v, loading: false, refreshing: false, error: ((error as Error).message || 'Discovery failed. Retry.').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') }));
      } finally { pending = false; }
    };
    void refresh();
    const onFocus = () => { void refresh(); };
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, interval);
    window.addEventListener('focus', onFocus);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [load, interval, enabled, revision, retry]);
  return { ...value, retry: useCallback(() => setRetry(n => n + 1), []) };
}
const loadPorts = () => api.ports();
const loadContainers = () => api.containers();
export function useWorkspacePorts(enabled: boolean, terminalRevision: string) {
  const terminals = useDiscovery(loadPorts, 2500, enabled, terminalRevision);
  const containers = useDiscovery(loadContainers, 10000, enabled, '');
  return { terminals, containers, retry: () => { terminals.retry(); containers.retry(); } };
}
