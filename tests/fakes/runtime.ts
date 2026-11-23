import type { CdpConnection, CdpSocket } from '../../electron/core/runtime';
import { APP_PAGE } from '../../electron/core/runtime';

/** A CDP endpoint whose socket records commands and never replies. */
export function silentCdp() {
  const sent: string[] = [];
  const socket: CdpSocket = { open: true, send: t => { sent.push(t); }, close: () => {}, onMessage: () => {}, onClose: () => {} };
  const cdp: CdpConnection = { list: async () => [{ id: 'T', type: 'page', url: APP_PAGE, title: 'Stingray' }], connect: async () => socket };
  return { cdp, sent };
}
