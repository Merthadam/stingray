import type { CdpConnection, CdpSocket } from '../../electron/core/runtime';
import { APP_PAGE } from '../../electron/core/runtime';

/** A CDP endpoint whose socket records commands and never replies. */
export function silentCdp() {
  const sent: string[] = [];
  const listeners = { message: [] as ((data: string) => void)[], close: [] as (() => void)[] };
  const socket = { open: true as boolean, send: (t: string) => { sent.push(t); }, close: () => {},
    onMessage: (l: (data: string) => void) => { listeners.message.push(l); }, onClose: (l: () => void) => { listeners.close.push(l); } } satisfies CdpSocket;
  const cdp: CdpConnection = { list: async () => [{ id: 'T', type: 'page', url: APP_PAGE, title: 'Stingray' }], connect: async () => socket };
  /** Deliver a reply as if the page answered; returns after listeners ran. */
  const reply = (id: number, result: unknown = {}) => listeners.message.forEach(l => l(JSON.stringify({ id, result })));
  const disconnect = () => { socket.open = false; listeners.close.forEach(l => l()); };
  const connected = () => listeners.close.length > 0;
  return { cdp, sent, reply, disconnect, connected };
}
