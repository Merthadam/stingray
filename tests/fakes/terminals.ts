import type { LinkTargets, MirrorFactory, PtyProcess, PtySpawner, TerminalMirrorPort } from '../../electron/core/terminals';

export class FakePty implements PtyProcess {
  written: string[] = []; killed = false; pauses = 0; resumes = 0;
  private data = new Set<(d: string) => void>(); private exit = new Set<(e: { exitCode: number }) => void>();
  constructor(readonly pid: number, readonly env: Record<string, string>) {}
  onData(l: (d: string) => void) { this.data.add(l); }
  onExit(l: (e: { exitCode: number }) => void) { this.exit.add(l); }
  write(d: string) { this.written.push(d); }
  resize() {}
  kill() { this.killed = true; }
  pause() { this.pauses++; }
  resume() { this.resumes++; }
  emit(d: string) { for (const l of this.data) l(d); }
  exitWith(exitCode: number) { for (const l of this.exit) l({ exitCode }); }
}
export function fakeSpawner(env: Record<string, string> = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', STINGRAY_DATA_DIR: '/x', NODE_OPTIONS: '--x' }) {
  const processes: FakePty[] = [];
  const spawner: PtySpawner = { shell: () => '/bin/zsh', env: () => env, spawn: (_file, _args, o) => { const p = new FakePty(1000 + processes.length, o.env); processes.push(p); return p; } };
  return { spawner, processes };
}
export class FakeMirror implements TerminalMirrorPort {
  data = ''; sequence = 0; disposed = false; private pending: (() => void)[] = [];
  write(d: string, sequence: number, done?: () => void) { this.data += d; this.sequence = sequence; if (done) this.pending.push(done); }
  resize() {}
  async snapshot() { return { data: this.data, sequence: this.sequence }; }
  dispose() { this.disposed = true; }
  drain() { for (const done of this.pending.splice(0)) done(); }
}
export function fakeMirrors() {
  const mirrors: FakeMirror[] = [];
  const factory: MirrorFactory = () => { const m = new FakeMirror(); mirrors.push(m); return m; };
  return { factory, mirrors };
}
/** A workspace folder map: real targets by absolute path. */
export function fakeLinkTargets(files: Record<string, { isFile: boolean; isDirectory: boolean; mode: number }>, root = '/ws'): LinkTargets {
  return {
    resolveUrl: (input, workspace) => new URL(input, `file://${workspace}/`),
    realTarget: async url => { const target = decodeURIComponent(url.pathname); if (!(target in files) && target !== root) throw new Error('ENOENT'); return { target, inside: target.startsWith(root + '/') }; },
    stat: async target => files[target] ?? (() => { throw new Error('ENOENT'); })(),
  };
}
