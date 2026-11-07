import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoPathSchema, type FileInspection, type GitStatus, type RepoFile, type RepoSnapshot, type LineStats, type SnapshotHint } from '../src/shared';
import { git } from './git';
import { measureSizes } from './repo-map-size';

const exec = promisify(execFile);
const maxBytes = 512 * 1024;
const maxFiles = 100000;

export async function inventoryGit(root: string, args: string[]) {
  try {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root, timeout: 15000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch { throw new Error('Repository inventory exceeds the 16 MiB / 15 second limit, or Git is unavailable.'); }
}

export function parseNumstat(output: string): Map<string, LineStats | null> {
  const records = output.split('\0');
  const result = new Map<string, LineStats | null>();
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const first = record.indexOf('\t'); const second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const added = record.slice(0, first); const removed = record.slice(first + 1, second);
    let file = record.slice(second + 1);
    if (!file) { i++; file = records[++i]; } // -z rename: empty path, old path, new path
    const valid = /^\d+$/.test(added) && /^\d+$/.test(removed) && Number.isSafeInteger(Number(added)) && Number.isSafeInteger(Number(removed));
    if (file) result.set(file, valid ? { added: Number(added), removed: Number(removed) } : null);
  }
  return result;
}

export async function repoSnapshot(root: string, status: GitStatus, withStats = true, hint?: SnapshotHint): Promise<RepoSnapshot> {
  const listed = await inventoryGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const paths = new Set(listed.split('\0').filter(Boolean));
  // Staged deletions are no longer in the index, but must remain navigable.
  for (const change of status.changes) paths.add(change.path);
  if (paths.size > maxFiles) throw new Error('This repository exceeds the map limit of 100,000 files.');
  const changes = new Map<string, RepoFile>();
  for (const change of status.changes) {
    const previous = changes.get(change.path);
    if (previous && ((previous.status === 'D ' && change.status === '??') || (previous.status === '??' && change.status === 'D '))) {
      changes.set(change.path, { ...change, status: 'D?', untrackedReplacement: true, lineNotice: 'Staged deletion + untracked replacement; counts include both Git entries.' });
    } else changes.set(change.path, { ...change });
  }
  const files: RepoFile[] = [...paths].sort().map(file => ({ ...(changes.get(file) || { path: file, status: '' }) }));
  if (!withStats) return { ...status, files };
  let counts = new Map<string, LineStats | null>();
  let unborn = false; let failed = false;
  try {
    // A missing HEAD is expected only on an unborn branch. Other failures keep
    // counts unknown rather than silently treating every file as newly added.
    try { await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']); } catch {
      const branch = (await git(root, ['symbolic-ref', '-q', 'HEAD'])).trim();
      if (!branch.startsWith('refs/heads/')) throw new Error('HEAD unavailable');
      // Check this exact branch, not all refs: an orphan branch may coexist
      // with other branches/tags. Only exit 1 means absent; corrupt refs and
      // timeouts must remain errors, not turn tracked files into additions.
      try {
        await exec('git', ['show-ref', '--verify', '--quiet', branch], {
          cwd: root, timeout: 10000, maxBuffer: 4096,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        });
      } catch (error) {
        if ((error as { code?: number }).code === 1) unborn = true;
        else throw error;
      }
      if (!unborn) throw new Error('HEAD unavailable');
    }
    if (!unborn) counts = parseNumstat(await inventoryGit(root, ['diff', 'HEAD', '--numstat', '-z', '--find-renames', '-l1000', '--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short', '--']));
  } catch { failed = true; }
  // A staged rename can become a delete/add in the net diff after heavy
  // unstaged edits. Keep the old-path removals on its destination tile when
  // the source no longer has its own inventory entry.
  for (const file of files) {
    if (!file.originalPath || paths.has(file.originalPath) || !counts.has(file.originalPath)) continue;
    const source = counts.get(file.originalPath);
    const target = counts.get(file.path);
    counts.set(file.path, source === null || target === null ? null : {
      added: (source?.added || 0) + (target?.added || 0), removed: (source?.removed || 0) + (target?.removed || 0),
    });
  }
  for (const file of files) {
    if (!file.status) { file.lines = { added: 0, removed: 0 }; continue; }
    if (file.status.includes('U') || ['AA', 'DD'].includes(file.status)) {
      file.lines = null; file.lineNotice = 'Unresolved conflict';
    } else if (file.status === '??' || unborn) file.lines = null;
    else if (failed) { file.lines = null; file.lineNotice = 'Git line counts unavailable'; }
    else { file.lines = counts.get(file.path) ?? (counts.has(file.path) ? null : { added: 0, removed: 0 }); if (file.lines === null) file.lineNotice = 'Binary file'; }
  }
  const sizes = await measureSizes(root, files, hint, unborn);
  const unknown = files.filter(file => file.status && file.lines == null).length;
  return { ...status, files, ...sizes, statsNotice: unknown ? `${unknown} changed file(s) have unavailable line counts; totals include known counts only.` : '' };
}

