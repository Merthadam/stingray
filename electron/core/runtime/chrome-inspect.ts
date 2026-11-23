import { execFile } from 'node:child_process';
import { clipboard } from 'electron';

/** shell.openExternal refuses chrome:// URLs, so copy the address and ask macOS to open Chrome's inspect page directly. */
export async function inspectCdp(port: number) {
  const address = `127.0.0.1:${port}`;
  clipboard.writeText(address);
  const opened = process.platform === 'darwin' && await new Promise<boolean>(resolve =>
    execFile('/usr/bin/open', ['-a', 'Google Chrome', 'chrome://inspect/#devices'], { timeout: 5000 }, error => resolve(!error)));
  return { address, opened };
}
