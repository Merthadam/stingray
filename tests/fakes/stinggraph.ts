import type { GraphReleaseHost } from '../../electron/core/stinggraph';

export function fakeReleaseHost(o: { closeFails?: boolean; killFails?: boolean } = {}): GraphReleaseHost & { closed: string[]; kills: number } {
  const host = { closed: [] as string[], kills: 0,
    async close(id: string) { host.closed.push(id); if (o.closeFails) throw new Error('close failed'); },
    async kill() { host.kills++; if (o.killFails) throw new Error('kill failed'); } };
  return host;
}
