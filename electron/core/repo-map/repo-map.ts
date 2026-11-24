import { repoPathSchema, type GitStatus } from '../../../shared/contracts/git';
import type { FileInspection, LineStats, RepoFile, RepoMapScope, RepoSnapshot } from '../../../shared/contracts/repo-map';
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

const diffOptions = ['--find-renames', '-l1000', '--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short'];

// Same base as the sidebar (GitService.status): the merge-base with the local origin/main. null falls back to HEAD.
async function branchBase(root: string, status: GitStatus, ports: RepoMapPorts): Promise<string | null> {
  if (status.base !== 'origin/main') return null;
  try {
    const base = (await ports.inventory.run(root, ['merge-base', 'HEAD', 'refs/remotes/origin/main'])).trim();
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base) ? base : null;
  } catch { return null; }
}

/** Tracked paths changed between base and the working tree, from `diff --name-status -z` (renames/copies carry the source first). */
export function parseNameStatus(output: string): RepoFile[] {
  const fields = output.split('\0');
  const result: RepoFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const letter = fields[i][0];
    if (!letter) continue;
    if (letter === 'R' || letter === 'C') {
      const from = fields[++i], to = fields[++i];
      if (from && to) result.push(letter === 'R' ? { path: to, status: 'R ', originalPath: from } : { path: to, status: 'A ' });
      continue;
    }
    const file = fields[++i];
    if (file) result.push({ path: file, status: letter === 'A' ? 'A ' : letter === 'D' ? 'D ' : 'M ' });
  }
  return result;
}

export async function repoSnapshot(root: string, status: GitStatus, withStats = true, ports: RepoMapPorts, scope: RepoMapScope = 'branch'): Promise<RepoSnapshot> {
  const base = scope === 'branch' ? await branchBase(root, status, ports) : null;
  const [listed, committedDiff] = await Promise.all([
    ports.inventory.run(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
    base ? ports.inventory.run(root, ['diff', '--name-status', '-z', ...diffOptions, base, '--']) : '',
  ]);
  const paths = new Set(listed.split('\0').filter(Boolean));
  // Staged deletions are no longer in the index, but must remain navigable.
  for (const change of status.changes) paths.add(change.path);
  // Files changed only in commits since the base have no status entry; deletions are absent from the index too.
  const known = new Set(status.changes.map(change => change.path));
  const committed = parseNameStatus(committedDiff).filter(file => !known.has(file.path));
  for (const file of committed) paths.add(file.path);
  if (paths.size > maxFiles) throw new Error('This repository exceeds the map limit of 100,000 files.');
  const changes = new Map<string, RepoFile>();
  for (const change of status.changes) {
    const previous = changes.get(change.path);
    if (previous && ((previous.status === 'D ' && change.status === '??') || (previous.status === '??' && change.status === 'D '))) {
      changes.set(change.path, { ...change, status: 'D?', untrackedReplacement: true, lineNotice: 'Staged deletion + untracked replacement; counts include both Git entries.' });
    } else changes.set(change.path, { ...change });
  }
  for (const file of committed) changes.set(file.path, { ...file, committed: true });
  const files: RepoFile[] = [...paths].sort().map(file => ({ ...(changes.get(file) || { path: file, status: '' }) }));
  const meta = { scope, ...(base ? { baseCommit: base } : {}) };
  if (!withStats) return { ...status, ...meta, files };
  let counts = new Map<string, LineStats | null>();
  let unborn = false; let failed = false;
  try {
    // A missing HEAD is expected only on an unborn branch. Other failures keep
    // counts unknown rather than silently treating every file as newly added.
    unborn = (await ports.inventory.head(root)) === 'unborn';
    if (!unborn) counts = parseNumstat(await ports.inventory.run(root, ['diff', base || 'HEAD', '--numstat', '-z', ...diffOptions, '--']));
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
  let sizesFailed = false;
  try { await measureSizes(root, files, unborn, ports); } catch {
    // Rule 2: a failed or over-limit measurement degrades sizes only; the map still opens.
    sizesFailed = true;
    const reason = 'Size measurement failed or exceeded limits';
    for (const file of files) {
      if (!file.size) file.size = { state: 'unavailable', source: 'working tree', reason };
      if (file.lines == null && (file.status === '??' || file.untrackedReplacement || unborn)) { file.lines = null; file.lineNotice = reason; }
    }
  }
  const unknown = files.filter(file => file.status && file.lines == null).length;
  const notices = [unknown ? `${unknown} changed file(s) have unavailable line counts; totals include known counts only.` : '',
    sizesFailed ? 'File sizes are unavailable: size measurement failed or exceeded limits.' : ''].filter(Boolean);
  return { ...status, ...meta, files, statsNotice: notices.join(' ') };
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
  const result: FileInspection = { path: relative, content: null, source: 'working tree', committed: '', staged: '', unstaged: '', notice: '', revision: '' };
  let bytes: Uint8Array | null;
  try { bytes = await ports.files.read(root, relative); } catch (error) {
    result.notice = (error as Error).message;
    // Do not run diff on symlinks, special files or unbounded files either.
    return finish(result);
  }
  if (bytes === null) {
    // A staged deletion is absent from the index; an unstaged deletion may
    // still have newly added/staged contents there. Preserve that distinction.
    // A deletion committed since the branch base is in neither HEAD nor the index: show the base version.
    const source = entry.committed && snapshot.baseCommit ? 'origin/main' : entry.status[0] === 'D' ? 'HEAD' : 'index';
    try {
      bytes = await ports.inventory.bytes(root, ['show', source === 'origin/main' ? `${snapshot.baseCommit}:${relative}` : source === 'HEAD' ? `HEAD:${relative}` : `:${relative}`]);
      result.source = source;
      result.notice = `Deleted file · showing ${source === 'origin/main' ? 'merge-base (origin/main)' : source} contents.`;
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
      const [committed, staged, unstaged] = await Promise.all([
        // Branch scope: what the branch's commits changed since the merge-base, before index/working-tree edits.
        snapshot.scope === 'branch' && snapshot.baseCommit ? ports.inventory.bytes(root, ['diff', ...options, snapshot.baseCommit, 'HEAD', '--', ...paths]) : new Uint8Array(),
        ports.inventory.bytes(root, ['diff', '--cached', ...options, '--', ...paths]),
        ports.inventory.bytes(root, ['diff', ...options, '--', ...paths]),
      ]);
      result.committed = utf8(committed); result.staged = utf8(staged); result.unstaged = utf8(unstaged);
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
