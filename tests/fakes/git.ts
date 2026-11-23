// Fake adapters for electron/core/git: scripted git, in-memory state, path-only files, manual .git watcher.
import type { GitDirWatcher, GitRunner, StateRepository, WatchHandle, WorkspaceFiles } from '../../electron/core/git';
import type { Hasher } from '../../electron/core/shared/ports';
import type { State } from '../../shared/contracts/git';

export type GitCall = { cwd: string; args: string[]; options?: { timeout?: number; maxBuffer?: number } };
/** `script` returns stdout, or undefined to fail the call like a git error. */
export function scriptedGit(script: (cwd: string, args: string[]) => string | undefined): GitRunner & { calls: GitCall[] } {
  const calls: GitCall[] = [];
  const run = (async (cwd, args, options) => {
    calls.push({ cwd, args, options });
    const out = script(cwd, args);
    if (out === undefined) throw new Error('Git operation failed. Check the repository, branch, and worktree on disk. No force operation was attempted.');
    return out;
  }) as GitRunner & { calls: GitCall[] };
  run.calls = calls;
  return run;
}
export function memoryState(initial: State): StateRepository & { saved: State[] } {
  let current = structuredClone(initial);
  const saved: State[] = [];
  return { saved, async load() { return structuredClone(current); }, async save(state) { current = structuredClone(state); saved.push(structuredClone(state)); } };
}
export const pathOnlyFiles: WorkspaceFiles = { realpath: async p => p, mkdirp: async () => {}, mkdirExclusive: async () => {}, isDirectory: async () => false };
/** Deterministic, non-cryptographic: 64 hex chars. */
export const fakeHasher: Hasher = { sha256: text => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0; return h.toString(16).padStart(8, '0').repeat(8); } };
export function manualWatcher(dirs = { gitDir: '/repo/.git', common: '/repo/.git' }) {
  const handles: { common: string; onChange: (f: string) => void; closed: boolean }[] = [];
  const watcher: GitDirWatcher = {
    gitDirs: async () => dirs,
    watch(common, onChange) {
      const entry = { common, onChange, closed: false };
      handles.push(entry);
      const handle: WatchHandle = { close: () => { entry.closed = true; }, on: () => handle };
      return handle;
    },
  };
  return { watcher, handles, change: (filename: string) => { for (const h of handles) if (!h.closed) h.onChange(filename); } };
}
