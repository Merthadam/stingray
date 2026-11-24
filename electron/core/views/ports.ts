import type { DbSchemaResult } from '../../../shared/contracts/db-schema';
import type { ViewLocalState, ViewsChangedEvent } from '../../../shared/contracts/views';
import type { FileProvider } from './rules/types';

/** Worktree files the views core reads and writes; paths are worktree-relative POSIX. Errors keep their fs `code`. */
export interface ViewFiles {
  /** lstat kind; rejects (code ENOENT/ENOTDIR) when missing. */
  kind(root: string, rel: string): Promise<'directory' | 'file' | 'other'>;
  /** Text of a regular file ≤ 64 KiB, or the reason it cannot be used (symlinks never followed); rejects (ENOENT) when missing. */
  readBounded(root: string, rel: string, label: string): Promise<{ text: string } | { error: string }>;
  /** Entries of a directory; rejects when missing. */
  list(root: string, relDir: string): Promise<{ name: string; directory: boolean }[]>;
  mkdir(root: string, relDir: string): Promise<void>;
  /** Exclusive create (O_EXCL | O_NOFOLLOW, 0644) and write; a partial file is removed; rejects with code EEXIST when present. */
  createExclusive(root: string, rel: string, text: string): Promise<void>;
  /** Replace an existing regular file's text (a temp file renamed over it, so a failed write never truncates it). */
  replace(root: string, rel: string, text: string): Promise<void>;
  /** `relFile` resolved against `root`, as a POSIX path relative to `root` ('..'-prefixed or absolute when outside). */
  relative(root: string, relFile: string): string;
}
export interface ViewStateRepository {
  get(workspaceId: string, viewId: string): Promise<ViewLocalState | null>;
  set(workspaceId: string, viewId: string, state: ViewLocalState): Promise<void>;
  forget(workspaceId: string): Promise<void>;
}
export type ViewsPublisher = (event: ViewsChangedEvent) => void;
export type FileProviderFactory = (root: string) => FileProvider;
/** SQLAlchemy and SQL schema of a worktree (the worker process in the app, in-process in tests and the CLI). */
export interface DbSchemaSource {
  dbSchema(workspaceId: string, root: string): Promise<DbSchemaResult>;
  sqlSchema(workspaceId: string, root: string): Promise<DbSchemaResult>;
}
