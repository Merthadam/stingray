// "Describe…" / "Edit description" in the flowchart inspector: writes the step's `explain:` entry into the view file
// (api.saveExplanation); the view recomputes through its views-changed event.
import { useState } from 'react';
import { Pencil } from 'lucide-react';
import type { DiagramNode } from '../../../../shared/contracts/views';

const MAX_TEXT = 500;

export function DescribeEditor({ target, decision, onSave, disabled }: {
  target: Pick<DiagramNode, 'explanation' | 'explanationStatus'>; decision: boolean;
  onSave?(text: string): Promise<void>; disabled?: string;
}) {
  const [text, setText] = useState<string | null>(null); // null: closed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const own = !!target.explanationStatus; // an `explain:` entry, not a docstring
  const save = async (value: string) => {
    setBusy(true); setError('');
    try { await onSave!(value); setText(null); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (text === null) return <div className="flow-inspector-actions">
    <button disabled={!onSave} title={onSave ? 'Write this step’s description into the view file' : disabled}
      onClick={() => { setText(target.explanation ?? ''); setError(''); }}>
      <Pencil size={12} />{target.explanation ? 'Edit description' : 'Describe…'}</button></div>;
  return <form className="flow-describe" onSubmit={e => { e.preventDefault(); if (text.trim()) void save(text); }}>
    <textarea aria-label="Description" autoFocus rows={3} maxLength={MAX_TEXT} value={text} disabled={busy}
      onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setText(null); } }} />
    {decision && <small>Phrase it as the same question: Yes/No follow it.</small>}
    {target.explanation && !own && <small>Overrides the docstring in this view.</small>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="flow-describe-actions">
      <button type="submit" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save'}</button>
      <button type="button" disabled={busy} onClick={() => setText(null)}>Cancel</button>
      {own && <button type="button" disabled={busy} title="Delete this view’s entry (the docstring shows again)" onClick={() => void save('')}>Remove</button>}
    </div>
  </form>;
}
