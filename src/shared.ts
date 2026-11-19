import { z } from 'zod';
import type { OverlayConflicts } from '@colbymchenry/codegraph';
import type { ActivitySnapshot } from './activity';
import type { DbSchemaResult } from './db-schema';
import type { EditorId, EditorSettings, SaveViewInput, SaveViewResult, ViewLocalState, ViewResult, ViewSummary, ViewsChangedEvent } from './views';

export const idSchema = z.string().uuid();
export const urlSchema = z.string().max(2048).refine((value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, 'Use an http:// or https:// URL without credentials.');
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
export type LineStats = { added: number; removed: number };
export type FileSize = { state: 'known'; textLines: number; source: 'working tree' | 'HEAD' | 'index' } |
  { state: 'unavailable'; reason: string; source: 'working tree' | 'HEAD' | 'index' };
export type RepoFile = Change & { untrackedReplacement?: boolean; lines?: LineStats | null; lineNotice?: string; size?: FileSize };
export type RepoSnapshot = GitStatus & { files: RepoFile[]; statsNotice?: string };
export type FileInspection = {
  path: string; content: string | null; source: 'working tree' | 'HEAD' | 'index';
  staged: string; unstaged: string; notice: string; revision: string;
};
export const repoPathSchema = z.string().min(1).max(4096).refine(value =>
  !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
  !value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'),
  'Choose a repository-relative file path.',
);
export type GitLineStats =
  | { kind: 'available'; added: number; deleted: number; binaryFiles: number }
  | { kind: 'unavailable'; message: string };
export type GitStatus = { branch: string; changes: Change[]; lines: GitLineStats };
export type RemovalReview = {
  branch: string; blockers: string[]; token: string;
  push: { kind: 'known'; upstream: string; ahead: number; behind: number } | { kind: 'unknown'; message: string };
};
export const removalConsentSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), acknowledge: z.boolean() }).strict();
export type RemovalConsent = z.infer<typeof removalConsentSchema>;
export type PullRequestStatus =
  | { kind: 'pr'; branch: string; repository: string; checkedAt: number; number: number; state: 'open' | 'draft' | 'merged' | 'closed' }
  | { kind: 'none'; branch: string; repository: string; checkedAt: number }
  | { kind: 'unsupported'; branch: string; message: string }
  | { kind: 'unavailable'; branch: string; message: string };
export type ContainerInfo = {
  id: string; name: string; image: string; state: string; health: string;
  paths: string[];
  ports: { port: number; target: string; url: string }[];
};
export type WorkspacePort = { workspaceId: string; terminalId?: string; port: number; url: string; label: string; source: 'terminal' | 'docker' };
export type TerminalInfo = { id: string; workspaceId: string; title: string; exited: boolean; buffer: string; sequence: number; cols?: number; rows?: number; piTracking?: 'available' | 'unavailable' };
export type TerminalEvent = { id: string; data?: string; exitCode?: number; sequence?: number };
export interface DesktopAPI {
  mode: 'desktop' | 'demo';
  state(): Promise<State>;
  pickRepository(): Promise<State | null>;
  openRepository(path: string): Promise<State>;
  pickCloneParent(): Promise<string | null>;
  cloneRepository(url: string, destination: string): Promise<State>;
  createWorkspace(repoId: string, branch: string): Promise<State>;
  reviewRemoval(id: string): Promise<RemovalReview>;
  removeWorkspace(id: string, confirmation: string, consent: RemovalConsent): Promise<State>;
  gitStatus(id: string): Promise<GitStatus>;
  repoSnapshot(id: string): Promise<RepoSnapshot>;
  inspectFile(id: string, path: string): Promise<FileInspection>;
  dbSchema(workspaceId: string): Promise<DbSchemaResult>;
  views(workspaceId: string): Promise<ViewSummary[]>;
  /** `depth` overrides a flowchart view's `flowchart.depth` (0-4) for this computation; other kinds ignore it. */
  view(workspaceId: string, viewId: string, options?: { depth?: number }): Promise<ViewResult>;
  onViewsChanged(listener: (event: ViewsChangedEvent) => void): () => void;
  /** Local (app data) state of a view in a worktree; null when none saved yet. */
  viewState(workspaceId: string, viewId: string): Promise<ViewLocalState | null>;
  saveViewState(workspaceId: string, viewId: string, state: ViewLocalState): Promise<void>;
  /** Writes .stingray/views/<slug>.yaml; rejects if that file exists. */
  saveViewAs(workspaceId: string, input: SaveViewInput): Promise<SaveViewResult>;
  editorSettings(): Promise<EditorSettings>;
  setEditor(editor: EditorId): Promise<EditorSettings>;
  /** codegraph.sharedBase: managed worktrees use one shared origin/main index plus an overlay of their commits. Applies when a graph is next opened. */
  codegraphSettings(): Promise<{ sharedBase: boolean }>;
  setCodegraphSharedBase(enabled: boolean): Promise<{ sharedBase: boolean }>;
  /** File/symbol conflicts and main-moved files between the managed worktrees of this worktree's repo; null when shared base is off or not built. */
  codegraphConflicts(workspaceId: string): Promise<OverlayConflicts | null>;
  /** Open a worktree file (at a 1-based line when the editor supports it) in the selected editor. */
  openSource(workspaceId: string, file: string, line: number | null): Promise<void>;
  pullRequest(id: string, refresh?: boolean): Promise<PullRequestStatus>;
  containers(): Promise<ContainerInfo[]>;
  ports(): Promise<WorkspacePort[]>;
  preview(id: string, url: string): Promise<State>;
  activity(): Promise<ActivitySnapshot>;
  onActivity(listener: (snapshot: ActivitySnapshot) => void): () => void;
  activityView(terminalIds: string[]): Promise<void>;
  acknowledgeActivity(id: string, terminalId: string, reviewRevision: number): Promise<void>;
  terminals(): Promise<TerminalInfo[]>;
  createTerminal(workspaceId: string): Promise<TerminalInfo>;
  writeTerminal(id: string, data: string): Promise<void>;
  openTerminalLink(id: string, uri: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  onTerminal(listener: (event: TerminalEvent) => void): () => void;
}
declare global { interface Window { stingray?: DesktopAPI } }
