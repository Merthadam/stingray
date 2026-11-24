import type { DesktopAPI } from '../../shared/contracts';

export class BridgeMissingError extends Error {
  name = 'BridgeMissingError';
  constructor() { super('Stingray desktop bridge is missing: the preload script did not load. Check the main-process log.'); }
}

/** Plain browser: demo. Inside Electron: the preload bridge; `?demo` only in a dev renderer build; no bridge is an error. */
export function pickApi(o: { bridge?: DesktopAPI; userAgent: string; search: string; dev: boolean; loadDemo: () => Promise<DesktopAPI> }): Promise<DesktopAPI> {
  if (!o.userAgent.includes('Electron')) return o.loadDemo();
  if (o.dev && new URLSearchParams(o.search).has('demo')) return o.loadDemo();
  if (o.bridge) return Promise.resolve(o.bridge);
  throw new BridgeMissingError();
}