async function boundedGit(root: string, args: string[]) {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, timeout: 10000, maxBuffer: maxBytes, encoding: 'buffer',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}
function decode(data: Buffer): string | null {
  if (data.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return null; }
}

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

export async function inspectFile(root: string, relative: string, snapshot: RepoSnapshot): Promise<FileInspection> {
  repoPathSchema.parse(relative);
  const entry = snapshot.files.find(file => file.path === relative);
  if (!entry) throw new Error('File is not in this workspace’s Git inventory. Refresh the map.');
  const result: FileInspection = { path: relative, content: null, source: 'working tree', staged: '', unstaged: '', notice: '', revision: '' };
  let bytes: Buffer | null;
  try { bytes = await readWorkingFile(root, relative); } catch (error) {
    result.notice = (error as Error).message;
    // Do not run diff on symlinks, special files or unbounded files either.
    return finish(result);
  }
  if (bytes === null) {
    // A staged deletion is absent from the index; an unstaged deletion may
    // still have newly added/staged contents there. Preserve that distinction.
    const source = entry.status[0] === 'D' ? 'HEAD' : 'index';
    try {
      bytes = await boundedGit(root, ['show', source === 'HEAD' ? `HEAD:${relative}` : `:${relative}`]);
      result.source = source;
      result.notice = `Deleted file · showing ${source} contents.`;
    } catch {
      result.notice = 'File is unavailable or exceeds the 512 KiB inspector limit. Refresh and try again.';
      return finish(result);
    }
  }
  result.content = decode(bytes);
  if (result.content === null) {
    result.notice = 'Binary or non-UTF-8 file. Text inspection is unavailable.';
    return finish(result);
  }
  if (entry.status === '??' || entry.untrackedReplacement) {
    const lines = result.content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    result.unstaged = `--- /dev/null\n+++ ${relative}\n@@ -0,0 +${lines.length ? 1 : 0},${lines.length} @@\n` + lines.map(line => '+' + line).join('\n');
    if (result.content && !result.content.endsWith('\n')) result.unstaged += '\n\\ No newline at end of file';
    if (entry.untrackedReplacement) {
      try { result.staged = (await boundedGit(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--', `:(literal)${relative}`])).toString('utf8'); }
      catch { result.notice = 'Staged deletion diff unavailable (512 KiB limit or Git error).'; }
    }
  } else if (entry.status) {
    // Literal pathspecs handle brackets, wildcard names and leading hyphens.
    // Disable repository-configured external diff and textconv executables.
    const paths = [...new Set([relative, ...(entry.originalPath ? [entry.originalPath] : [])])].map(p => `:(literal)${p}`);
    const options = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--submodule=short'];
    try {
      const [staged, unstaged] = await Promise.all([
        boundedGit(root, ['diff', '--cached', ...options, '--', ...paths]),
        boundedGit(root, ['diff', ...options, '--', ...paths]),
      ]);
      result.staged = staged.toString('utf8'); result.unstaged = unstaged.toString('utf8');
    } catch {
      result.notice = 'Diff unavailable (512 KiB limit or Git error). File contents are still available.';
    }
  }
  return finish(result);
}
function finish(result: FileInspection) {
  result.revision = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return result;
}
