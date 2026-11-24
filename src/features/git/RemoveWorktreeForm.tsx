import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import type { RemovalResult, RemovalReview, Workspace } from '../../../shared/contracts/git';
import './worktree-removal.css';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function RemoveWorktreeForm({ workspace, busy, onBusy, onRemoved, onCancel }: {
  workspace: Workspace; busy: boolean; onBusy: (busy: boolean) => void;
  onRemoved: (result: Extract<RemovalResult, { state: unknown }>) => void; onCancel: () => void;
}) {
  const [review, setReview] = useState<RemovalReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const sequence = useRef(0);
  async function refresh(clearError = true) {
    const current = ++sequence.current;
    setLoading(true); setReview(null); setDiscard(false); setDeleteBranch(false);
    if (clearError) setError('');
    try {
      const result = await api.reviewRemoval(workspace.id);
      if (current === sequence.current) setReview(result);
    } catch (e) { if (current === sequence.current) setError((e as Error).message); }
    finally { if (current === sequence.current) setLoading(false); }
  }
  useEffect(() => { void refresh(); return () => { ++sequence.current; }; }, [workspace.id]);
  const dirty = Boolean(review && review.changes.tracked + review.changes.untracked > 0);
  const blocked = !review || review.blockers.length > 0;
  const disabled = busy || loading || blocked || (dirty && !discard);
  async function submit() {
    if (disabled) return;
    onBusy(true); setError('');
    try {
      const result = await api.removeWorkspace(workspace.id, { discard: dirty && discard, deleteBranch: Boolean(review!.merged) && deleteBranch, fingerprint: review!.fingerprint });
      if ('stale' in result) {
        ++sequence.current; setReview(result.stale); setDiscard(false); setDeleteBranch(false);
        setError('New changes appeared since you reviewed. Review again.');
        return;
      }
      onRemoved(result);
    } catch (e) {
      setError((e as Error).message);
      await refresh(false);
    } finally { onBusy(false); }
  }
  const hidden = review ? review.changes.tracked + review.changes.untracked - review.changes.paths.length : 0;
  return <form className="remove-worktree-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <p className="modal-description">Deletes <strong>{workspace.name}</strong>'s worktree folder, including ignored files such as dependencies and build output. The branch <strong>{workspace.branch}</strong> and its commits are kept{review?.merged ? ' unless you choose to delete it below' : ''}.</p>
    <code className="removal-path">{workspace.path}</code>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {loading && <p role="status">Checking worktree…</p>}
    {review && <div className="removal-review" aria-label="Worktree checks">
      {review.blockers.length > 0 && <div className="inline-error" role="alert"><strong>Removal is blocked</strong><ul>{review.blockers.map(message => <li key={message}>{message}</li>)}</ul></div>}
      {dirty ? <div className="removal-warning" role="status">
        <strong>{[review.changes.tracked && plural(review.changes.tracked, 'modified file'), review.changes.untracked && plural(review.changes.untracked, 'untracked item')].filter(Boolean).join(' and ')} will be permanently deleted.</strong>
        <ul className="removal-files">{review.changes.paths.map(file => <li key={file}><code>{file}</code></li>)}{hidden > 0 && <li>…and {hidden} more</li>}</ul>
        <label className="removal-ack"><input type="checkbox" checked={discard} disabled={busy || loading || blocked} onChange={e => setDiscard(e.target.checked)} />Discard these uncommitted changes</label>
      </div> : review.blockers.length === 0 && <p>No uncommitted changes.</p>}
      {review.terminals > 0 && <p className="info-box" role="status">{plural(review.terminals, 'open terminal')} in this workspace will be closed.</p>}
      <p className="fine-print">{review.push.kind === 'unknown' ? review.push.message : <>
        {review.push.ahead > 0 ? `${plural(review.push.ahead, 'commit')} not pushed to ` : 'No unpushed commits on '}<strong>{review.push.upstream}</strong> (local tracking data).
      </>}</p>
      {review.merged && <label className="removal-ack"><input type="checkbox" checked={deleteBranch} disabled={busy || loading || blocked} onChange={e => setDeleteBranch(e.target.checked)} /><span>Also delete branch <strong>{review.branch}</strong> (merged into {review.merged})</span></label>}
    </div>}
    <div className="modal-actions">
      <button type="button" className="secondary" disabled={busy || loading} onClick={() => void refresh()}>Check again</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Keep worktree</button>
      <button className="danger" disabled={disabled}>{busy ? 'Removing…' : dirty ? 'Discard changes and remove' : 'Remove worktree'}</button>
    </div>
  </form>;
}
