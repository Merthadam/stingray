import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { RemovalReview, State, Workspace } from './shared';
import './worktree-removal.css';

export function RemoveWorktreeForm({ workspace, busy, onBusy, onRemoved, onCancel }: {
  workspace: Workspace; busy: boolean; onBusy: (busy: boolean) => void;
  onRemoved: (state: State) => void; onCancel: () => void;
}) {
  const [review, setReview] = useState<RemovalReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const sequence = useRef(0);
  async function refresh(clearError = true) {
    const current = ++sequence.current;
    setLoading(true); setReview(null); setAcknowledge(false); setConfirmation('');
    if (clearError) setError('');
    try {
      const result = await api.reviewRemoval(workspace.id);
      if (current === sequence.current) setReview(result);
    } catch (e) { if (current === sequence.current) setError((e as Error).message); }
    finally { if (current === sequence.current) setLoading(false); }
  }
  useEffect(() => { void refresh(); return () => { ++sequence.current; }; }, [workspace.id]);
  const warning = review && (review.push.kind === 'unknown' || review.push.ahead > 0);
  const blocked = !review || review.blockers.length > 0;
  async function submit() {
    if (busy || loading || blocked || confirmation !== review!.branch || (warning && !acknowledge)) return;
    onBusy(true); setError('');
    try {
      const next = await api.removeWorkspace(workspace.id, confirmation, { token: review!.token, acknowledge });
      onRemoved(next);
    } catch (e) {
      setError((e as Error).message);
      await refresh(false);
    } finally { onBusy(false); }
  }
  return <form className="remove-worktree-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <p className="modal-description">Removes <strong>{workspace.name}</strong>'s worktree directory. <strong>Keeps its branch and commits</strong>, including unpushed commits. Does not stop terminals or delete the branch.</p>
    <code className="removal-path">{workspace.path}</code>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {loading && <p role="status">Checking worktree safety…</p>}
    {review && <div className="removal-review" aria-label="Worktree safety checks">
      {review.blockers.length > 0 ? <div className="inline-error" role="alert"><strong>Removal is blocked</strong><ul>{review.blockers.map(message => <li key={message}>{message}</li>)}</ul></div> : <p>No local file changes or open terminals found.</p>}
      <div className={warning ? 'removal-warning' : 'info-box'} role="status">
        {review.push.kind === 'unknown' ? review.push.message : <span>
          {review.push.ahead > 0 ? `${review.push.ahead} unpushed commit${review.push.ahead === 1 ? '' : 's'} ahead of ` : 'No commits ahead of '}
          <strong>{review.push.upstream}</strong> in local tracking data.
          {review.push.behind > 0 && ` ${review.push.behind} commits behind.`}
        </span>}
      </div>
      <p className="fine-print">Local remote-tracking data may be stale. No fetch or remote check is performed. Branch deletion is not part of this action.</p>
      {warning && <label className="removal-ack"><input type="checkbox" checked={acknowledge} disabled={busy || loading} onChange={e => setAcknowledge(e.target.checked)} />I understand commits may not be pushed; the branch and commits will be kept.</label>}
    </div>}
    <button type="button" className="secondary" disabled={busy || loading} onClick={() => void refresh()}>Recheck safety</button>
    <p className="confirm-branch">Type <strong>{review?.branch || workspace.branch}</strong> to confirm.</p>
    <label className="field">Branch confirmation<input autoFocus aria-label="Branch confirmation" autoComplete="off" value={confirmation} disabled={busy || loading} onChange={e => setConfirmation(e.target.value)} /></label>
    <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onCancel}>Keep worktree</button><button className="danger" disabled={busy || loading || blocked || confirmation !== review?.branch || Boolean(warning && !acknowledge)}>{busy ? 'Checking…' : 'Remove worktree'}</button></div>
  </form>;
}
