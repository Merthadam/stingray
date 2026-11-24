import { z } from 'zod';
import { idSchema } from './common';
import { defineContract, returns } from './define';
import { repoPathSchema, type Change, type GitStatus } from './git';

/** branch: tracked working tree vs merge-base(HEAD, origin/main), like the sidebar; uncommitted: vs HEAD. */
export type RepoMapScope = 'branch' | 'uncommitted';
export const repoMapScopeSchema = z.enum(['branch', 'uncommitted']);
export type LineStats = { added: number; removed: number };
export type FileSource = 'working tree' | 'HEAD' | 'index' | 'origin/main';
export type FileSize = { state: 'known'; textLines: number; source: FileSource } |
  { state: 'unavailable'; reason: string; source: FileSource };
/** committed: changed only in commits since the branch base; the working tree matches HEAD. */
export type RepoFile = Change & { committed?: boolean; untrackedReplacement?: boolean; lines?: LineStats | null; lineNotice?: string; size?: FileSize };
/** baseCommit: the merge-base compared against; absent when the snapshot compares with HEAD. */
export type RepoSnapshot = GitStatus & { scope: RepoMapScope; baseCommit?: string; files: RepoFile[]; statsNotice?: string };
export type FileInspection = {
  path: string; content: string | null; source: FileSource;
  committed: string; staged: string; unstaged: string; notice: string; revision: string;
};

export type FileStamp = { exists: boolean; size: number; mtimeMs: number };

export const repoMapContract = defineContract('repo-map', {
  invoke: {
    repoSnapshot: [z.tuple([idSchema, repoMapScopeSchema.optional()]), returns<RepoSnapshot>()],
    inspectFile: [z.tuple([idSchema, repoPathSchema, repoMapScopeSchema.optional()]), returns<FileInspection>()],
    /** Cheap change check of one working-tree file (lstat only, no git). */
    statFile: [z.tuple([idSchema, repoPathSchema]), returns<FileStamp>()],
  },
  events: {},
});
