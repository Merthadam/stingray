import type { GraphHost, ViewFiles, WorktreeGraph } from '../../electron/core/views';

export function throwingHost(): GraphHost & { opened: number } {
  const host = { opened: 0, open(): WorktreeGraph { host.opened++; throw new Error('graph host crashed'); }, async close() {}, async closeAll() {} };
  return host;
}
/** In-memory worktree: paths → text; directories are implied by paths. */
export function memoryViewFiles(files: Record<string, string>): ViewFiles {
  const isDir = (rel: string) => Object.keys(files).some(f => f.startsWith(rel + '/'));
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    kind: async (_root, rel) => { if (rel in files) return 'file'; if (isDir(rel)) return 'directory'; throw missing(); },
    readBounded: async (_root, rel) => { if (!(rel in files)) throw missing(); return { text: files[rel] }; },
    list: async (_root, dir) => { if (!isDir(dir)) throw missing(); return [...new Set(Object.keys(files).filter(f => f.startsWith(dir + '/')).map(f => f.slice(dir.length + 1).split('/')[0]))].map(name => ({ name, directory: isDir(`${dir}/${name}`) })); },
    mkdir: async () => {}, createExclusive: async (_root, rel, text) => { files[rel] = text; },
    replace: async (_root, rel, text) => { if (!(rel in files)) throw missing(); files[rel] = text; },
    relative: (_root, rel) => rel,
  };
}
