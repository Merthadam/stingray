import type { ContainerInfo, GitStatus, Workspace, WorkspacePort } from './shared';

export function workspacePorts(workspace: Workspace, terminalPorts: WorkspacePort[], containers: ContainerInfo[]) {
  const ports = new Map<number, WorkspacePort>();
  for (const c of containers.filter(c => belongsToWorkspace(c, workspace.path))) {
    for (const p of c.ports) ports.set(p.port, { ...p, workspaceId: workspace.id, source: 'docker', label: c.name });
  }
  for (const p of terminalPorts.filter(p => p.workspaceId === workspace.id)) ports.set(p.port, p);
  return [...ports.values()].sort((a, b) => a.port - b.port);
}

const conflicts = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
export function summarizeChanges(status: Pick<GitStatus, 'branch' | 'changes'>) {
  const summary = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  for (const change of status.changes) {
    if (conflicts.has(change.status)) summary.conflicts++;
    else if (change.status === '??') summary.untracked++;
    else {
      if (change.status[0] && change.status[0] !== ' ') summary.staged++;
      if (change.status[1] && change.status[1] !== ' ') summary.unstaged++;
    }
  }
  return summary;
}

export function belongsToWorkspace(container: ContainerInfo, workspacePath: string) {
  const root = workspacePath.replace(/\/+$/, '');
  return container.paths.some(p => p.replace(/\/+$/, '') === root || p.startsWith(root + '/'));
}
