// The agent hook socket: a private Unix socket in a 0700 temp dir. Frames newline-delimited JSON with strict size, rate
// and lease limits and hands each parsed value to core. One bad event never stops the server (rule 1). No payloads are logged.
import { createServer, type Socket } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ActivityService } from '../../../core/activity';

export interface ActivitySocket { directory: string; endpoint: string; close(): Promise<void> }

export async function startActivitySocket(core: Pick<ActivityService, 'openSession'>,
  options: { leaseMs: number; log?: (message: string, error?: unknown) => void }): Promise<ActivitySocket> {
  const log = options.log ?? ((message, error) => console.error(message, error));
  // macOS AF_UNIX paths are short; os.tmpdir() can exceed their limit.
  const directory = await mkdtemp('/tmp/stingray-activity-');
  const sockets = new Set<Socket>();
  const server = createServer(socket => accept(socket));
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await chmod(directory, 0o700);
    const endpoint = path.join(directory, 'events.sock');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => { server.off('error', reject); resolve(); });
    });
    await chmod(endpoint, 0o600);
    server.on('error', () => { for (const socket of sockets) socket.destroy(); });
    return { directory, endpoint, close };
  } catch (error) { await close(); throw error; }

  function accept(socket: Socket) {
    let session: ReturnType<typeof core.openSession>;
    try { session = core.openSession({ end: () => socket.end(), destroy: () => socket.destroy(), get destroyed() { return socket.destroyed; } }); }
    catch (error) { log('Activity accept failed:', error instanceof Error ? error.message : 'error'); socket.destroy(); return; }
    if (!session) { socket.destroy(); return; }
    const opened = session;
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let windowStart = Date.now(), count = 0;
    // Absolute authentication/valid-frame deadlines: partial-byte drips must not keep a slot or a Working state alive.
    let deadline = setTimeout(() => socket.destroy(), 2000);
    const renewLease = () => { clearTimeout(deadline); deadline = setTimeout(() => socket.destroy(), options.leaseMs); };
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(deadline); sockets.delete(socket);
      try { opened.closed(); } catch (error) { log('Activity close failed:', error instanceof Error ? error.message : 'error'); }
    });
    socket.on('data', chunk => {
      // Strictly bound even an unterminated line, before parsing untrusted JSON.
      if (buffer.length + chunk.length > 8192) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      let end: number;
      while (!socket.destroyed && (end = buffer.indexOf(10)) !== -1) {
        if (end > 1024) { socket.destroy(); return; }
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); count = 0; }
        if (++count > 100) { socket.destroy(); return; }
        let value: unknown;
        try { value = JSON.parse(line.toString('utf8')); } catch { socket.destroy(); return; }
        let outcome;
        try { outcome = opened.message(value); } catch (error) { log('Activity event failed:', error instanceof Error ? error.message : 'error'); socket.destroy(); return; }
        if (outcome === 'stop') return;
        if (outcome === 'renew') renewLease();
      }
      if (buffer.length > 1024) socket.destroy();
    });
  }
}
