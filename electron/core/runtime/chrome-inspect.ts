import type { AppOpener, Clipboard } from './ports';

/** shell.openExternal refuses chrome:// URLs, so copy the address and ask macOS to open Chrome's inspect page directly. */
export async function inspectCdp(port: number, deps: { clipboard: Clipboard; openApp: AppOpener; platform: string }) {
  const address = `127.0.0.1:${port}`;
  deps.clipboard.writeText(address);
  const opened = deps.platform === 'darwin' && await deps.openApp('Google Chrome', 'chrome://inspect/#devices');
  return { address, opened };
}
