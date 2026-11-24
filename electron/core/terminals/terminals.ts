import type { TerminalInfo, TerminalSnapshot } from '../../../shared/contracts/terminals';
import type { ActivityService, ShellIntegration } from '../activity';
import type { MirrorFactory, PtyProcess, PtySpawner, TerminalMirrorPort, TerminalPublisher } from './ports';

/** PATH with `dir` first and no other copy of it; unchanged when `dir` is empty. */
export const prependPath = (value: string | undefined, dir: string) =>
  dir ? [dir, ...(value ?? '').split(':').filter(p => p && p !== dir)].join(':') : value ?? '';

// Flow control (audit 9): bytes queued in the headless mirror per terminal.
const HIGH = 1024 * 1024, LOW = 256 * 1024, STUCK_MS = 5000;
type Entry = TerminalInfo & { process: PtyProcess; mirror: TerminalMirrorPort; exitCode?: number; queued: number; paused: boolean };
export interface TerminalsDeps { send: TerminalPublisher; pty: PtySpawner; mirrors: MirrorFactory; activity?: ActivityService; shell?: ShellIntegration }

export class Terminals {
  private entries = new Map<string, Entry>();
  private created = 0; // titles are never reused
  viewsBin = ''; // directory of the `stingray-views` launcher, set by main once installed
  constructor(private deps: TerminalsDeps) {}
  list(): TerminalInfo[] {
    return [...this.entries.values()].map(({ process: _, mirror: __, exitCode: ___, queued: ____, paused: _____, ...info }) => info);
  }
  portRoots() {
    return [...this.entries.values()].filter(t => !t.exited).map(t => ({ id: t.id, workspaceId: t.workspaceId, title: t.title, pid: t.process.pid }));
  }
  hasWorkspace(id: string) { return this.countWorkspace(id) > 0; }
  countWorkspace(id: string) { return [...this.entries.values()].filter(t => t.workspaceId === id).length; }
  closeWorkspace(id: string) { for (const [key, t] of this.entries) if (t.workspaceId === id) this.close(key); }
  create(workspaceId: string, cwd: string): TerminalInfo {
    if (this.entries.size >= 24) throw new Error('Close a terminal before opening another (limit 24).');
    const shell = this.deps.pty.shell();
    // Do not pass Electron's control environment into child shells.
    const env = Object.fromEntries(Object.entries(this.deps.pty.env()).filter(([key, value]) =>
      value !== undefined && !key.startsWith('ELECTRON_') && !key.startsWith('STINGRAY_') && key !== 'NODE_OPTIONS')) as Record<string, string>;
    if (this.viewsBin) env.PATH = prependPath(env.PATH, this.viewsBin);
    const id = globalThis.crypto.randomUUID();
    const shellEnv = this.deps.shell?.environment(shell, env) ?? {};
    const attached = Boolean(shellEnv.ZDOTDIR && this.deps.activity?.endpoint);
    const activityEnv = attached ? this.deps.activity!.bind(id, workspaceId) : {};
    let child: PtyProcess;
    try {
      child = this.deps.pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: { ...env, ...shellEnv, ...activityEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
    } catch (error) { this.deps.activity?.unbind(id, true); throw error; }
    const entry: Entry = { id, workspaceId, title: 'Terminal ' + ++this.created, exited: false, sequence: 0, cols: 100, rows: 30,
      piTracking: attached ? 'available' : 'unavailable', process: child, mirror: this.deps.mirrors(100, 30), queued: 0, paused: false };
    this.entries.set(entry.id, entry);
    child.onData(data => {
      if (this.entries.get(entry.id) !== entry) return; // closed
      entry.queued += data.length;
      entry.mirror.write(data, ++entry.sequence, () => {
        entry.queued -= data.length;
        if (entry.paused && entry.queued < LOW) { entry.paused = false; child.resume(); }
      });
      if (!entry.paused && entry.queued > HIGH) {
        entry.paused = true; child.pause();
        // Safety net: if the mirror loses write callbacks (e.g. a later parse error), never leave the PTY paused for good.
        setTimeout(() => { if (entry.paused && this.entries.get(entry.id) === entry) { entry.paused = false; entry.queued = 0; child.resume(); } }, STUCK_MS);
      }
      this.deps.send({ id: entry.id, data, sequence: entry.sequence });
    });
    child.onExit(({ exitCode }) => {
      entry.exited = true; entry.exitCode = exitCode; this.deps.activity?.unbind(entry.id); this.deps.send({ id: entry.id, exitCode });
    });
    const { process: _, mirror: __, queued: ___, paused: ____, ...info } = entry; return info;
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
  close(id: string) { const t = this.get(id); this.deps.activity?.unbind(id, true); if (!t.exited) t.process.kill(); t.mirror.dispose(); this.entries.delete(id); }
  closeAll() { for (const id of this.entries.keys()) this.close(id); }
}
