import type { Events, Invoke } from '../../../shared/contracts/define';
import type { gitContract, GitStatus, PullRequestStatus } from '../../../shared/contracts/git';
import type { DemoContext } from '../../shared/demo-context';

export function createGitDemo(ctx: DemoContext): Invoke<typeof gitContract> & Events<typeof gitContract> {
  const demoGitStatus = async (id: string): Promise<GitStatus> => ({ lines: { kind: 'available' as const, added: id === ctx.mainId ? 8 : 124, deleted: id === ctx.mainId ? 2 : 36, binaryFiles: 0 }, uncommitted: ctx.uncommitted, base: 'origin/main' as const, branch: ctx.state.workspaces.find(w => w.id === id)?.branch || 'unknown', changes: ctx.files.filter(file => file.status) });
  const demoPullRequest = async (id: string): Promise<PullRequestStatus> => {
    await new Promise(resolve => setTimeout(resolve, 700));
    const branch = ctx.state.workspaces.find(w => w.id === id)?.branch || 'unknown';
    return { kind: 'pr', branch, repository: 'demo/stingray', checkedAt: Date.now(), number: id === ctx.mainId ? 41 : 42, state: id === ctx.mainId ? 'merged' : 'open' };
  };
  const git: Invoke<typeof gitContract> & Events<typeof gitContract> = {
    pickRepository: async () => { throw new Error('Native folder selection is available in the desktop app. This is a simulated browser demo.'); },
    openRepository: async () => { throw new Error('Real repositories require the desktop app. Demo workspaces are simulated.'); },
    pickCloneParent: async () => { throw new Error('Folder selection requires the desktop app. No files were changed.'); },
    cloneRepository: async () => { throw new Error('Cloning requires the desktop app. No repository was downloaded or added in this browser demo.'); },
    createWorkspace: async (id, branch) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(branch) || branch.includes('..') || branch.endsWith('/')) throw new Error('Enter a valid branch name.');
      if (ctx.state.workspaces.some(w => w.branch === branch)) throw new Error('This branch already exists.');
      if (ctx.state.workspaces.length >= 20) throw new Error('Demo workspace limit reached.');
      ctx.state.workspaces.push({ id: crypto.randomUUID(), repoId: id, name: branch, branch, path: '/demo/' + branch, managed: true, previewUrl: '' }); return ctx.save();
    },
    reviewRemoval: async id => {
      const w = ctx.state.workspaces.find(w => w.id === id);
      if (!w?.managed) throw new Error('Only managed worktrees can be removed.');
      return { branch: w.branch, blockers: [], terminals: ctx.terminals.filter(t => t.workspaceId === id).length, changes: { tracked: 0, untracked: 0, paths: [] }, merged: null, push: { kind: 'unknown', message: 'Simulated demo: push status is unknown. No real Git check was performed.' } };
    },
    removeWorkspace: async id => {
      const w = ctx.state.workspaces.find(w => w.id === id);
      if (!w?.managed) throw new Error('Only managed worktrees can be removed.');
      ctx.terminals = ctx.terminals.filter(t => t.workspaceId !== id);
      ctx.state.workspaces = ctx.state.workspaces.filter(w => w.id !== id); return { state: ctx.save() };
    },
    gitState: async id => ({ workspaceId: id, revision: 1, error: '', status: await demoGitStatus(id), pr: await demoPullRequest(id) }),
    refreshGitState: id => git.gitState(id),
    onStatusChanged: () => () => {},
  };
  return git;
}
