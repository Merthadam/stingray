import { z } from 'zod';
import { idSchema, urlSchema } from './common';
import { defineContract, event, returns } from './define';

// Deliberately conservative: no URL secrets, query strings, escapes, or helper protocols.
export const repositoryUrlSchema = z.string().min(1).max(2048).refine(value => {
  if (/[\s\\\\%?#\x00-\x1f\x7f]/.test(value)) return false;
  const host = '(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)';
  const repo = '[A-Za-z0-9_~][A-Za-z0-9._~/-]*';
  const https = new RegExp('^https://' + host + '(?::[0-9]{1,5})?/' + repo + '$');
  const ssh = new RegExp('^ssh://(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?' + host + '(?::[0-9]{1,5})?/' + repo + '$');
  const scp = new RegExp('^[A-Za-z0-9_][A-Za-z0-9_.-]*@' + host + ':' + repo + '$');
  return (https.test(value) || ssh.test(value) || scp.test(value)) && !value.split('/').includes('..');
}, 'Use an HTTPS or SSH Git URL without passwords, tokens, query strings, or fragments.');
export const cloneDestinationSchema = z.string().min(1).max(4096).refine(
  value => value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value) && !value.endsWith('/') && !value.split('/').some(part => part === '.' || part === '..'),
  'Choose a new absolute folder path, without trailing slash or dot segments.',
);
export const workspaceSchema = z.object({
  id: idSchema, repoId: idSchema, name: z.string().max(200), branch: z.string().max(200),
  path: z.string().max(4096), managed: z.boolean(), previewUrl: z.union([z.literal(''), urlSchema]).default(''),
});
export const repoSchema = z.object({ id: idSchema, name: z.string().max(200), path: z.string().max(4096) });
export const stateSchema = z.object({
  version: z.literal(1), repos: z.array(repoSchema).max(100), workspaces: z.array(workspaceSchema).max(200),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type Repository = z.infer<typeof repoSchema>;
export type State = z.infer<typeof stateSchema>;
export type Change = { path: string; status: string; originalPath?: string };
export const repoPathSchema = z.string().min(1).max(4096).refine(value =>
  !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
  !value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'),
  'Choose a repository-relative file path.',
);
export type GitLineStats =
  | { kind: 'available'; added: number; deleted: number; binaryFiles: number }
  | { kind: 'unavailable'; message: string };
/** lines: tracked working tree vs merge-base(HEAD, local origin/main), like the PR diff; vs HEAD when that base is
 *  unavailable (see base). uncommitted: tracked working tree vs HEAD. Untracked files are never counted. */
export type GitStatus = { branch: string; changes: Change[]; lines: GitLineStats; uncommitted: GitLineStats; base: 'origin/main' | 'HEAD' };
export type RemovalReview = {
  branch: string;
  /** Rare states that removal refuses outright (detached HEAD, switched branch, locked worktree). */
  blockers: string[];
  /** Open terminals in the workspace; removal closes them. */
  terminals: number;
  /** Uncommitted work that removal deletes (ignored files are never counted). Paths are capped. */
  changes: { tracked: number; untracked: number; paths: string[] };
  /** Informational only: the branch and its commits are kept unless deleteBranch is chosen. */
  push: { kind: 'known'; upstream: string; ahead: number; behind: number } | { kind: 'unknown'; message: string };
  /** Branch the worktree's branch is merged into, or null when it may not be deleted. */
  merged: string | null;
};
export type RemovalResult = { state: State; warning?: string };
export const removalConsentSchema = z.object({ discard: z.boolean(), deleteBranch: z.boolean() }).strict();
export type RemovalConsent = z.infer<typeof removalConsentSchema>;
export type PullRequestStatus =
  | { kind: 'pr'; branch: string; repository: string; checkedAt: number; number: number; state: 'open' | 'draft' | 'merged' | 'closed' }
  | { kind: 'none'; branch: string; repository: string; checkedAt: number }
  | { kind: 'unsupported'; branch: string; message: string }
  | { kind: 'unavailable'; branch: string; message: string };
/** revision increases with every change in the main process, so late responses can be ignored. */
export type WorkspaceGitState = { workspaceId: string; revision: number; status: GitStatus | null; error: string; pr: PullRequestStatus | null };

export const gitContract = defineContract('git', {
  invoke: {
    pickRepository: [z.tuple([]), returns<State | null>()],
    openRepository: [z.tuple([z.string().min(1).max(4096)]), returns<State>()],
    pickCloneParent: [z.tuple([]), returns<string | null>()],
    // Validated in the service with fixed errors (no Zod payload echo).
    cloneRepository: [z.tuple([z.string().max(2048), z.string().max(4096)]), returns<State>()],
    createWorkspace: [z.tuple([idSchema, z.string().max(100)]), returns<State>()],
    reviewRemoval: [z.tuple([idSchema]), returns<RemovalReview>()],
    removeWorkspace: [z.tuple([idSchema, removalConsentSchema]), returns<RemovalResult>()],
    /** Shared Git + PR state of a workspace; starts main-process tracking (watcher, polls) on first use. */
    gitState: [z.tuple([idSchema]), returns<WorkspaceGitState>()],
    /** Re-reads Git now and re-queries GitHub (5s cooldown). */
    refreshGitState: [z.tuple([idSchema]), returns<WorkspaceGitState>()],
  },
  events: { onStatusChanged: event<WorkspaceGitState>() },
});
