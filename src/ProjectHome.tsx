import type { RefObject } from 'react';
import { ArrowUpRight, FolderGit2, GitBranch, LoaderCircle, Plus, Search, ShieldCheck, TerminalSquare, X } from 'lucide-react';
import type { State, TerminalInfo } from './shared';
import './project-home.css';

export function ProjectHome({ state, terminals, query, setQuery, searchRef, loading, failed, onOpen, onAdd, onRetry }: {
  state: State; terminals: TerminalInfo[]; query: string; setQuery: (value: string) => void;
  searchRef: RefObject<HTMLInputElement | null>; loading: boolean; failed: boolean;
  onOpen: (repoId: string) => void; onAdd: () => void; onRetry: () => void;
}) {
  const projects = state.repos.filter(repo => (repo.name + ' ' + repo.path).toLowerCase().includes(query.toLowerCase()));
  if (loading) return <div className="welcome" role="status"><LoaderCircle className="spin" /><h1>Opening your projects…</h1></div>;
  if (failed) return <div className="welcome"><h1>Couldn’t load your projects.</h1><p>Your saved data has not been replaced.</p><button className="primary" onClick={onRetry}>Retry loading projects</button></div>;
  return <div className="project-home">
    <header className="project-home-heading"><div><div className="eyebrow">YOUR LOCAL WORKSPACE</div><h1>Projects</h1><p>One repository. A place for every worktree.</p></div><button className="primary" onClick={onAdd}><Plus size={15} /> Add project</button></header>
    <label className="search project-search"><Search size={15} /><input ref={searchRef} aria-label="Find a project" placeholder="Find a project…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="icon" aria-label="Clear project search" onClick={() => setQuery('')}><X size={14} /></button>}<span>{projects.length} {projects.length === 1 ? 'project' : 'projects'}</span></label>
    {!state.repos.length ? <section className="project-empty"><FolderGit2 size={34} /><h2>Your next project starts here.</h2><p>Use Add project above to open a local folder or clone a repository URL.<br />No setup or terminals start automatically.</p></section> : !projects.length ? <section className="project-empty"><Search size={28} /><h2>No matching projects.</h2><p>Try another repository name or path.</p><button className="secondary" onClick={() => setQuery('')}>Show all projects</button></section> : <>
      <div className="project-section-heading"><span>ALL PROJECTS <b>{projects.length}</b></span><span>Git repositories</span></div>
      <div className="project-card-grid">{projects.map(repo => {
        const workspaces = state.workspaces.filter(w => w.repoId === repo.id);
        const ids = new Set(workspaces.map(w => w.id));
        const running = terminals.filter(t => ids.has(t.workspaceId) && !t.exited).length;
        const worktrees = workspaces.filter(w => w.managed).length;
        return <button key={repo.id} className="project-card" aria-label={'Open project ' + repo.name} title={repo.path} onClick={() => onOpen(repo.id)}>
          <div className="project-card-top"><span className="project-mark"><FolderGit2 size={23} /></span><ArrowUpRight size={17} /></div>
          <h2>{repo.name}</h2><p>Git repository</p><code>{repo.path}</code>
          <div className="project-card-meta"><span><GitBranch size={13} />{worktrees} {worktrees === 1 ? 'worktree' : 'worktrees'}</span><span><TerminalSquare size={13} />{running} running</span></div>
        </button>;
      })}</div>
    </>}
    <p className="project-home-note"><ShieldCheck size={13} />Opening a project doesn’t start agents, terminals, or setup. Existing terminals keep running.</p>
  </div>;
}
