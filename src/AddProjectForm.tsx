import { useRef, useState } from 'react';
import { FolderOpen, LoaderCircle } from 'lucide-react';
import { api } from './api';
import { cloneDestinationSchema, repositoryUrlSchema, type State } from './shared';
import './add-project.css';

export function AddProjectForm({ busy, run, onAdded, onCancel, clearError }: {
  busy: boolean; run: (action: () => Promise<void>) => Promise<void>;
  onAdded: (state: State) => void; onCancel: () => void; clearError: () => void;
}) {
  const [mode, setMode] = useState<'local' | 'url'>('local');
  const [repoPath, setRepoPath] = useState('');
  const [url, setUrl] = useState('');
  const [destination, setDestination] = useState('');
  const [cloning, setCloning] = useState(false);
  const pending = useRef(false);
  const switchMode = (next: typeof mode) => { if (!busy) { setMode(next); clearError(); } };
  async function submit() {
    if (pending.current) return;
    pending.current = true;
    try {
      await run(async () => {
        if (mode === 'local') { onAdded(await api.openRepository(repoPath)); return; }
        if (!repositoryUrlSchema.safeParse(url.trim()).success) throw new Error('Use an HTTPS or SSH Git URL without passwords, tokens, query strings, or fragments.');
        if (!cloneDestinationSchema.safeParse(destination).success) throw new Error('Choose a new absolute folder path, without trailing slash or dot segments.');
        setCloning(true);
        try { onAdded(await api.cloneRepository(url.trim(), destination)); } finally { setCloning(false); }
      });
    } finally { pending.current = false; }
  }
  return <form onSubmit={e => { e.preventDefault(); void submit(); }} aria-busy={busy}>
    <div className="add-project-modes" role="group" aria-label="Project source">
      <button type="button" aria-pressed={mode === 'local'} disabled={busy} onClick={() => switchMode('local')}>Local folder</button>
      <button type="button" aria-pressed={mode === 'url'} disabled={busy} onClick={() => switchMode('url')}>Repository URL</button>
    </div>
    {mode === 'local' ? <>
      <p className="modal-description">Open an existing, trusted Git repository on your machine.</p>
      <label className="field">Repository path<input autoFocus aria-label="Repository path" disabled={busy} maxLength={4096} placeholder="/Users/you/Projects/my-app" value={repoPath} onChange={e => setRepoPath(e.target.value)} required /></label>
      <button className="secondary" type="button" disabled={busy} onClick={() => void run(async () => { const next = await api.pickRepository(); if (next) onAdded(next); })}><FolderOpen size={15} /> Browse folders</button>
    </> : <>
      <p className="modal-description">Clone a trusted repository to a new folder. The project appears only after cloning and saving succeed.</p>
      <label className="field">Repository URL<input aria-label="Repository URL" disabled={busy} maxLength={2048} placeholder="https://github.com/owner/project.git" autoComplete="off" spellCheck={false} value={url} onChange={e => setUrl(e.target.value)} required /></label>
      <label className="field">New local folder<input aria-label="New local folder" disabled={busy} maxLength={4096} placeholder="/Users/you/Projects/project" value={destination} onChange={e => setDestination(e.target.value)} required /></label>
      <button className="secondary" type="button" disabled={busy} onClick={() => void run(async () => {
        const parent = await api.pickCloneParent();
        if (parent) {
          const suggested = url.trim().split(/[/:]/).at(-1)?.replace(/\.git$/, '') || 'project';
          const name = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(suggested) && suggested !== '..' ? suggested : 'project';
          setDestination(parent.replace(/\/$/, '') + '/' + name);
        }
      })}><FolderOpen size={15} /> Choose parent folder</button>
      <p className="fine-print">HTTPS or SSH (including git@host:owner/project.git). Uses existing Git/SSH access; configure private-repo access outside Stingray. No passwords or tokens in the URL. The destination must not already exist.</p>
    </>}
    <p className="fine-print">No setup, dependency installs, submodules, or agents start automatically. Trusted local Git credentials, SSH configuration, and checkout filters may run.</p>
    {cloning && <div className="info-box clone-progress" role="status"><LoaderCircle className="spin" size={16} /><span>Cloning and saving project… Keep this window open. This can take up to five minutes.</span></div>}
    <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button><button className="primary" disabled={busy || (mode === 'local' ? !repoPath.trim() : !url.trim() || !destination.trim())}>{busy ? (cloning ? 'Cloning…' : 'Opening…') : mode === 'local' ? 'Open repository' : 'Clone project'}</button></div>
  </form>;
}
