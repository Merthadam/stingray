// Typed event emitters for one contract; core services receive these as their publish ports.
import type { BrowserWindow } from 'electron';
import { channel, type Contract, type Publishers } from '../../../../shared/contracts/define';

export function sender<C extends Contract>(contract: C, win: () => BrowserWindow | undefined): Publishers<C> {
  const out: Record<string, (payload: unknown) => void> = {};
  for (const member of Object.keys(contract.events)) out[member] = payload => {
    const w = win();
    if (w && !w.isDestroyed()) w.webContents.send(channel(contract.feature, member), payload);
  };
  return out as Publishers<C>;
}
