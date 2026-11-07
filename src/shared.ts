import { z } from 'zod';

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
export type Change = { path: string; status: string };
export type GitLineStats =
  | { kind: 'available'; added: number; deleted: number; binaryFiles: number }
  | { kind: 'unavailable'; message: string };
export type GitStatus = { branch: string; changes: Change[]; lines: GitLineStats };
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
export type TerminalInfo = { id: string; workspaceId: string; title: string; exited: boolean; buffer: string; sequence: number };
export type TerminalEvent = { id: string; data?: string; exitCode?: number; sequence?: number };
export interface DesktopAPI {
  mode: 'desktop' | 'demo';
  state(): Promise<State>;
  pickRepository(): Promise<State | null>;
  openRepository(path: string): Promise<State>;
  pickCloneParent(): Promise<string | null>;
  cloneRepository(url: string, destination: string): Promise<State>;
  createWorkspace(repoId: string, branch: string): Promise<State>;
  removeWorkspace(id: string, confirmation: string): Promise<State>;
  gitStatus(id: string): Promise<GitStatus>;
  pullRequest(id: string, refresh?: boolean): Promise<PullRequestStatus>;
  containers(): Promise<ContainerInfo[]>;
  ports(): Promise<WorkspacePort[]>;
  preview(id: string, url: string): Promise<State>;
  terminals(): Promise<TerminalInfo[]>;
  createTerminal(workspaceId: string): Promise<TerminalInfo>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  onTerminal(listener: (event: TerminalEvent) => void): () => void;
}
declare global { interface Window { stingray?: DesktopAPI } }
