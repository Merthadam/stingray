import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { RepoFile } from '../src/shared';
import { inventoryGit } from './repo-map';

export async function measureSizes(root: string, files: RepoFile[], unborn = false) {
  const output = await inventoryGit(root, ['grep', '-z', '-c', '-I', '--untracked', '-e', '']);
  const counts = new Map<string, number>();
  for (const match of output.matchAll(/([^\0]+)\0(\d+)\n/g)) counts.set(match[1], Number(match[2]));
  for (const file of files) {
    const count = counts.get(file.path);
    let absent = false;
    file.size = count === undefined
      ? { state: 'unavailable', source: 'working tree', reason: 'Binary, empty or unreadable' }
      : { state: 'known', source: 'working tree', textLines: count };
    if (count === undefined) {
      try {
        const stat = await lstat(path.join(root, file.path));
        if (stat.isFile() && stat.size === 0) file.size = { state: 'known', source: 'working tree', textLines: 0 };
      } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ENOENT'; }
      if (absent && file.status.includes('D') && file.lines) file.size = { state: 'known', source: 'HEAD', textLines: file.lines.removed };
    }
    if (file.status === '??' || file.untrackedReplacement || unborn && file.status && !file.status.includes('U') && !['AA', 'DD'].includes(file.status)) {
      file.lines = unborn && absent ? { added: 0, removed: 0 } : file.size.state === 'known' && file.size.source === 'working tree'
        ? { added: file.size.textLines, removed: file.untrackedReplacement ? file.lines?.removed || 0 : 0 } : null;
      if (!file.lines) file.lineNotice = file.size.state === 'unavailable' ? file.size.reason : 'Working file unavailable';
    }
  }
}
