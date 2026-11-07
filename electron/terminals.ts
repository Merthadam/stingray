import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { TerminalEvent, TerminalInfo } from '../src/shared';

type Entry = TerminalInfo & { process: pty.IPty };
export class Terminals {
  private entries = new Map<string, Entry>();
  constructor(private send: (event: TerminalEvent) => void) {}
  list(): TerminalInfo[] {
    return [...this.entries.values()].map(({ process: _, ...info }) => info);
  }
  portRoots() {
    return [...this.entries.values()].filter(t => !t.exited).map(t => ({ id: t.id, workspaceId: t.workspaceId, title: t.title, pid: t.process.pid }));
  }
  hasWorkspace(id: string) { return [...this.entries.values()].some(t => t.workspaceId === id); }
  create(workspaceId: string, cwd: string): TerminalInfo {
    if (this.entries.size >= 24) throw new Error('Close a terminal before opening another (limit 24).');
    const shell = os.userInfo().shell || '/bin/zsh';
    // Do not pass Electron's control environment into child shells.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
      value !== undefined && !key.startsWith('ELECTRON_') && !key.startsWith('STINGRAY_') && key !== 'NODE_OPTIONS')) as Record<string, string>;
    const child = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
    const entry: Entry = { id: randomUUID(), workspaceId, title: 'Terminal ' + (this.entries.size + 1), exited: false, buffer: '', sequence: 0, process: child };
    this.entries.set(entry.id, entry);
    child.onData(data => {
      entry.buffer = (entry.buffer + data).slice(-128 * 1024);
      this.send({ id: entry.id, data, sequence: ++entry.sequence });
    });
    child.onExit(({ exitCode }) => { entry.exited = true; this.send({ id: entry.id, exitCode }); });
    const { process: _, ...info } = entry; return info;
  }
  private get(id: string) { const t = this.entries.get(id); if (!t) throw new Error('Terminal not found.'); return t; }
  write(id: string, data: string) { const t = this.get(id); if (t.exited) throw new Error('This terminal has exited. Open a new one.'); t.process.write(data); }
  resize(id: string, cols: number, rows: number) { const t = this.get(id); if (!t.exited) t.process.resize(cols, rows); }
  close(id: string) { const t = this.get(id); if (!t.exited) t.process.kill(); this.entries.delete(id); }
  closeAll() { for (const id of this.entries.keys()) this.close(id); }
}
