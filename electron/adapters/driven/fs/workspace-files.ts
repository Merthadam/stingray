import { lstat, mkdir, realpath } from 'node:fs/promises';
import type { WorkspaceFiles } from '../../../core/git';

export const nodeWorkspaceFiles: WorkspaceFiles = {
  realpath: p => realpath(p),
  mkdirp: async (p, mode) => { await mkdir(p, { recursive: true, mode }); },
  mkdirExclusive: async (p, mode) => { await mkdir(p, { mode }); },
  isDirectory: p => lstat(p).then(s => s.isDirectory(), () => false),
};
