import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronRight, CircleHelp, Columns2, FolderGit2, GitBranch, Globe, LayoutGrid, Map, Monitor, Plus, Search, Settings2, ShieldCheck, TerminalSquare, Trash2, X } from 'lucide-react';
import { api } from './api';
import type { GitStatus, State, TerminalInfo } from './shared';
import { TerminalPane } from './TerminalPane';
import { BrowserPane } from './BrowserPane';
import { Modal } from './Modal';
import { ProjectHome } from './ProjectHome';
import { AddProjectForm } from './AddProjectForm';
import { RepoMap } from './RepoMap';
import { navigationKey, parseSelection, resolveSelection, type ProjectSelection } from './project-navigation';

const emptyState: State = { version: 1, repos: [], workspaces: [] };
export default function App() {
  const [state, setState] = useState<State>(emptyState);
  const [navigation, setNavigation] = useState<ProjectSelection>(() => {
    try { return parseSelection(sessionStorage.getItem(navigationKey)); } catch { return null; }
  });
  const [projectQuery, setProjectQuery] = useState('');
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeTerminals, setActiveTerminals] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [showBrowser, setShowBrowser] = useState(true);
  const [split, setSplit] = useState(false);
  const [tab, setTab] = useState<'workspace' | 'changes'>('workspace');
  const [modal, setModal] = useState<'open' | 'create' | 'remove' | 'close-terminal' | 'about' | null>(null);
  const [closeId, setCloseId] = useState('');
  const [branch, setBranch] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<GitStatus | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const statusSequence = useRef(0);
  const selection = resolveSelection(state, navigation);
  const selected = selection?.workspaceId || '';
  const workspace = state.workspaces.find(w => w.id === selected);
  const repo = state.repos.find(r => r.id === selection?.repoId);
  const projectWorkspaces = state.workspaces.filter(w => w.repoId === repo?.id);
  const filteredWorkspaces = projectWorkspaces.filter(w => (w.name + ' ' + w.branch).toLowerCase().includes(query.toLowerCase()));
  const workspaceTerminals = terminals.filter(t => t.workspaceId === selected);
  const active = activeTerminals[selected] || workspaceTerminals[0]?.id;
  const visibleTerminalIds = split ? [active, workspaceTerminals.find(t => t.id !== active)?.id] : [active];
  const setErrorMessage = useCallback((message: string) => setError(message), []);
  const apply = (next: State) => setState(next);
  function openProject(repoId: string) {
    setNavigation(resolveSelection(state, { repoId, workspaceId: '' }));
    setQuery(''); setTab('workspace'); setError('');
  }
  function allProjects() { setNavigation(null); setError(''); }
  useEffect(() => {
    if (initializing || loadFailed) return;
    try { sessionStorage.setItem(navigationKey, JSON.stringify(selection)); } catch { /* Navigation remains usable without session storage. */ }
  }, [initializing, loadFailed, selection?.repoId, selection?.workspaceId]);
  async function load() {
    setInitializing(true); setLoadFailed(false); setError('');
    try { const [next, ts] = await Promise.all([api.state(), api.terminals()]); apply(next); setTerminals(ts); }
    catch (e) { setLoadFailed(true); setError((e as Error).message); }
    finally { setInitializing(false); }
  }
  useEffect(() => { void load(); return api.onTerminal(e => { if (e.exitCode !== undefined) setTerminals(ts => ts.map(t => t.id === e.id ? { ...t, exited: true } : t)); }); }, []);
  const refreshStatus = useCallback(async () => {
    const sequence = ++statusSequence.current;
    if (!selected) { setStatus(null); return; }
    try { const next = await api.gitStatus(selected); if (sequence === statusSequence.current) setStatus(next); }
    catch { if (sequence === statusSequence.current) setStatus(null); }
  }, [selected]);
  useEffect(() => { setStatus(null); void refreshStatus(); }, [refreshStatus, tab]);
  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError('');
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function newTerminal(doSplit = false) {
    if (!workspace) return;
    await run(async () => {
      const t = await api.createTerminal(workspace.id);
      setTerminals(ts => [...ts, t]); setActiveTerminals(a => ({ ...a, [workspace.id]: t.id }));
      setTab('workspace'); if (doSplit) setSplit(true);
    });
  }
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || modal) return;
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); search.current?.focus(); }
      if (e.key.toLowerCase() === 't') { e.preventDefault(); void newTerminal(); }
      if (e.key.toLowerCase() === 'b' && workspace) { e.preventDefault(); setShowBrowser(v => !v); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  });
  function openModal(value: typeof modal) { setError(''); setBranch(''); setConfirmation(''); setModal(value); }
  return <div className="app-shell">
    <header className="titlebar"><div className="window-space" /><span className="window-title">Stingray</span><span className="title-meta"><Monitor size={12} /> Local workspace</span></header>
    {api.mode === 'demo' && <div className="demo-banner"><span>Browser demo</span> Workspaces and terminals are simulated. Run the desktop app for real Git and shell access.</div>}
    <div className="app-body">
      <aside className="sidebar">
        <div className="brand"><img src="./stingray.svg" alt="" /><strong>stingray</strong><span className="version">0.1</span></div>
        {repo ? <>
          <button className="project-back" disabled={busy} onClick={allProjects}><ArrowLeft size={14} /> All projects</button>
          <div className="project-current"><span className="project-mark"><FolderGit2 size={18} /></span><strong>{repo.name}</strong></div>
          <label className="search"><Search size={14} /><input ref={search} aria-label="Find a workspace" placeholder="Find a workspace…" value={query} onChange={e => setQuery(e.target.value)} /><kbd>⌘ K</kbd></label>
          <div className="section-label">WORKSPACES <span>{projectWorkspaces.length}</span></div>
          <nav className="projects" aria-label="Project workspaces">{filteredWorkspaces.map(w =>
            <button key={w.id} disabled={busy} className={'workspace-link ' + (selected === w.id ? 'selected' : '')} aria-current={selected === w.id ? 'page' : undefined} title={w.path} onClick={() => { setNavigation({ repoId: repo.id, workspaceId: w.id }); setError(''); }}>
              <GitBranch size={14} /><div><span>{w.name}</span><small>{w.managed ? 'Git worktree' : 'Local repository'}</small></div>{terminals.some(t => t.workspaceId === w.id && !t.exited) && <span className="activity-dot" aria-label="Running terminal" />}
            </button>)}{!filteredWorkspaces.length && <div className="sidebar-empty">No matching workspaces.</div>}</nav>
          <div className="sidebar-actions"><button disabled={busy} onClick={() => openModal('create')}><Plus size={15} /> New worktree</button></div>
        </> : <><button className="project-home-selected" onClick={() => setProjectQuery('')} aria-current="page"><LayoutGrid size={16} />Projects<span>{state.repos.length}</span></button><div className="project-sidebar-note">A place for each repository.<br />A workspace for each idea.</div></>}
        <div className="sidebar-bottom"><div className="local-card"><span className="local-indicator" /><div>On your machine<small>No account. No cloud sync.</small></div><ShieldCheck size={15} /></div><button onClick={() => openModal('about')}><CircleHelp size={15} /> Help & shortcuts <ArrowUpRight size={13} /></button></div>
      </aside>
      <main className="main">
        {error && !modal && <div className="error-banner" role="alert"><span>{error}</span><button className="icon" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
        {initializing || loadFailed || !workspace ? <ProjectHome state={state} terminals={terminals} query={projectQuery} setQuery={setProjectQuery} searchRef={search} loading={initializing} failed={loadFailed} onOpen={openProject} onAdd={() => openModal('open')} onRetry={() => void load()} /> : <>
          <div className="workspace-header"><div className="workspace-heading"><span className="branch-icon"><GitBranch size={19} /></span><div><h1>{workspace.name}</h1><p>{repo?.name}<ChevronRight size={11} />{workspace.managed ? 'Worktree' : 'Repository'}</p></div></div>
            <div className="header-actions"><button className={'icon ' + (showBrowser ? 'toggled' : '')} aria-label="Toggle browser preview" title="Toggle browser preview · ⌘ B" onClick={() => setShowBrowser(v => !v)}><Globe size={16} /></button>{workspace.managed && <button className="icon" aria-label="Remove worktree" title="Remove worktree" onClick={() => openModal('remove')}><Trash2 size={15} /></button>}<button className="secondary" disabled={busy} onClick={() => void newTerminal()}><Plus size={15} /> New terminal</button></div>
          </div>
          <div className="workspace-tabs" role="tablist" aria-label="Workspace views"><button role="tab" aria-selected={tab === 'workspace'} className={tab === 'workspace' ? 'active' : ''} onClick={() => setTab('workspace')}><Columns2 size={14} /> Workspace</button><button role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}><Map size={14} /> Repo Map {status && <span className="count">{status.changes.length}</span>}</button><span className="workspace-path" title={workspace.path}>{workspace.path}</span></div>
          <div className={'workspace-content ' + (showBrowser ? 'with-browser' : '')} style={{ display: tab === 'workspace' ? 'flex' : 'none' }}>
            <section className="terminal-area" aria-label="Terminals">
              <div className="terminal-tabs"><div className="terminal-tab-scroll">{workspaceTerminals.map(t => <div key={t.id} className={'terminal-tab ' + (t.id === active ? 'active' : '')}><button onClick={() => setActiveTerminals(a => ({ ...a, [selected]: t.id }))}><TerminalSquare size={13} /><span>{t.title}</span>{t.exited && <span className="exited">exited</span>}</button><button className="icon close-tab" aria-label={'Close ' + t.title} onClick={() => { setCloseId(t.id); openModal('close-terminal'); }}><X size={12} /></button></div>)}</div><div className="terminal-tools"><button className="icon" aria-label="New terminal" title="New terminal · ⌘ T" disabled={busy} onClick={() => void newTerminal()}><Plus size={14} /></button><button className={'icon ' + (split ? 'toggled' : '')} aria-label="Split terminals" title="Split terminals" disabled={busy || !workspaceTerminals.length} onClick={() => { if (workspaceTerminals.length < 2) void newTerminal(true); else setSplit(v => !v); }}><Columns2 size={14} /></button></div></div>
              {!workspaceTerminals.length && <div className="terminal-empty"><TerminalSquare size={30} strokeWidth={1.2} /><h2>Make room for your next idea.</h2><p>Open a shell in <strong>{workspace.name}</strong>.<br />Run Pi, Claude Code, Codex, or any installed CLI.</p><button className="secondary" disabled={busy} onClick={() => void newTerminal()}><Plus size={14} /> Open terminal</button><span className="shortcut-hint">or press <kbd>⌘ T</kbd></span></div>}
              <div className={'terminal-grid ' + (split && workspaceTerminals.length > 1 ? 'split' : '')}>
                {terminals.filter(t => projectWorkspaces.some(w => w.id === t.workspaceId)).map(t => <TerminalPane key={t.id} info={t} visible={t.workspaceId === selected && visibleTerminalIds.includes(t.id) && tab === 'workspace'} onError={setErrorMessage} />)}
              </div>
              <div className="terminal-footer"><span><span className="activity-dot" /> {workspaceTerminals.filter(t => !t.exited).length} running</span><span>{api.mode === 'desktop' ? 'Shell · local' : 'Simulated shell'}</span></div>
            </section>
            {showBrowser && <BrowserPane key={workspace.id} workspace={workspace} onNavigate={async url => { const next = await api.preview(workspace.id, url); apply(next); }} onClose={() => setShowBrowser(false)} />}
          </div>
          {tab === 'changes' && <RepoMap key={workspace.id} workspace={workspace} terminals={workspaceTerminals} onStatus={setStatus} onPreview={() => { setShowBrowser(true); setTab('workspace'); }} />}
        </>}
      </main>
    </div>
    <footer className="statusbar"><span><span className="local-indicator" /> {api.mode === 'desktop' ? 'Local only' : 'Simulated demo'}<span className="status-divider">/</span>{repo?.name || 'Projects home'}</span><span>{workspace && <><GitBranch size={11} />{status?.branch || workspace.branch}<span className="status-divider">/</span></>}<ShieldCheck size={11} /> Stingray 0.1.0</span></footer>
    {modal && <Modal title={{ open: 'Add project', create: 'Create a worktree', remove: 'Remove this worktree?', 'close-terminal': 'Close terminal?', about: 'Built for focused work.' }[modal]} busy={busy} onClose={() => { setModal(null); setError(''); }}>
      {api.mode === 'demo' && <p className="info-box">Browser demo: actions here are simulated. No local files or processes will change.</p>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {modal === 'open' && <AddProjectForm busy={busy} run={run} clearError={() => setError('')} onCancel={() => { setModal(null); setError(''); }} onAdded={next => { apply(next); setNavigation(null); setProjectQuery(''); setModal(null); }} />}
      {modal === 'create' && <form onSubmit={e => { e.preventDefault(); if (workspace) void run(async () => { const next = await api.createWorkspace(workspace.repoId, branch.trim()); apply(next); const created = next.workspaces.find(w => w.repoId === workspace.repoId && w.branch === branch.trim()); if (created) setNavigation({ repoId: workspace.repoId, workspaceId: created.id }); setModal(null); }); }}><p className="modal-description">Create a new branch from <strong>{repo?.name}</strong>'s current HEAD in a separate working directory. Your existing files stay untouched.</p><label className="field">New branch name<input autoFocus aria-label="New branch name" placeholder="feature/my-next-idea" maxLength={100} value={branch} onChange={e => setBranch(e.target.value)} required /></label><div className="info-box"><GitBranch size={16} /><span>Creates a real branch and worktree. No commit, push, dependency install, or agent launch.</span></div><div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setModal(null)}>Cancel</button><button className="primary" disabled={busy || !branch.trim()}>{busy ? 'Creating…' : 'Create worktree'}</button></div></form>}
      {modal === 'remove' && <form onSubmit={e => { e.preventDefault(); if (workspace) void run(async () => { apply(await api.removeWorkspace(workspace.id, confirmation)); setModal(null); }); }}><p className="modal-description">Deletes this worktree directory, <strong>not its branch or commits</strong>. Removal is refused if any terminals, modified, untracked, or ignored files remain.</p><p className="confirm-branch">Type <strong>{workspace?.branch}</strong> to confirm.</p><label className="field">Branch confirmation<input autoFocus aria-label="Branch confirmation" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label><div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setModal(null)}>Keep worktree</button><button className="danger" disabled={busy || confirmation !== workspace?.branch}>{busy ? 'Checking…' : 'Remove worktree'}</button></div></form>}
      {modal === 'close-terminal' && <><p className="modal-description">This stops the shell and sends a hangup to its foreground jobs. Switching workspaces keeps terminals running; closing a terminal does not.</p><div className="modal-actions"><button className="secondary" onClick={() => setModal(null)} disabled={busy}>Keep running</button><button className="danger" disabled={busy} onClick={() => void run(async () => { await api.closeTerminal(closeId); setTerminals(ts => ts.filter(t => t.id !== closeId)); setActiveTerminals(a => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== closeId))); setModal(null); })}>Close terminal</button></div></>}
      {modal === 'about' && <><p className="modal-description">A local-first home for your coding agents. Inspired by Superset's warm dark design, with an independent Stingray identity.</p><div className="shortcut-list"><span>Find a project or workspace <kbd>⌘ / Ctrl K</kbd></span><span>New terminal <kbd>⌘ / Ctrl T</kbd></span><span>Toggle browser <kbd>⌘ / Ctrl B</kbd></span></div><div className="info-box"><Settings2 size={17} /><span>Terminals stay alive on Projects home, when switching projects/workspaces, or reloading the UI, but not when quitting. Reload keeps your view; a new app window starts at Projects. Workspaces and preview addresses are saved. Browser permissions, downloads, and popups are blocked.</span></div><p className="fine-print">No telemetry, accounts, cloud sync, or bundled agents. Run your installed agent CLI in a terminal. macOS-first development build.</p><div className="modal-actions"><button className="primary" onClick={() => setModal(null)}>Back to work</button></div></>}
    </Modal>}
  </div>;
}
