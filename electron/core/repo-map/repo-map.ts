import { repoPathSchema, type GitStatus } from '../../../shared/contracts/git';
import type { FileInspection, LineStats, RepoFile, RepoSnapshot } from '../../../shared/contracts/repo-map';
import { sha256 } from '../shared/ports';
import type { RepoInventory, WorkingFiles } from './ports';
import { measureSizes } from './repo-map-size';

export type RepoMapPorts = { inventory: RepoInventory; files: WorkingFiles };

const maxFiles = 100000;

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

export async function repoSnapshot(root: string, status: GitStatus, withStats = true, ports: RepoMapPorts): Promise<RepoSnapshot> {
  const listed = await ports.inventory.run(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
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
    unborn = (await ports.inventory.head(root)) === 'unborn';
    if (!unborn) counts = parseNumstat(await ports.inventory.run(root, ['diff', 'HEAD', '--numstat', '-z', '--find-renames', '-l1000', '--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short', '--']));
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
  await measureSizes(root, files, unborn, ports);
  const unknown = files.filter(file => file.status && file.lines == null).length;
  return { ...status, files, statsNotice: unknown ? `${unknown} changed file(s) have unavailable line counts; totals include known counts only.` : '' };
}

const utf8 = (data: Uint8Array) => new TextDecoder().decode(data);
function decode(data: Uint8Array): string | null {
  if (data.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return null; }
}

export async function inspectFile(root: string, relative: string, snapshot: RepoSnapshot, ports: RepoMapPorts): Promise<FileInspection> {
  repoPathSchema.parse(relative);
  const entry = snapshot.files.find(file => file.path === relative);
  if (!entry) throw new Error('File is not in this workspace’s Git inventory. Refresh the map.');
  const result: FileInspection = { path: relative, content: null, source: 'working tree', staged: '', unstaged: '', notice: '', revision: '' };
  let bytes: Uint8Array | null;
  try { bytes = await ports.files.read(root, relative); } catch (error) {
    result.notice = (error as Error).message;
    // Do not run diff on symlinks, special files or unbounded files either.
    return finish(result);
  }
  if (bytes === null) {
    // A staged deletion is absent from the index; an unstaged deletion may
    // still have newly added/staged contents there. Preserve that distinction.
    const source = entry.status[0] === 'D' ? 'HEAD' : 'index';
    try {
      bytes = await ports.inventory.bytes(root, ['show', source === 'HEAD' ? `HEAD:${relative}` : `:${relative}`]);
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
      try { result.staged = utf8(await ports.inventory.bytes(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--', `:(literal)${relative}`])); }
      catch { result.notice = 'Staged deletion diff unavailable (512 KiB limit or Git error).'; }
    }
  } else if (entry.status) {
    // Literal pathspecs handle brackets, wildcard names and leading hyphens.
    // Disable repository-configured external diff and textconv executables.
    const paths = [...new Set([relative, ...(entry.originalPath ? [entry.originalPath] : [])])].map(p => `:(literal)${p}`);
    const options = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--submodule=short'];
    try {
      const [staged, unstaged] = await Promise.all([
        ports.inventory.bytes(root, ['diff', '--cached', ...options, '--', ...paths]),
        ports.inventory.bytes(root, ['diff', ...options, '--', ...paths]),
      ]);
      result.staged = utf8(staged); result.unstaged = utf8(unstaged);
    } catch {
      result.notice = 'Diff unavailable (512 KiB limit or Git error). File contents are still available.';
    }
  }
  return finish(result);
}
function finish(result: FileInspection) {
  result.revision = sha256(JSON.stringify(result));
  return result;
}
