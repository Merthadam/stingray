import { useState } from 'react';
import { api } from '../../../app/api';
import { Modal } from '../../../shared/Modal';
import type { SaveViewResult, ViewLocalState, ViewResult } from '../../../../shared/contracts/views';
import { saveViewInput } from '../views-tab-model';

const PREVIEW = 8;

/** "Save as view…": writes `.stingray/views/<slug>.yaml` with the hidden tables excluded (and optionally the positions). */
export function SaveViewDialog({ workspaceId, result, state, onClose, onSaved }: {
  workspaceId: string; result: ViewResult; state: ViewLocalState; onClose: () => void; onSaved: (saved: SaveViewResult) => void;
}) {
  const [name, setName] = useState('');
  const [positions, setPositions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const preview = saveViewInput(name, result, state, positions);
  const hasPositions = Object.keys(state.positions).length > 0;
  async function submit() {
    setBusy(true); setError('');
    try { onSaved(await api.saveViewAs(workspaceId, preview)); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <Modal title="Save as view" busy={busy} onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); if (preview.name) void submit(); }}>
      <p className="modal-description">Writes a view file to <code>.stingray/views/</code> in this worktree, based on <strong>{result.name}</strong>. Commit it to share the view.</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <label className="field">Name<input aria-label="View name" placeholder="Core tables" maxLength={80} value={name} onChange={e => setName(e.target.value)} required /></label>
      <p className="views-save-hidden">{preview.exclude.length
        ? <>{preview.exclude.length} of {result.nodes.length} tables hidden: <code>{preview.exclude.slice(0, PREVIEW).join(', ')}{preview.exclude.length > PREVIEW ? ` +${preview.exclude.length - PREVIEW} more` : ''}</code></>
        : `All ${result.nodes.length} tables shown.`}</p>
      <label className="views-save-check"><input type="checkbox" checked={positions} disabled={!hasPositions} onChange={e => setPositions(e.target.checked)} /> Save card positions</label>
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !preview.name}>{busy ? 'Saving…' : 'Save view'}</button></div>
    </form>
  </Modal>;
}
