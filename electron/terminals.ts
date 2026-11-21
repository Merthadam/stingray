import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { TerminalEvent, TerminalInfo, TerminalSnapshot } from '../src/shared';
import { TerminalMirror } from './terminal-mirror';
import type { ActivityService } from './activity';
import type { ActivityShell } from './activity-shell';

/** PATH with `dir` first and no other copy of it; unchanged when `dir` is empty. */
export const prependPath = (value: string | undefined, dir: string) =>
  dir ? [dir, ...(value ?? '').split(':').filter(p => p && p !== dir)].join(':') : value ?? '';

type Entry = TerminalInfo & { process: pty.IPty; mirror: TerminalMirror; exitCode?: number };
export class Terminals {
  private entries = new Map<string, Entry>();
  viewsBin = ''; // directory of the `stingray-views` launcher, set by main once installed
  constructor(private send: (event: TerminalEvent) => void, private activity?: ActivityService, private activityShell?: ActivityShell) {}
  list(): TerminalInfo[] {
    return [...this.entries.values()].map(({ process: _, mirror: __, exitCode: ___, ...info }) => info);
  }
  portRoots() {
    return [...this.entries.values()].filter(t => !t.exited).map(t => ({ id: t.id, workspaceId: t.workspaceId, title: t.title, pid: t.process.pid }));
  }
  hasWorkspace(id: string) { return this.countWorkspace(id) > 0; }
  countWorkspace(id: string) { return [...this.entries.values()].filter(t => t.workspaceId === id).length; }
  closeWorkspace(id: string) { for (const [key, t] of this.entries) if (t.workspaceId === id) this.close(key); }
  create(workspaceId: string, cwd: string): TerminalInfo {
    if (this.entries.size >= 24) throw new Error('Close a terminal before opening another (limit 24).');
    const shell = os.userInfo().shell || '/bin/zsh';
    // Do not pass Electron's control environment into child shells.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
      value !== undefined && !key.startsWith('ELECTRON_') && !key.startsWith('STINGRAY_') && key !== 'NODE_OPTIONS')) as Record<string, string>;
    if (this.viewsBin) env.PATH = prependPath(env.PATH, this.viewsBin);
    const id = randomUUID();
    const shellEnv = this.activityShell?.environment(shell, env) ?? {};
    const attached = Boolean(shellEnv.ZDOTDIR && this.activity?.endpoint);
    const activityEnv = attached ? this.activity!.bind(id, workspaceId) : {};
    let child: pty.IPty;
    try {
      child = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: { ...env, ...shellEnv, ...activityEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
    } catch (error) { this.activity?.unbind(id, true); throw error; }
    const entry: Entry = { id, workspaceId, title: 'Terminal ' + (this.entries.size + 1), exited: false, sequence: 0, cols: 100, rows: 30, piTracking: attached ? 'available' : 'unavailable', process: child, mirror: new TerminalMirror(100, 30) };
    this.entries.set(entry.id, entry);
    child.onData(data => {
      entry.mirror.write(data, ++entry.sequence);
      this.send({ id: entry.id, data, sequence: entry.sequence });
    });
    child.onExit(({ exitCode }) => { entry.exited = true; entry.exitCode = exitCode; this.activity?.unbind(entry.id); this.send({ id: entry.id, exitCode }); });
    const { process: _, mirror: __, ...info } = entry; return info;
  }
  private get(id: string) { const t = this.entries.get(id); if (!t) throw new Error('Terminal not found.'); return t; }
  write(id: string, data: string) { const t = this.get(id); if (t.exited) throw new Error('This terminal has exited. Open a new one.'); t.process.write(data); }
  resize(id: string, cols: number, rows: number) {
    const t = this.get(id);
    if (t.exited || (t.cols === cols && t.rows === rows)) return;
    t.process.resize(cols, rows); t.mirror.resize(cols, rows); t.cols = cols; t.rows = rows;
  }
  /** Restorable state for a newly mounted pane; output after `sequence` arrives as terminal events. */
  async snapshot(id: string): Promise<TerminalSnapshot> {
    const t = this.get(id);
    const { data, sequence } = await t.mirror.snapshot();
    return { id, data, sequence, cols: t.cols ?? 100, rows: t.rows ?? 30, exitCode: t.exitCode };
  }
  close(id: string) { const t = this.get(id); this.activity?.unbind(id, true); if (!t.exited) t.process.kill(); t.mirror.dispose(); this.entries.delete(id); }
  closeAll() { for (const id of this.entries.keys()) this.close(id); }
}
