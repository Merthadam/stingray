// The one worktree walker (audit 16): never follows symlinks, skips generated/vendored dirs, bounded, sorted output.
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** Union of the skip lists of the former views, db-schema and sql-schema walkers. */
export const SKIPPED_DIRS = new Set(['.git', '.codegraph', 'node_modules', 'dist', 'dist-electron', 'build', '.venv', 'venv', '__pycache__', '.next', 'target', 'site-packages']);
export const MAX_WALKED = 200_000, MAX_FILES = 5000;

export interface WalkOptions {
  keep(rel: string): boolean;
  /** Also skip every directory whose name starts with '.' (db-schema and sql-schema scanners). */
  skipDotDirs?: boolean;
  /** Directory entries visited before stopping (default 200 000; schema scanners pass 20 000). */
  maxEntries?: number;
  /** Kept files before stopping (default 5 000). */
  maxFiles?: number;
  onDirError?: (rel: string, error: Error) => void;
}

/** Throws when the root itself is unreadable. */
export async function walkFiles(root: string, options: WalkOptions): Promise<{ files: string[]; truncated: boolean }> {
  const { keep, skipDotDirs = false, maxEntries = MAX_WALKED, maxFiles = MAX_FILES, onDirError } = options;
  const files: string[] = [];
  let walked = 0;
  const walk = async (dir: string): Promise<boolean> => {
    let entries;
    try { entries = await readdir(path.join(root, dir), { withFileTypes: true }); } catch (error) {
      if (!dir) throw error;
      onDirError?.(dir, error as Error); return true;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (++walked > maxEntries) return false;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      // Dirent types come from lstat semantics: symlinks are neither files nor directories here.
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || (skipDotDirs && entry.name.startsWith('.'))) continue;
        if (!(await walk(rel))) return false;
      } else if (entry.isFile() && keep(rel)) {
        if (files.length >= maxFiles) return false;
        files.push(rel);
      }
    }
    return true;
  };
  const complete = await walk('');
  return { files: files.sort(), truncated: !complete };
}
