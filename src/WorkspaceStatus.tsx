import type { ReactNode } from 'react';
import { GitBranch, GitPullRequest, GitMerge, GitPullRequestClosed, GitPullRequestDraft, LoaderCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { api } from './api';
import type { GitStatus, Workspace } from './shared';
import { usePullRequest } from './usePullRequest';
import { useSidebarGit } from './useSidebarGit';
import './workspace-git.css';
import type { PiActivity } from './activity';
import { WorkspaceActivity } from './WorkspaceActivity';

export function WorkspaceStatus({ workspace, selected, status: selectedStatus, statusBusy: selectedBusy, statusError: selectedError, disabled, running, agents = [], activityUnavailable = false, onSelect, onChanges, onRefresh, children }: {
  workspace: Workspace; selected: boolean; status: GitStatus | null; statusBusy: boolean; statusError: string;
  agents?: PiActivity[]; activityUnavailable?: boolean;
  disabled: boolean; running: boolean; onSelect: () => void; onChanges: () => void; onRefresh: () => void; children: ReactNode;
}) {
  const background = useSidebarGit(workspace.id, !selected);
  const status = selected ? selectedStatus : background.status;
  const statusBusy = selected ? selectedBusy : background.busy;
  const statusError = selected ? selectedError : background.error;
  const refreshGit = selected ? onRefresh : () => { void background.refresh(); };
  const pr = usePullRequest(workspace.id, status?.branch);
  const value = pr.value;
  const kind = statusError ? 'unavailable' : value?.kind === 'pr' ? value.state : value?.kind || 'loading';
  const prLabel = statusError ? 'PR unavailable' : !value ? 'Checking PR…' : value.kind === 'pr' ?
    `PR #${value.number} ${value.state === 'open' ? 'Open' : value.state === 'merged' ? 'Merged' : value.state === 'draft' ? 'Draft' : 'Closed'}` :
    value.kind === 'none' ? 'No PR' : value.kind === 'unsupported' ? 'PR not available' : 'PR unavailable';
  const prDetails = statusError ? 'Git is unavailable; PR status cannot be matched to the current branch.' : !value ? 'Checking GitHub pull request status…' :
    value.kind === 'unavailable' || value.kind === 'unsupported' ? value.message :
      `${value.repository} · ${value.branch} · Checked ${new Date(value.checkedAt).toLocaleTimeString()}. ${value.kind === 'none' ? 'No matching PR in origin.' :
        'Open PR preferred; otherwise most recently updated PR for this head branch in origin. Historical merged/closed status does not mean local edits are merged.'} Fork-to-upstream PRs are not included.`;
  const PRIcon = kind === 'merged' ? GitMerge : kind === 'closed' ? GitPullRequestClosed : kind === 'draft' ? GitPullRequestDraft :
    kind === 'unavailable' ? AlertCircle : kind === 'loading' ? LoaderCircle : kind === 'open' ? GitPullRequest : GitBranch;
  const branch = status?.branch || (statusError ? 'Branch unavailable' : 'Checking branch…');
  const lines = status?.lines;
  const lineLabel = statusError || lines?.kind === 'unavailable' ? 'Line counts unavailable' : !lines ? 'Checking line counts…' : `${lines.added} lines added, ${lines.deleted} lines deleted`;
  const lineDetails = statusError || (lines?.kind === 'unavailable' ? lines.message : !lines ? 'Checking Git…' :
    `Net tracked changes against HEAD (staged and unstaged combined). Excludes untracked files and submodules. ${lines.binaryFiles} binary files excluded from line counts. Not the PR diff. Open Changes.`);
  return <div className="workspace-git" role="group" aria-label={`${workspace.name} Git summary`}>
    <div className="workspace-card-top">
      <span className={'pr-symbol pr-' + kind} role="img" aria-label={prLabel} tabIndex={0}
        title={(api.mode === 'demo' ? 'SIMULATED · ' : '') + prLabel + ' · ' + prDetails} aria-busy={!statusError && pr.busy}>
        <PRIcon size={17} className={kind === 'loading' ? 'spin' : ''} />
        {!statusError && value?.kind === 'pr' && <small aria-hidden="true">#{value.number}</small>}
      </span>
      {running && <span className="activity-dot" role="img" aria-label="Running terminal" title="A shell is running; this is not agent activity." />}
      <div className="workspace-card-metrics">
      <button className="git-lines" aria-label={`${workspace.name}: ${lineLabel}`} aria-busy={statusBusy}
        title={(api.mode === 'demo' ? 'SIMULATED · ' : '') + lineDetails} onClick={onChanges}>
        {!statusError && lines?.kind === 'available' ? <><span className="lines-added">+{lines.added}</span><span className="lines-deleted">−{lines.deleted}</span></> :
          <span className="lines-unavailable">{!statusError && !lines ? '…' : '—'}</span>}
      </button>
      <div className="workspace-git-badges">{children}</div>
      </div>
    </div>
    <WorkspaceActivity agents={agents} unavailable={activityUnavailable} />
    <div className="workspace-card-bottom">
      <button disabled={disabled} className={'workspace-link ' + (selected ? 'selected' : '')} aria-label={workspace.name}
        aria-current={selected ? 'page' : undefined} title={`${branch} · ${workspace.name} · ${workspace.managed ? 'Git worktree' : 'Local repository'} · ${workspace.path}`} onClick={onSelect}>
        <div><span className="git-branch-label">{branch}</span></div>
      </button>
      <button className="icon git-refresh" aria-label={`Refresh Git and PR status for ${workspace.name}`} title="Refresh Git and PR status (GitHub retry cooldown: 5 seconds)"
        disabled={statusBusy || (Boolean(status) && pr.busy)} onClick={() => { refreshGit(); void pr.refresh(true); }}>
        <RefreshCw size={11} className={statusBusy || (Boolean(status) && pr.busy) ? 'spin' : ''} />
      </button>
    </div>
  </div>;
}
