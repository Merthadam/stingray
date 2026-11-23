import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { urlSchema } from '../shared/contracts/common';
import { appContract } from '../shared/contracts/app';
import { gitContract } from '../shared/contracts/git';
import { repoMapContract } from '../shared/contracts/repo-map';
import { terminalsContract } from '../shared/contracts/terminals';
import { activityContract } from '../shared/contracts/activity';
import { stinggraphContract } from '../shared/contracts/stinggraph';
import { viewsContract } from '../shared/contracts/views';
import { runtimeContract } from '../shared/contracts/runtime';
import { registerContract, type IpcContext } from './app/ipc';
import { sender } from './adapters/driven/electron-shell/sender';
import { closeDatabase, database, readState } from './adapters/driven/sqlite/database';
import { sqliteSettingsRepository } from './adapters/driven/sqlite/settings-repository';
import { GitService, GitStateService, PullRequestService, Store, WorkspaceLifecycle } from './app/wiring/git';
import { gitHandlers } from './adapters/driving/ipc/git';
import { Terminals, openTerminalLink } from './app/wiring/terminals';
import { terminalsHandlers } from './adapters/driving/ipc/terminals';
import { electronShell } from './adapters/driven/electron-shell/shell';
import { ContainerService } from './core/runtime/containers';
import { PortService } from './core/runtime/ports';
import { inspectCdp } from './core/runtime/chrome-inspect';
import { ActivityService, ActivityHistory, ActivityShell } from './app/wiring/activity';
import { activityHandlers } from './adapters/driving/ipc/activity';
import { ViewService } from './core/views';
import { infraServiceById } from '../shared/views/infra/catalog';
import { createCodeGraphProcessHost, removeOverlay } from './app/wiring/stinggraph';
import { stinggraphHandlers } from './adapters/driving/ipc/stinggraph';
import { installLauncher } from './adapters/driven/fs/launcher';
import { saveViewAs } from './core/views/save-view';
import { ViewStateStore } from './core/views/view-state';
import { EditorService } from './core/app/editors';
import { StinggraphSettings, releaseWorkspace } from './core/stinggraph';
import { LiveViews } from './core/runtime/live-view';

app.setName('Stingray');
if (process.env.STINGRAY_DATA_DIR) app.setPath('userData', path.resolve(process.env.STINGRAY_DATA_DIR));
const devUrl = process.env.STINGRAY_DEV_URL;
if (devUrl && devUrl !== 'http://127.0.0.1:5178') throw new Error('Unexpected development URL.');
const rendererUrl = (devUrl ? new URL(devUrl).href : undefined) || pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
if (!app.requestSingleInstanceLock()) {
  console.error(`Stingray is already running with data dir ${app.getPath('userData')}. ` +
    'Quit it, or set STINGRAY_DATA_DIR to another folder.');
  app.exit(1);
}
let win: BrowserWindow;
const currentWindow = () => (win && !win.isDestroyed() ? win : undefined);
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
let quitting = false;
let cloning = false;
let openingLink = false;
const store = new Store(app.getPath('userData'));
const viewState = new ViewStateStore(app.getPath('userData'));
const editors = new EditorService(app.getPath('userData'), { showItemInFolder: file => shell.showItemInFolder(file) });
const activityEvents = sender(activityContract, currentWindow);
const activity = new ActivityService(snapshot => activityEvents.onActivity(snapshot));
const activityShell = new ActivityShell();
let visibleTerminals = new Set<string>();
const terminalEvents = sender(terminalsContract, currentWindow);
const terminals = new Terminals(event => terminalEvents.onTerminal(event), activity, activityShell);
const lifecycle = new WorkspaceLifecycle();
const git = new GitService(store, id => terminals.countWorkspace(id), undefined, lifecycle);
// Close the workspace's terminals and stop its code graph (.codegraph cache) before the folder is cleaned and removed.
lifecycle.onBeforeRemove('terminals', id => terminals.closeWorkspace(id), { blocking: true });
lifecycle.onBeforeRemove('views', id => views.release(id)); // never blocks (logged)
lifecycle.onBeforeRemove('stinggraph', id => releaseWorkspace(codegraph, id), { blocking: true });
const overlayRepos = new Map<string, string>(); // workspaceId -> repoId, captured before the registration is gone
lifecycle.onBeforeRemove('stinggraph overlay', async id => { const w = (await store.load()).workspaces.find(x => x.id === id); if (w) overlayRepos.set(id, w.repoId); });
lifecycle.onRemoveFailed('views', id => views.reopen(id));
lifecycle.onRemoveFailed('stinggraph overlay', id => { overlayRepos.delete(id); });
lifecycle.onAfterRemove('git-state', id => gitState.forget(id));
lifecycle.onAfterRemove('view state', id => viewState.forget(id)); // stale view state must not block a completed removal (logged)
lifecycle.onAfterRemove('activity', id => activity.forgetWorkspace(id));
lifecycle.onAfterRemove('stinggraph overlay', async id => { const repoId = overlayRepos.get(id); overlayRepos.delete(id); if (repoId) await removeOverlay(app.getPath('userData'), repoId, id); });
const lockedSessions = new Set<string>();
const containers = new ContainerService();
const ports = new PortService(() => terminals.portRoots());
const pullRequests = new PullRequestService();
const gitEvents = sender(gitContract, currentWindow);
const gitState = new GitStateService(git, pullRequests, state => gitEvents.onStatusChanged(state),
  () => Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()));
