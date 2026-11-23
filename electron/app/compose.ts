// The only place that builds adapters and core services and connects them (publishers, lifecycle listeners, cross-wiring).
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { activityContract } from '../../shared/contracts/activity';
import { gitContract } from '../../shared/contracts/git';
import { runtimeContract } from '../../shared/contracts/runtime';
import { terminalsContract } from '../../shared/contracts/terminals';
import { viewsContract } from '../../shared/contracts/views';
import { confirmTerminalLink } from '../adapters/driven/electron-shell/dialogs';
import { sender } from '../adapters/driven/electron-shell/sender';
import { clearWorkspaceSession } from '../adapters/driven/electron-shell/sessions';
import { electronShell } from '../adapters/driven/electron-shell/shell';
import { installLauncher } from '../adapters/driven/fs/launcher';
import { nodeLinkTargets } from '../adapters/driven/fs/link-targets';
import { database, readState } from '../adapters/driven/sqlite/database';
import { sqliteSettingsRepository } from '../adapters/driven/sqlite/settings-repository';
import { ActivityVisibility } from '../core/activity';
import { CloneLock, WorkspaceLifecycle } from '../core/git';
import { StinggraphSettings } from '../core/stinggraph';
import { TerminalLinkOpener } from '../core/terminals';
import { registerRemovalListeners } from './removal-listeners';
import { ActivityHistory, ActivityService, ActivityShell } from './wiring/activity';
import { EditorService } from './wiring/app';
import { GitService, GitStateService, PullRequestService, Store } from './wiring/git';
import { ContainerService, LiveViews, PortService } from './wiring/runtime';
import { createCodeGraphProcessHost, removeOverlay } from './wiring/stinggraph';
import { Terminals } from './wiring/terminals';
import { ViewService, ViewStateStore } from './wiring/views';

export function compose(o: { dataDir: string; distDir: string; window: () => BrowserWindow | undefined }) {
  const window = () => { const w = o.window(); return w && !w.isDestroyed() ? w : undefined; };
  const lifecycle = new WorkspaceLifecycle();
  const store = new Store(o.dataDir);
  const viewState = new ViewStateStore(o.dataDir);
  const editors = new EditorService(o.dataDir, { showItemInFolder: file => electronShell.showItemInFolder(file) });
  const activityEvents = sender(activityContract, window);
  const activity = new ActivityService(snapshot => activityEvents.onActivity(snapshot));
  const activityShell = new ActivityShell();
  const terminalEvents = sender(terminalsContract, window);
  const terminals = new Terminals(event => terminalEvents.onTerminal(event), activity, activityShell);
  const git = new GitService(store, id => terminals.countWorkspace(id), undefined, lifecycle);
  const containers = new ContainerService();
  const ports = new PortService(() => terminals.portRoots());
  const pullRequests = new PullRequestService();
  const gitEvents = sender(gitContract, window);
  const gitState = new GitStateService(git, pullRequests, state => gitEvents.onStatusChanged(state),
    () => { const w = window(); return Boolean(w && w.isVisible() && !w.isMinimized()); });
  git.onStatus = (id, status) => gitState.observe(id, status);
  pullRequests.onListChange = () => gitState.listChanged();
  const stinggraphSettings = new StinggraphSettings(sqliteSettingsRepository(o.dataDir), () => readState(database(o.dataDir)), o.dataDir);
  const codegraph = createCodeGraphProcessHost({ sharedBase: id => stinggraphSettings.sharedBaseTarget(id) });
  const viewsEvents = sender(viewsContract, window);
  const grammarPath = path.join(o.distDir, 'tree-sitter-python.wasm');
  const views = new ViewService({ host: codegraph, grammarPath, emit: event => viewsEvents.onViewsChanged(event),
    dbSchema: { dbSchema: (id, root) => codegraph.dbSchema(id, root, grammarPath), sqlSchema: (id, root) => codegraph.sqlSchema(id, root) } });
  const runtimeEvents = sender(runtimeContract, window);
  const liveViews = new LiveViews(event => runtimeEvents.onLiveView(event));
  const cloneLock = new CloneLock();
  const visibility = new ActivityVisibility({ terminals, activity,
    isWindowFocusedAndVisible: () => { const w = window(); return Boolean(w && w.isFocused() && w.isVisible() && !w.isMinimized()); } });
  const linkOpener = new TerminalLinkOpener({ terminals, workspacePath: async id => (await git.workspace(id)).path,
    confirm: link => { const w = window(); return w ? confirmTerminalLink(w, link) : Promise.resolve(false); },
    actions: electronShell, targets: nodeLinkTargets });
  registerRemovalListeners(lifecycle, {
    terminals, views, graph: codegraph, gitState, viewState, activity, repoMap: git.repoMap,
    overlays: { repoOf: async id => (await store.load()).workspaces.find(w => w.id === id)?.repoId, remove: (repoId, id) => removeOverlay(o.dataDir, repoId, id) },
    sessions: { clearWorkspaceSession },
  });
  return { store, viewState, editors, activity, activityShell, terminals, git, containers, ports, pullRequests, gitState,
    stinggraphSettings, codegraph, views, liveViews, cloneLock, visibility, linkOpener, lifecycle };
}
export type Services = ReturnType<typeof compose>;

/** Startup before the window opens, in this order: views launcher, activity socket, shell integration, history. */
export async function startServices(s: Services, o: { dataDir: string; distDir: string; execPath: string }) {
  // `stingray-views` for agents in Stingray terminals; views-cli.cjs sits next to codegraph-worker.cjs (asar is off).
  // Installed before the zsh proxies, which keep its directory on PATH after the user's rc files.
  const viewsBin = path.join(o.dataDir, 'bin');
  await installLauncher({ binDir: viewsBin, execPath: o.execPath, cliPath: path.join(o.distDir, 'views-cli.cjs') })
    .then(() => { s.terminals.viewsBin = viewsBin; }, error => console.error('Could not install stingray-views:', error));
  try {
    if (process.platform !== 'win32') {
      await s.activity.start();
      await s.activityShell.prepare(s.activity.directory, {
        extension: path.join(o.distDir, 'pi-extension.js'), hookClient: path.join(o.distDir, 'hook-client.cjs'),
        execPath: o.execPath, endpoint: s.activity.endpoint,
      }, s.terminals.viewsBin);
      s.activity.restore(new ActivityHistory(o.dataDir)); // after prepare: a failed setup closes the service
    }
  } catch { s.activityShell.startup = ''; await s.activity.close(); }
}
