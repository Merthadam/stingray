import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Absolute real path of a regular file inside the worktree; rejects absolute paths, `..`, and symlinks leading outside. */
export async function resolveSource(root: string, file: string): Promise<string> {
  const invalid = () => new Error('Choose a regular file inside this worktree.');
  if (!file || file.includes('\0') || file.includes('\\') || path.posix.isAbsolute(file) || file.split('/').some(p => p === '..')) throw invalid();
  let realRoot, target;
  try { realRoot = await realpath(root); target = await realpath(path.join(realRoot, file)); } catch { throw new Error('The file is unavailable.'); }
  const relative = path.relative(realRoot, target);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw invalid();
  if (!(await stat(target)).isFile()) throw invalid();
  return target;
}
