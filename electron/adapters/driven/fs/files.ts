// Defensive worktree file provider for the engine: lists regular files through walk.ts (no symlinks, generated/vendored dirs skipped)
// and reads them like view-file.ts (O_NOFOLLOW, fstat, bounded read).
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { FileProvider } from '../../../core/views';
import { walkFiles } from './walk';

export { MAX_FILES } from './walk';
export const MAX_SOURCE_BYTES = 1024 * 1024;

/** A worktree-relative POSIX path that cannot leave the worktree, or null. */
const relative = (file: string) => {
  if (!file || file.includes('\\') || file.includes('\0') || path.posix.isAbsolute(file)) return null;
  return file.split('/').includes('..') ? null : file;
};

export function createFileProvider(root: string): FileProvider {
  return {
    async list(keep = () => true) {
      // Views stay silent on unreadable directories and an unreadable root, as before.
      try { return await walkFiles(root, { keep }); } catch { return { files: [], truncated: false }; }
    },
    async read(file) {
      const rel = relative(file);
      if (!rel) return null;
      const full = path.join(root, rel);
      try {
        // O_NOFOLLOW only guards the last component; a symlinked parent directory must not lead out of the worktree.
        const [base, parent] = await Promise.all([realpath(root), realpath(path.dirname(full))]);
        if (parent !== base && !parent.startsWith(base + path.sep)) return null;
        const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null;
          // Read at most cap+1 bytes: a file growing after fstat must not bypass the cap.
          const buffer = Buffer.alloc(Math.min(stat.size, MAX_SOURCE_BYTES) + 1);
          let length = 0;
          for (let n; length < buffer.length && (n = (await handle.read(buffer, length, buffer.length - length, length)).bytesRead) > 0;) length += n;
          return length > MAX_SOURCE_BYTES ? null : buffer.subarray(0, length).toString('utf8');
        } finally { await handle.close(); }
      } catch { return null; }
    },
  };
}
