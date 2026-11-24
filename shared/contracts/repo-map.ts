import { z } from 'zod';
import { idSchema } from './common';
import { defineContract, returns } from './define';
import { repoPathSchema, type Change, type GitStatus } from './git';

export type LineStats = { added: number; removed: number };
export type FileSize = { state: 'known'; textLines: number; source: 'working tree' | 'HEAD' | 'index' } |
  { state: 'unavailable'; reason: string; source: 'working tree' | 'HEAD' | 'index' };
export type RepoFile = Change & { untrackedReplacement?: boolean; lines?: LineStats | null; lineNotice?: string; size?: FileSize };
export type RepoSnapshot = GitStatus & { files: RepoFile[]; statsNotice?: string };
export type FileInspection = {
  path: string; content: string | null; source: 'working tree' | 'HEAD' | 'index';
  staged: string; unstaged: string; notice: string; revision: string;
};

export type FileStamp = { exists: boolean; size: number; mtimeMs: number };

export const repoMapContract = defineContract('repo-map', {
  invoke: {
    repoSnapshot: [z.tuple([idSchema]), returns<RepoSnapshot>()],
    inspectFile: [z.tuple([idSchema, repoPathSchema]), returns<FileInspection>()],
    /** Cheap change check of one working-tree file (lstat only, no git). */
    statFile: [z.tuple([idSchema, repoPathSchema]), returns<FileStamp>()],
  },
  events: {},
});
