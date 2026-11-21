import type { ReactNode } from 'react';
import { GitBranch, GitPullRequest, GitMerge, GitPullRequestClosed, GitPullRequestDraft, LoaderCircle, AlertCircle, RefreshCw, Trash2 } from 'lucide-react';
import { api } from './api';
import type { GitLineStats, Workspace } from './shared';
import { useGitState } from './useGitState';
import './workspace-git.css';
import type { AgentActivity } from './activity';
import { WorkspaceActivity } from './WorkspaceActivity';

const counts = (lines: GitLineStats) => lines.kind === 'available' ? `+${lines.added} −${lines.deleted}` : 'unavailable';
export function WorkspaceStatus({ workspace, selected, disabled, running, agents = [], activityUnavailable = false, onSelect, onChanges, onRemove, children }: {
  workspace: Workspace; selected: boolean;
  agents?: AgentActivity[]; activityUnavailable?: boolean;
  disabled: boolean; running: boolean; onSelect: () => void; onChanges: () => void; onRemove: () => void; children: ReactNode;
}) {
  const git = useGitState(workspace.id);
  const status = git.state?.status ?? null;
  const statusBusy = git.busy;
  const statusError = git.state?.error ?? '';
  const value = git.state?.pr ?? null;
  const kind = statusError ? 'unavailable' : value?.kind === 'pr' ? value.state : value?.kind || 'loading';
  const prLabel = statusError ? 'PR unavailable' : !value ? 'Checking PR…' : value.kind === 'pr' ?
    `PR #${value.number} ${value.state === 'open' ? 'Open' : value.state === 'merged' ? 'Merged' : value.state === 'draft' ? 'Draft' : 'Closed'}` :
    value.kind === 'none' ? 'No PR' : value.kind === 'unsupported' ? 'PR not available' : 'PR unavailable';
  const prDetails = statusError ? 'Git is unavailable; PR status cannot be matched to the current branch.' : !value ? 'Checking GitHub pull request status…' :
    value.kind === 'unavailable' || value.kind === 'unsupported' ? value.message :
      `${value.repository} · ${value.branch} · Checked ${new Date(value.checkedAt).toLocaleTimeString()}. ${value.kind === 'none' ? 'No matching PR in origin.' :
        'Open PR preferred; otherwise most recently updated PR for this head branch in origin. Historical merged/closed status does not mean local edits are merged.'} Fork-to-upstream PRs are not included. Rechecked every 20 seconds while Stingray is visible and right after commits and pushes.`;
  const PRIcon = kind === 'merged' ? GitMerge : kind === 'closed' ? GitPullRequestClosed : kind === 'draft' ? GitPullRequestDraft :
    kind === 'unavailable' ? AlertCircle : kind === 'loading' ? LoaderCircle : kind === 'open' ? GitPullRequest : GitBranch;
  const branch = status?.branch || (statusError ? 'Branch unavailable' : 'Checking branch…');
  const lines = status?.lines;
  const lineLabel = statusError || lines?.kind === 'unavailable' ? 'Line counts unavailable' : !lines ? 'Checking line counts…' : `${lines.added} lines added, ${lines.deleted} lines deleted`;
  const lineDetails = statusError || (lines?.kind === 'unavailable' ? lines.message : !lines || !status ? 'Checking Git…' :
    (status.base === 'origin/main' ? 'All changes against origin/main, like the PR diff: tracked files compared from the merge base with your local origin/main (committed, staged and unstaged). Stingray does not fetch, so origin/main is as of your last fetch.' :
      'No local origin/main shares history with this branch, so this shows uncommitted tracked changes against HEAD instead. Fetch origin/main to compare like the PR diff.') +
    ` Uncommitted (against HEAD): ${counts(status.uncommitted)}. Excludes untracked files and submodules. ${lines.binaryFiles} binary files excluded from line counts. Updates on commits, staging, checkouts, fetches and pushes, and at least every minute. Open Repo Map.`);
  return <div className="workspace-git" role="group" aria-label={`${workspace.name} Git summary`}>
    <div className="workspace-card-top">
      <span className={'pr-symbol pr-' + kind} role="img" aria-label={prLabel} tabIndex={0}
        title={(api.mode === 'demo' ? 'SIMULATED · ' : '') + prLabel + ' · ' + prDetails} aria-busy={!statusError && !value}>
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
      <div className="workspace-card-actions">
      {workspace.managed && <button type="button" className="icon workspace-remove" disabled={disabled} aria-label={`Remove worktree ${workspace.name}`} title="Remove worktree…" onClick={onRemove}><Trash2 size={12} /></button>}
      <button className="icon git-refresh" aria-label={`Refresh Git and PR status for ${workspace.name}`} title="Refresh Git and PR status (GitHub retry cooldown: 5 seconds)"
        disabled={disabled || statusBusy} onClick={() => { void git.refresh(); }}>
        <RefreshCw size={11} className={statusBusy ? 'spin' : ''} />
      </button>
      </div>
    </div>
  </div>;
}
