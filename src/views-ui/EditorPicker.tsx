import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { api } from '../api';
import type { EditorId, EditorSettings } from '../views';

const EDITOR_LABELS: Record<EditorId, string> = { 'repo-map': 'Repo Map (Stingray)', vscode: 'VS Code', cursor: 'Cursor', zed: 'Zed', system: 'System default' };

/** "Open in: VS Code ▾" — where source links open; stored in app data by the main process. */
export function EditorPicker() {
  const [settings, setSettings] = useState<EditorSettings | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { api.editorSettings().then(setSettings, e => setError((e as Error).message)); }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!(e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node))) return; setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  const choose = async (editor: EditorId) => {
    setOpen(false);
    try { setSettings(await api.setEditor(editor)); setError(''); } catch (e) { setError((e as Error).message); }
  };
  const options = settings ? [...new Set<EditorId>(['repo-map', ...settings.available, 'system'])] : [];
  return <div className="views-editor-picker" ref={root}>
    <button className="views-tool" aria-haspopup="menu" aria-expanded={open} disabled={!settings} title={error || 'Editor for source links'}
      onClick={() => setOpen(v => !v)}>Open in: {settings ? EDITOR_LABELS[settings.selected] : '…'}<ChevronDown size={12} /></button>
    {open && settings && <div className="views-menu" role="menu" aria-label="Open source in">
      {options.map(id => <button key={id} role="menuitemradio" aria-checked={settings.selected === id} onClick={() => void choose(id)}>
        <span className="views-menu-check">{settings.selected === id && <Check size={12} />}</span>{EDITOR_LABELS[id]}</button>)}
    </div>}
  </div>;
}
