import type { GitStatus, RepoFile, RepoSnapshot } from './shared';

export function sameGitStatus(a: GitStatus, b: GitStatus) {
  return a.branch === b.branch && JSON.stringify(a.lines) === JSON.stringify(b.lines) &&
    a.changes.length === b.changes.length && a.changes.every((change, i) => {
      const next = b.changes[i];
      return change.path === next.path && change.status === next.status && change.originalPath === next.originalPath;
    });
}
function sameFile(a: RepoFile, b: RepoFile) {
  const x = a.size, y = b.size;
  return a.path === b.path && a.status === b.status && a.originalPath === b.originalPath &&
    a.untrackedReplacement === b.untrackedReplacement && a.lineNotice === b.lineNotice &&
    a.lines?.added === b.lines?.added && a.lines?.removed === b.lines?.removed &&
    x?.state === y?.state && x?.source === y?.source &&
    (x?.state === 'known' ? x.textLines : x?.reason) === (y?.state === 'known' ? y.textLines : y?.reason);
}
// Per-batch work counters and the rotating revalidation flag are diagnostics,
// not content changes. The UI describes all measurements as cached; it never
// claims an unchecked file is fresh. Preserve references on an idle poll.
export function reconcileSnapshot(previous: RepoSnapshot | null, next: RepoSnapshot): RepoSnapshot {
  if (!previous) return next;
  const files = previous.files.length === next.files.length && previous.files.every((file, i) => sameFile(file, next.files[i])) ? previous.files : next.files;
  if (files === previous.files && sameGitStatus(previous, next) && previous.sizeNotice === next.sizeNotice && previous.statsNotice === next.statsNotice) return previous;
  return { ...next, files };
}

export type FileKind = 'modified' | 'added' | 'deleted' | 'conflict' | 'clean';
export const kindLabels: Record<FileKind, string> = { modified: 'Modified', added: 'New', deleted: 'Deleted', conflict: 'Conflict', clean: 'Unchanged' };
export const kindBadges: Record<FileKind, string> = { modified: 'M', added: 'A', deleted: 'D', conflict: '!', clean: '·' };
export function fileKind(status: string): FileKind {
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(status)) return 'conflict';
  if (status === 'D?') return 'modified'; // staged deletion + same-path untracked replacement
  if (status.includes('D')) return 'deleted';
  if (status === '??' || status.includes('A')) return 'added';
  return status.trim() ? 'modified' : 'clean';
}
export type Totals = { total: number; changed: number; added: number; removed: number; unknown: number; weight: number; textLines: number; unknownSizes: number; staleSizes: number };
export type MapNode = Totals & { path: string; name: string; file?: RepoFile; children: MapNode[] };
const empty = (): Totals => ({ total: 0, changed: 0, added: 0, removed: 0, unknown: 0, weight: 0, textLines: 0, unknownSizes: 0, staleSizes: 0 });
export function aggregate(nodes: Totals[]): Totals {
  return nodes.reduce((sum, node) => ({ total: sum.total + node.total, changed: sum.changed + node.changed,
    added: sum.added + node.added, removed: sum.removed + node.removed, unknown: sum.unknown + node.unknown,
    weight: sum.weight + node.weight, textLines: sum.textLines + node.textLines, unknownSizes: sum.unknownSizes + node.unknownSizes, staleSizes: sum.staleSizes + node.staleSizes }), empty());
}
function add(target: Totals, value: Totals) {
  target.total += value.total; target.changed += value.changed; target.added += value.added;
  target.removed += value.removed; target.unknown += value.unknown;
  target.weight += value.weight; target.textLines += value.textLines; target.unknownSizes += value.unknownSizes; target.staleSizes += value.staleSizes;
}
export function buildRepoTree(files: RepoFile[]): MapNode {
  const root: MapNode = { path: '', name: 'Repository', children: [], ...empty() };
  const folders = new Map<string, MapNode>([['', root]]);
  for (const file of files) {
    const parts = file.path.split('/');
    const changed = fileKind(file.status) !== 'clean' ? 1 : 0;
    const known = file.size?.state === 'known';
    const textLines = file.size?.state === 'known' ? file.size.textLines : 0;
    const totals: Totals = { total: 1, changed, added: file.lines?.added || 0, removed: file.lines?.removed || 0, unknown: changed && file.lines == null ? 1 : 0,
      weight: Math.max(1, textLines), textLines, unknownSizes: known ? 0 : 1, staleSizes: file.size?.stale ? 1 : 0 };
    let parent = root; let path = ''; add(parent, totals);
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? path + '/' + parts[i] : parts[i];
      let folder = folders.get(path);
      if (!folder) { folder = { path, name: parts[i], children: [], ...empty() }; folders.set(path, folder); parent.children.push(folder); }
      add(folder, totals); parent = folder;
    }
    parent.children.push({ path: file.path, name: parts.at(-1)!, file, children: [], ...totals });
  }
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    node.children.sort((a, b) => nodeKey(a) < nodeKey(b) ? -1 : nodeKey(a) > nodeKey(b) ? 1 : 0);
    for (const child of node.children) if (!child.file) stack.push(child);
  }
  return root;
}
export function findFolder(root: MapNode, path: string): MapNode {
  let node = root;
  for (const part of path.split('/').filter(Boolean)) {
    const next = node.children.find(child => !child.file && child.name === part);
    if (!next) return root;
    node = next;
  }
  return node;
}
export const nodeKey = (node: MapNode) => `${node.file ? '1' : '0'}:${node.path}`;
export type MapRange = { first: string; last: string; label: string };
export type MapTile = { id: string; node?: MapNode; range?: MapRange; name: string; totals: Totals; samples: MapNode[] };
export function inRange(node: MapNode, range: MapRange) { const key = nodeKey(node); return key >= range.first && key <= range.last; }

// Every entry is represented; never paginate or render thousands of tiny DOM
// nodes. Large directories become contiguous name-range groups. Each click
// strictly reduces the range until individual files fit at a readable size.
export function clusterNodes(nodes: MapNode[], capacity: number): MapTile[] {
  const limit = Math.max(2, Math.floor(capacity));
  if (nodes.length <= limit) return nodes.map(node => ({ id: nodeKey(node), node, name: node.name, totals: node, samples: node.children.slice(0, 9) }));
  const size = Math.ceil(nodes.length / limit);
  const tiles: MapTile[] = [];
  for (let i = 0; i < nodes.length; i += size) {
    const members = nodes.slice(i, i + size);
    if (members.length === 1) { const node = members[0]; tiles.push({ id: nodeKey(node), node, name: node.name, totals: node, samples: node.children.slice(0, 9) }); continue; }
    const first = members[0]; const last = members.at(-1)!;
    const range = { first: nodeKey(first), last: nodeKey(last), label: `${first.name} – ${last.name}` };
    tiles.push({ id: `range:${range.first}:${range.last}`, range, name: range.label, totals: aggregate(members), samples: members.slice(0, 9) });
  }
  return tiles;
}
