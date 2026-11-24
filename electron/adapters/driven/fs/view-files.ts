// Real worktree files behind the views core's ViewFiles port: defensive reads (no symlinks, regular files, size-capped)
// the exclusive create used by "Save as view…" and the replace used by "Describe…".
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MAX_VIEW_FILE_BYTES, type ViewFiles } from '../../../core/views';

export const nodeViewFiles: ViewFiles = {
  async kind(root, rel) { const s = await lstat(path.join(root, rel)); return s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other'; },
  readBounded: (root, rel, label) => readBounded(path.join(root, rel), label),
  list: async (root, relDir) => (await readdir(path.join(root, relDir), { withFileTypes: true })).map(d => ({ name: d.name, directory: d.isDirectory() })),
  mkdir: async (root, relDir) => { await mkdir(path.join(root, relDir)); },
  async createExclusive(root, rel, text) {
    const file = path.join(root, rel);
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(text); } catch (error) {
      await handle.close(); await unlink(file).catch(() => {}); // a partial file would block every retry
      throw error;
    }
    await handle.close();
  },
  async replace(root, rel, text) {
    const file = path.join(root, rel);
    if (!(await lstat(file)).isFile()) throw new Error(`${rel} must be a regular file (symlinks are not followed)`);
    const temp = `${file}.${process.pid}.tmp`; // not *.yaml: never listed as a view
    await unlink(temp).catch(() => {}); // left over from a crash
    await nodeViewFiles.createExclusive(root, path.relative(root, temp), text);
    try { await rename(temp, file); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  },
  relative: (root, relFile) => path.relative(root, path.resolve(root, relFile)).split(path.sep).join('/'),
};

/** Text of a regular, ≤ 64 KiB file, or the reason it cannot be used. Throws ENOENT when missing. */
async function readBounded(file: string, label: string): Promise<{ text: string } | { error: string }> {
  const notRegular = { error: `${label} must be a regular file (symlinks are not followed)` }, tooBig = { error: `${label} is larger than 64 KiB` };
  let stat = await lstat(file);
  if (!stat.isFile()) return notRegular;
  if (stat.size > MAX_VIEW_FILE_BYTES) return tooBig;
  // O_NOFOLLOW/O_NONBLOCK guard against a symlink or FIFO swapped in after lstat.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    stat = await handle.stat();
    if (!stat.isFile()) return notRegular;
    if (stat.size > MAX_VIEW_FILE_BYTES) return tooBig;
    // Read at most cap+1 bytes: a file growing after fstat must not bypass the cap.
    const buffer = Buffer.alloc(MAX_VIEW_FILE_BYTES + 1);
    let length = 0;
    for (let n; length < buffer.length && (n = (await handle.read(buffer, length, buffer.length - length, length)).bytesRead) > 0;) length += n;
    if (length > MAX_VIEW_FILE_BYTES) return tooBig;
    return { text: buffer.subarray(0, length).toString('utf8') };
  } finally { await handle.close(); }
}
