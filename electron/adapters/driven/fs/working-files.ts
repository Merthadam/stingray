import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { repoPathSchema } from '../../../../shared/contracts/git';
import type { WorkingFiles } from '../../../core/repo-map';

const maxBytes = 512 * 1024;

// Never follow repository symlinks, including symlinked parent directories.
// This is a read-only viewer, not a general filesystem API.
export async function readWorkingFile(root: string, relative: string, openFile: typeof open = open): Promise<Buffer | null> {
  repoPathSchema.parse(relative);
  const base = await realpath(root);
  let current = base;
  const validated: { path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }[] = [];
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Symlink contents are not opened by the inspector.');
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('The file’s parent is not a directory.');
    validated.push({ path: current, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(base + path.sep)) throw new Error('The file is outside this workspace.');
  const file = await openFile(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const expected = validated.at(-1)!;
    if (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size !== expected.size || stat.mtimeMs !== expected.mtimeMs || stat.ctimeMs !== expected.ctimeMs) throw new Error('File changed before it could be opened safely.');
    // O_NOFOLLOW alone only protects the final component. Check the opened
    // descriptor against the validated identity and recheck every ancestor
    // before reading any bytes. A swapped parent cannot redirect this fd.
    for (const entry of validated) {
      const now = await lstat(entry.path);
      if (now.isSymbolicLink() || now.dev !== entry.dev || now.ino !== entry.ino) throw new Error('File ancestry changed before it could be opened safely.');
    }
    if (await realpath(current) !== resolved) throw new Error('File ancestry changed before it could be opened safely.');
    if (!stat.isFile()) throw new Error('Directories and submodules cannot be opened as files.');
    if (stat.size > maxBytes) throw new Error('File exceeds the 512 KiB inspector limit.');
    // A bounded read also protects against a file growing after stat().
    const bytes = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > maxBytes) throw new Error('File exceeds the 512 KiB inspector limit.');
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('File changed during read. Refresh and try again.');
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export const nodeWorkingFiles: WorkingFiles = {
  realpath: p => realpath(p),
  read: (root, relative) => readWorkingFile(root, relative),
  async probe(root, relative) {
    try { const stat = await lstat(path.join(root, relative)); return stat.isFile() && stat.size === 0 ? 'emptyFile' : 'other'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other'; }
  },
};
