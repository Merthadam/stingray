import type { State, WorkspaceGitState } from '../../../shared/contracts/git';

/** Bounded git returning stdout; rejects with a user-facing "Git operation failed…" message. */
export type GitRunner = (cwd: string, args: string[], options?: { timeout?: number; maxBuffer?: number }) => Promise<string>;
export interface WorkspaceFiles {
  realpath(path: string): Promise<string>;
  /** mkdir -p with this mode. */
  mkdirp(path: string, mode: number): Promise<void>;
  /** Exclusive mkdir: rejects when anything (file, empty dir, symlink) already exists. */
  mkdirExclusive(path: string, mode: number): Promise<void>;
  /** lstat says directory; false when missing or unreadable. */
  isDirectory(path: string): Promise<boolean>;
}
export interface StateRepository { load(): Promise<State>; save(state: State): Promise<void> }
export interface WatchHandle { close(): void; on(event: 'error', listener: (error: Error) => void): unknown }
export interface GitDirWatcher {
  /** `git rev-parse --git-dir --git-common-dir` as absolute paths; rejects when unreadable. */
  gitDirs(workspacePath: string): Promise<{ gitDir: string; common: string }>;
  /** Recursive watch of a common .git dir; filename is POSIX and relative ('' when unknown). Throws when unavailable. */
  watch(common: string, onChange: (filename: string) => void): WatchHandle;
}
export type PRRunner = (command: 'git' | 'gh', args: string[], cwd: string) => Promise<string>;
export type Cloner = (url: string, target: string, parent: string) => Promise<void>;
export type GitStatePublisher = (state: WorkspaceGitState) => void;
