// window.stingray from the contracts: one invoke per route (unwrapping the IpcResult envelope), one subscribe per event.
import type { IpcRenderer } from 'electron';
import { channel, rendererName, type Contract, type IpcResult } from '../../../../shared/contracts/define';

const trimTrailingUndefined = (args: unknown[]) => { const out = [...args]; while (out.length && out.at(-1) === undefined) out.pop(); return out; };

export function buildPreloadApi(contracts: readonly Contract[], ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>) {
  const api: Record<string, unknown> = { mode: 'desktop' };
  for (const c of contracts) {
    for (const [member, entry] of Object.entries(c.invoke)) api[rendererName(member, entry)] = async (...args: unknown[]) => {
      const result = await ipc.invoke(channel(c.feature, member), ...trimTrailingUndefined(args)) as IpcResult<unknown>;
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    for (const member of Object.keys(c.events)) api[member] = (listener: (payload: unknown) => void) => {
      const name = channel(c.feature, member);
      const h = (_event: unknown, payload: unknown) => listener(payload);
      ipc.on(name, h);
      return () => { ipc.removeListener(name, h); };
    };
  }
  return api;
}
