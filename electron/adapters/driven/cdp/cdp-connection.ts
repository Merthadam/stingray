import type { CdpConnection, CdpSocket } from '../../../core/runtime';

// Uses the fetch/WebSocket globals at call time, so tests can stand them in.
const wrap = (socket: WebSocket): CdpSocket => ({
  get open() { return socket.readyState === WebSocket.OPEN; },
  send: text => socket.send(text), close: () => socket.close(),
  onMessage: listener => socket.addEventListener('message', ({ data }) => listener(String(data))),
  onClose: listener => socket.addEventListener('close', () => listener()),
});
export const webCdp: CdpConnection = {
  list: async port => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json(),
  connect: (port, targetId) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    const timer = setTimeout(() => { socket.close(); reject(new Error('Timed out connecting to the test instance.')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(wrap(socket)); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to the test instance.')); }, { once: true });
  }),
};