git.onStatus = (id, status) => gitState.observe(id, status);
pullRequests.onListChange = () => gitState.listChanged();
const stinggraphSettings = new StinggraphSettings(sqliteSettingsRepository(app.getPath('userData')), () => readState(database(app.getPath('userData'))), app.getPath('userData'));
const codegraph = createCodeGraphProcessHost({ sharedBase: id => stinggraphSettings.sharedBaseTarget(id) });
const viewsEvents = sender(viewsContract, currentWindow);
const views = new ViewService({ host: codegraph, grammarPath: path.join(__dirname, 'tree-sitter-python.wasm'),
  emit: event => viewsEvents.onViewsChanged(event) });
const runtimeEvents = sender(runtimeContract, currentWindow);
const liveViews = new LiveViews(event => runtimeEvents.onLiveView(event));

function lockSession(partition: string) {
  if (lockedSessions.has(partition)) return;
  lockedSessions.add(partition);
  const guest = session.fromPartition(partition);
  guest.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  guest.setPermissionCheckHandler(() => false);
  guest.on('will-download', event => event.preventDefault());
}
app.whenReady().then(async () => {
  // `stingray-views` for agents in Stingray terminals; views-cli.cjs sits next to codegraph-worker.cjs (asar is off).
  // Installed before the zsh proxies, which keep its directory on PATH after the user's rc files.
  const viewsBin = path.join(app.getPath('userData'), 'bin');
  await installLauncher({ binDir: viewsBin, execPath: process.execPath, cliPath: path.join(__dirname, 'views-cli.cjs') })
    .then(() => { terminals.viewsBin = viewsBin; }, error => console.error('Could not install stingray-views:', error));
  try {
    if (process.platform !== 'win32') {
      await activity.start();
      await activityShell.prepare(activity.directory, {
        extension: path.join(__dirname, 'pi-extension.js'), hookClient: path.join(__dirname, 'hook-client.cjs'),
        execPath: process.execPath, endpoint: activity.endpoint,
      }, terminals.viewsBin);
      activity.restore(new ActivityHistory(app.getPath('userData'))); // after prepare: a failed setup closes the service
    }
  } catch { activityShell.startup = ''; await activity.close(); }
  win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 760, minHeight: 540, title: 'Stingray',
    backgroundColor: '#151110', titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    if (!/^persist:stingray-[0-9a-f-]{36}$/.test(params.partition || '') || !urlSchema.safeParse(params.src).success) {
      event.preventDefault(); return;
    }
    delete preferences.preload;
    preferences.nodeIntegration = false; preferences.contextIsolation = true; preferences.sandbox = true; preferences.webSecurity = true;
    preferences.nodeIntegrationInSubFrames = false; preferences.webviewTag = false;
    delete params.allowpopups;
    lockSession(params.partition);
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    const restrict = (event: Electron.Event, url: string) => { if (!urlSchema.safeParse(url).success) event.preventDefault(); };
    guest.on('will-navigate', restrict);
    guest.on('will-redirect', restrict);
  });
  const ipc: IpcContext = { ipcMain, window: () => win, rendererUrl };
  registerContract(ipc, appContract, {
    state: () => store.load(),
    preview: (id, url) => git.preview(id, url),
    editorSettings: () => editors.settings(),
    setEditor: editor => editors.select(editor),
    openSource: async (id, file, line) => editors.openSource((await git.workspace(id)).path, file, line),
  });
  registerContract(ipc, gitContract, gitHandlers({
    git, gitState,
    pickFolder: async title => { const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title }); return result.canceled ? null : result.filePaths[0]; },
    cloneRepository: async (url, destination) => {
      if (cloning) throw new Error('A clone is already in progress. Wait for it to finish.');
      cloning = true;
      try { return await git.cloneRepository(url, destination); } finally { cloning = false; }
    },
  }));
  registerContract(ipc, repoMapContract, { repoSnapshot: id => git.repoSnapshot(id), inspectFile: (id, path) => git.inspectFile(id, path) });
  registerContract(ipc, terminalsContract, terminalsHandlers({
    terminals, git,
    openLink: async (id, uri) => {
      if (openingLink) throw new Error('Finish the current link confirmation first.');
      const terminal = terminals.list().find(t => t.id === id);
      if (!terminal) throw new Error('Terminal not found.');
      openingLink = true;
      try {
        const workspace = await git.workspace(terminal.workspaceId);
        await openTerminalLink(uri, workspace.path, {
          confirm: async link => {
            const action = link.kind === 'web' ? 'Open in browser' : link.kind === 'file' ? 'Open file' : 'Show in file manager';
            const { response } = await dialog.showMessageBox(win, { type: 'question', title: 'Open terminal link',
              message: action + '?', detail: link.target + '\n\nTerminal output can contain misleading links. Only open targets you trust.',
              buttons: ['Cancel', action], defaultId: 0, cancelId: 0, noLink: true });
            return response === 1;
          },
          ...electronShell,
        });
      } finally { openingLink = false; }
    },
  }));
  registerContract(ipc, activityContract, activityHandlers({
    activity,
    setVisible: ids => { const known = new Set(terminals.list().map(t => t.id)); visibleTerminals = new Set(ids.filter(id => known.has(id))); },
    acknowledge: (id, terminalId, revision) => {
      if (win.isFocused() && win.isVisible() && !win.isMinimized() && visibleTerminals.has(terminalId)) activity.acknowledge(id, terminalId, revision);
    },
  }));
  win.webContents.on('did-start-loading', () => { visibleTerminals.clear(); });
  registerContract(ipc, stinggraphContract, stinggraphHandlers({ settings: stinggraphSettings, host: codegraph }));
  registerContract(ipc, viewsContract, {
    views: async id => views.listViews(id, (await git.workspace(id)).path),
    // ViewService shares concurrent computations of the same view.
    view: async (id, viewId, options) => views.computeView(id, (await git.workspace(id)).path, viewId, options),
    viewState: (id, viewId) => viewState.get(id, viewId),
    saveViewState: (id, viewId, state) => viewState.set(id, viewId, state),
    saveViewAs: async (id, input) => saveViewAs((await git.workspace(id)).path, input),
    openServiceDocs: serviceId => {
      const service = infraServiceById(serviceId);
      if (!service) throw new Error('Unknown cloud service.');
      return shell.openExternal(service.docUrl);
    },
  });
  registerContract(ipc, runtimeContract, {
    containers: () => containers.list(),
    stopContainer: id => containers.stop(id),
    containerLogs: id => containers.logs(id),
    inspectCdp: port => inspectCdp(port),
    ports: () => ports.list(),
    liveViewStart: options => liveViews.start(options),
    liveViewInput: (id, input) => liveViews.input(id, input),
    liveViewResize: (id, maxWidth, maxHeight) => liveViews.resize(id, maxWidth, maxHeight),
    liveViewStop: id => liveViews.stop(id),
    liveViewAck: id => liveViews.ack(id),
  });
  // A reloaded renderer has lost its session ids; a closed window has no viewer.
  win.webContents.on('did-start-loading', () => liveViews.stopAll());
  win.on('closed', () => liveViews.stopAll());
  win.on('close', event => {
    if (cloning) {
      event.preventDefault();
      void dialog.showMessageBox(win, { type: 'info', message: 'A project is still being cloned.',
        detail: 'Keep Stingray open until it finishes or reports an error (up to five minutes).', buttons: ['Keep open'] });
      return;
    }
    if (!quitting && terminals.list().some(t => !t.exited)) {
      event.preventDefault();
      void dialog.showMessageBox(win, {
        type: 'warning', message: 'Quit Stingray and stop running terminals?',
        detail: 'Shells and their foreground jobs will be closed. Worktrees and branches will stay on disk.',
        buttons: ['Keep working', 'Quit and stop terminals'], defaultId: 0, cancelId: 0,
      }).then(({ response }) => { if (response === 1) { quitting = true; app.quit(); } });
    }
  });
  void win.loadURL(rendererUrl);
});
// scripts/dev.mjs restarts the app with SIGUSR2: skip the running-terminals prompt (the clone guard still applies).
if (devUrl) process.on('SIGUSR2', () => { quitting = true; app.quit(); });
app.on('window-all-closed', () => app.quit());
let cleanedUp = false;
app.on('will-quit', event => {
  if (cleanedUp) return;
  event.preventDefault(); activity.flushHistory(); terminals.closeAll(); gitState.dispose(); // flush first: closing terminals drops their entries
  void Promise.allSettled([activity.close(), views.dispose()]).finally(() => { closeDatabase(app.getPath('userData')); cleanedUp = true; app.quit(); });
});
