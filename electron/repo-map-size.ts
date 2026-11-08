import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoPathSchema, snapshotHintSchema, type FileSize, type RepoFile, type SnapshotHint } from '../src/shared';
import { inventoryGit, readWorkingFile } from './repo-map';

const ceiling = 512 * 1024;
type Cached = { identity: string; size: FileSize; absent: boolean };
const cache = new Map<string, Cached>();
const cursors = new Map<string, number>();
const locks = new Set<string>();
export function textLines(bytes: Buffer): number | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  if (!text) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines++;
  return lines + (text.endsWith('\n') ? 0 : 1);
}
// Bounded, no content retained. All identities are metadata heuristics, not
// atomic snapshots. Revalidate on both sides of each working-tree read.
async function metadata(root: string, relative: string) {
  repoPathSchema.parse(relative);
  let current = root;
  const chain: string[] = [];
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await lstat(current, { bigint: true }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { identity: 'absent', absent: true };
      throw e;
    }
    if (stat.isSymbolicLink()) throw new Error('Symlink contents are not measured');
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('Invalid parent directory');
    if (i === parts.length - 1 && !stat.isFile()) throw new Error('Directory, submodule or special file');
    chain.push(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
    if (i === parts.length - 1 && stat.size > BigInt(ceiling)) throw new Error('File exceeds 512 KiB');
  }
  const resolved = await realpath(current);
  if (!resolved.startsWith(root + path.sep)) throw new Error('File is outside workspace');
  return { identity: chain.join('/'), absent: false };
}
function batch(root: string, args: string[], ids: string[], max: number): Promise<Buffer> {
  if (!ids.length) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let bytes = 0; let failed = false;
    const fail = () => { failed = true; child.kill(); };
    const timer = setTimeout(fail, 15000);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > max) fail(); else chunks.push(chunk); });
    child.stderr.resume(); child.stdin.on('error', fail);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Historical size unavailable')); });
    child.on('close', code => { clearTimeout(timer); if (failed || code !== 0) reject(new Error('Historical size budget or Git error')); else resolve(Buffer.concat(chunks)); });
    child.stdin.end(ids.join('\n') + '\n');
  });
}
function remember(key: string, value: Cached) {
  cache.delete(key); cache.set(key, value);
  while (cache.size > 100000) cache.delete(cache.keys().next().value!);
}
export async function measureSizes(root: string, files: RepoFile[], hint?: SnapshotHint, unborn = false) {
  root = await realpath(root);
  // The service coalesces complete snapshots. Direct callers cannot create an
  // unbounded queue of retained inventories if a filesystem operation stalls.
  if (locks.has(root)) throw new Error('Size measurement already in progress');
  locks.add(root);
  try { return await measure(root, files, hint, unborn); } finally { locks.delete(root); }
}
// Interleave priority with fair work. Cursor positions are committed only for
// admitted groups, never for the selected-but-deadline-skipped tail.
export function sizeWork(files: RepoFile[], hint: SnapshotHint | undefined, cursor: number) {
  const priority = files.filter(file => file.path === hint?.file || hint?.scope !== undefined && (!hint.scope || file.path.startsWith(hint.scope + '/')));
  if (hint?.file) { const at = priority.findIndex(file => file.path === hint.file); if (at > 0) priority.unshift(...priority.splice(at, 1)); }
  const jobs: { file: RepoFile; cursor?: number }[] = [];
  const seen = new Set<string>(); let p = 0; let traversed = 0;
  while (jobs.length < 64 && traversed < files.length) {
    if (p < Math.min(32, priority.length)) {
      const file = priority[p++]; if (!seen.has(file.path)) { jobs.push({ file }); seen.add(file.path); }
    }
    // Skip duplicates but advance the fair cursor with the next admitted job.
    while (traversed < files.length && jobs.length < 64) {
      const file = files[cursor % files.length]; cursor++; traversed++;
      if (!seen.has(file.path)) { jobs.push({ file, cursor }); seen.add(file.path); break; }
    }
  }
  return jobs;
}
async function measure(root: string, files: RepoFile[], hint: SnapshotHint | undefined, unborn: boolean) {
  if (hint) snapshotHintSchema.parse(hint);
  const inventory = new Set(files.map(file => file.path));
  if (hint?.file && !inventory.has(hint.file)) throw new Error('Priority file is not in workspace inventory');
  if (hint?.scope && !files.some(file => file.path.startsWith(hint.scope + '/'))) throw new Error('Priority scope is not in workspace inventory');
  const prefix = root + '\0';
  for (const key of cache.keys()) if (key.startsWith(prefix) && !inventory.has(key.slice(prefix.length))) cache.delete(key);
  let cursor = cursors.get(root) || 0;
  const jobs = sizeWork(files, hint, cursor);
  const saveCursor = () => {
    cursors.delete(root); cursors.set(root, cursor % Math.max(1, files.length));
    while (cursors.size > 200) cursors.delete(cursors.keys().next().value!);
  };
  for (const file of files) {
    const old = cache.get(prefix + file.path);
    file.size = old ? { ...old.size, stale: true } : { state: 'pending', source: 'working tree', reason: 'Waiting for bounded size measurement' };
  }
  const start = Date.now(); let checked = 0; let read = 0; let bytes = 0;
  const missing: { file: RepoFile; source: 'HEAD' | 'index' }[] = [];
  const absent = new Set<string>();
  const save = (file: RepoFile, identity: string, size: FileSize, isAbsent = false) => {
    file.size = size; remember(prefix + file.path, { identity, size, absent: isAbsent });
  };
  for (let offset = 0; offset < jobs.length && Date.now() - start < 2000; offset += 4) {
    const admitted = jobs.slice(offset, offset + 4);
    for (const job of admitted) if (job.cursor !== undefined) cursor = job.cursor;
    saveCursor();
    await Promise.all(admitted.map(async ({ file }) => {
      checked++;
      try {
        const before = await metadata(root, file.path);
        if (before.absent) { absent.add(file.path); missing.push({ file, source: file.status[0] === 'D' ? 'HEAD' : 'index' }); return; }
        const old = cache.get(prefix + file.path);
        if (old?.identity === before.identity && old.size.source === 'working tree') { file.size = { ...old.size, stale: false }; return; }
        read++;
        const data = await readWorkingFile(root, file.path);
        bytes += data?.length || 0;
        if (!data || (await metadata(root, file.path)).identity !== before.identity) throw new Error('File changed during size measurement');
        const count = textLines(data);
        save(file, before.identity, count === null ? { state: 'unavailable', source: 'working tree', reason: 'Binary or non-UTF-8 file' } : { state: 'known', source: 'working tree', textLines: count });
      } catch (e) { save(file, '', { state: 'unavailable', source: 'working tree', reason: (e as Error).message }); }
    }));
  }
  // Resolve historical blobs once per source, using NUL-delimited inventories.
  // No path is interpolated into cat-file input; only verified object IDs.
  // Missing-file requests were already admitted with their metadata checks.
  // Finish their bounded historical reads even if the admission deadline has
  // elapsed; otherwise slow metadata could starve deletions indefinitely.
  if (missing.length) {
    try {
      const index = new Map<string, { mode: string; oid: string }>();
      const head = new Map<string, { mode: string; oid: string }>();
      if (missing.some(x => x.source === 'index')) for (const record of (await inventoryGit(root, ['ls-files', '--stage', '-z'])).split('\0')) {
        const match = /^(\d+) ([0-9a-f]{40,64}) 0\t([\s\S]+)$/.exec(record);
        if (match) index.set(match[3], { mode: match[1], oid: match[2] });
      }
      if (missing.some(x => x.source === 'HEAD')) for (const record of (await inventoryGit(root, ['ls-tree', '-r', '-z', 'HEAD'])).split('\0')) {
        const match = /^(\d+) \w+ ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record);
        if (match) head.set(match[3], { mode: match[1], oid: match[2] });
      }
      const pending: { file: RepoFile; source: 'HEAD' | 'index'; oid: string }[] = [];
      for (const { file, source } of missing) {
        const entry = (source === 'HEAD' ? head : index).get(file.path);
        if (!entry || !/^100/.test(entry.mode)) { save(file, '', { state: 'unavailable', source, reason: 'Historical text blob unavailable' }, true); continue; }
        const old = cache.get(prefix + file.path);
        if (old?.identity === entry.oid && old.size.source === source) file.size = { ...old.size, stale: false };
        else pending.push({ file, source, oid: entry.oid });
      }
      if (pending.length) {
        const info = (await batch(root, ['cat-file', '--batch-check'], pending.map(x => x.oid), 16384)).toString().trim().split('\n');
        const readable: typeof pending = [];
        pending.forEach((item, i) => {
          const [oid, type, size] = (info[i] || '').split(' ');
          if (oid === item.oid && type === 'blob' && Number(size) <= ceiling) readable.push(item);
          else save(item.file, item.oid, { state: 'unavailable', source: item.source, reason: 'Historical blob exceeds 512 KiB or is unavailable' }, true);
        });
        if (readable.length) {
          read += readable.length;
          const data = await batch(root, ['cat-file', '--batch'], readable.map(x => x.oid), readable.length * (ceiling + 128));
          let at = 0;
          for (const item of readable) {
            const end = data.indexOf(10, at);
            const [oid, type, length] = data.subarray(at, end).toString().split(' '); const size = Number(length);
            if (end < 0 || oid !== item.oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0 || size > ceiling || end + 1 + size >= data.length) throw new Error('Invalid historical blob response');
            const count = textLines(data.subarray(end + 1, end + 1 + size)); bytes += size; at = end + size + 2;
            save(item.file, item.oid, count === null ? { state: 'unavailable', source: item.source, reason: 'Binary or non-UTF-8 file' } : { state: 'known', source: item.source, textLines: count }, true);
          }
        }
      }
    } catch { for (const { file, source } of missing) save(file, '', { state: 'unavailable', source, reason: 'Historical size unavailable (Git error or read budget)' }, true); }
  }
  for (const file of files) if (file.status === '??' || file.untrackedReplacement || unborn && file.status && !file.status.includes('U') && !['AA', 'DD'].includes(file.status)) {
    const size = file.size!;
    file.lines = unborn && absent.has(file.path) ? { added: 0, removed: 0 } : size.state === 'known' && size.source === 'working tree' ? { added: size.textLines, removed: file.untrackedReplacement ? file.lines?.removed || 0 : 0 } : null;
    if (!file.lines) file.lineNotice = size.state === 'unavailable' ? size.reason : 'Waiting for bounded line-count measurement';
    else file.lineNotice = 'Based on cached text sizes; revalidated in bounded batches, not an atomic snapshot.';
  }
  const progress = { checked, read, bytes, known: files.filter(f => f.size?.state === 'known').length,
    stale: files.filter(f => f.size?.stale).length, pending: files.filter(f => f.size?.state === 'pending').length };
  return { sizeProgress: progress, sizeNotice: `${progress.known.toLocaleString()}/${files.length.toLocaleString()} sizes known · ${progress.pending} pending. Cached sizes are revalidated in bounded batches, not an atomic snapshot. Text lines include blanks/comments; unknown and empty files use minimum layout weight 1, not one measured line.` };
}
