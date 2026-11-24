import type { RepoFile } from '../../../shared/contracts/repo-map';
import type { RepoMapPorts } from './repo-map';

export async function measureSizes(root: string, files: RepoFile[], unborn = false, ports: RepoMapPorts) {
  const output = await ports.inventory.run(root, ['grep', '-z', '-c', '-I', '--untracked', '-e', '']);
  const counts = new Map<string, number>();
  for (const match of output.matchAll(/([^\0]+)\0(\d+)\n/g)) counts.set(match[1], Number(match[2]));
  for (const file of files) {
    const count = counts.get(file.path);
    let absent = false;
    file.size = count === undefined
      ? { state: 'unavailable', source: 'working tree', reason: 'Binary, empty or unreadable' }
      : { state: 'known', source: 'working tree', textLines: count };
    if (count === undefined) {
      const probe = await ports.files.probe(root, file.path);
      if (probe === 'emptyFile') file.size = { state: 'known', source: 'working tree', textLines: 0 };
      absent = probe === 'missing';
      if (absent && file.status.includes('D') && file.lines) file.size = { state: 'known', source: file.committed ? 'origin/main' : 'HEAD', textLines: file.lines.removed };
    }
    if (file.status === '??' || file.untrackedReplacement || unborn && file.status && !file.status.includes('U') && !['AA', 'DD'].includes(file.status)) {
      file.lines = unborn && absent ? { added: 0, removed: 0 } : file.size.state === 'known' && file.size.source === 'working tree'
        ? { added: file.size.textLines, removed: file.untrackedReplacement ? file.lines?.removed || 0 : 0 } : null;
      if (!file.lines) file.lineNotice = file.size.state === 'unavailable' ? file.size.reason : 'Working file unavailable';
    }
  }
}
