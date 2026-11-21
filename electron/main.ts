import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { idSchema, urlSchema, repoPathSchema, removalConsentSchema } from '../src/shared';
import { Store } from './store';
import { closeDatabase } from './database';
import { GitService } from './git';
import { Terminals } from './terminals';
import { openTerminalLink } from './terminal-links';
import { ContainerService } from './containers';
import { PortService } from './ports';
import { PullRequestService } from './pull-requests';
import { GitStateService } from './git-state';
import { ActivityService } from './activity';
import { ActivityShell } from './activity-shell';
import { extractDbSchema } from './db-schema';
import type { DbSchemaResult } from '../src/db-schema';
import { ViewService } from './views';
import { createCodeGraphProcessHost } from './codegraph-process';
import { installLauncher } from './views/launcher';
import { saveViewAs } from './views/save-view';
import { positionsSchema } from './views/rules/schema';
import { ViewStateStore, viewLocalStateSchema } from './view-state';
import { EDITOR_IDS, EditorService } from './editors';
import { setSharedBase, sharedBaseEnabled, sharedBaseTarget, sharedBaseWorkspaces } from './codegraph-settings';

app.setName('Stingray');
if (process.env.STINGRAY_DATA_DIR) app.setPath('userData', path.resolve(process.env.STINGRAY_DATA_DIR));
const devUrl = process.env.STINGRAY_DEV_URL;
if (devUrl && devUrl !== 'http://127.0.0.1:5178') throw new Error('Unexpected development URL.');
const rendererUrl = (devUrl ? new URL(devUrl).href : undefined) || pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
if (!app.requestSingleInstanceLock()) app.exit(0);
let win: BrowserWindow;
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
let quitting = false;
let cloning = false;
let openingLink = false;
const store = new Store(app.getPath('userData'));
const viewState = new ViewStateStore(app.getPath('userData'));
const editors = new EditorService(app.getPath('userData'), { showItemInFolder: file => shell.showItemInFolder(file) });
const activity = new ActivityService(snapshot => { if (win && !win.isDestroyed()) win.webContents.send('activity-event', snapshot); });
const activityShell = new ActivityShell();
let visibleTerminals = new Set<string>();
const terminals = new Terminals(event => { if (win && !win.isDestroyed()) win.webContents.send('terminal-event', event); }, activity, activityShell);
const git = new GitService(store, id => terminals.countWorkspace(id), {
  // Close the workspace's terminals and stop its code graph (.codegraph cache) before the folder is cleaned and removed.
  beforeRemove: id => { terminals.closeWorkspace(id); return views.release(id); }, removeFailed: id => views.reopen(id),
});
const lockedSessions = new Set<string>();
const containers = new ContainerService();
const ports = new PortService(() => terminals.portRoots());
const pullRequests = new PullRequestService();
const gitState = new GitStateService(git, pullRequests, state => { if (win && !win.isDestroyed()) win.webContents.send('git-state-changed', state); },
  () => Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()));
git.onStatus = (id, status) => gitState.observe(id, status);
pullRequests.onListChange = () => gitState.listChanged();
const codegraph = createCodeGraphProcessHost({ sharedBase: id => sharedBaseTarget(app.getPath('userData'), id) });
const views = new ViewService({ host: codegraph, grammarPath: path.join(__dirname, 'tree-sitter-python.wasm'),
  emit: event => { if (win && !win.isDestroyed()) win.webContents.send('views-changed', event); } });

function handle(name: string, schema: z.ZodType, action: (...args: any[]) => unknown) {
  ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame.url.split('#')[0] !== rendererUrl) throw new Error('Untrusted IPC sender.');
    return action(...(schema.parse(args) as unknown[]));
  });
}
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
      await activityShell.prepare(activity.directory, path.join(__dirname, 'pi-extension.js'), terminals.viewsBin);
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
  handle('state', z.tuple([]), () => store.load());
  handle('pick-repository', z.tuple([]), async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Open a trusted Git repository' });
    return result.canceled ? null : git.openRepository(result.filePaths[0]);
  });
  handle('open-repository', z.tuple([z.string().min(1).max(4096)]), p => git.openRepository(p));
  handle('pick-clone-parent', z.tuple([]), async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a parent folder for the new clone' });
    return result.canceled ? null : result.filePaths[0];
  });
  // Validate values in the service with fixed errors (no Zod payload echo).
  handle('clone-repository', z.tuple([z.string().max(2048), z.string().max(4096)]), async (url, destination) => {
    if (cloning) throw new Error('A clone is already in progress. Wait for it to finish.');
    cloning = true;
    try { return await git.cloneRepository(url, destination); } finally { cloning = false; }
  });
  handle('create-workspace', z.tuple([idSchema, z.string().max(100)]), (id, branch) => git.createWorkspace(id, branch));
  handle('review-removal', z.tuple([idSchema]), id => git.reviewRemoval(id));
  handle('remove-workspace', z.tuple([idSchema, removalConsentSchema]), async (id, consent) => {
    const result = await git.removeWorkspace(id, consent);
    gitState.forget(id);
    await viewState.forget(id).catch(() => {}); // stale view state must not block a completed removal
    return result;
  });
  handle('git-status', z.tuple([idSchema]), id => git.status(id));
  handle('repo-snapshot', z.tuple([idSchema]), id => git.repoSnapshot(id));
  handle('inspect-file', z.tuple([idSchema, repoPathSchema]), (id, path) => git.inspectFile(id, path));
  // Static parse only; concurrent requests for the same workspace share one scan.
  const dbScans = new Map<string, Promise<DbSchemaResult>>();
  handle('db-schema', z.tuple([idSchema]), (id: string) => {
    let scan = dbScans.get(id);
    if (!scan) {
      scan = git.workspace(id).then(w => extractDbSchema(id, w.path, path.join(__dirname, 'tree-sitter-python.wasm')))
        .finally(() => dbScans.delete(id));
      dbScans.set(id, scan);
    }
    return scan;
  });
  handle('views', z.tuple([idSchema]), async (id: string) => views.listViews(id, (await git.workspace(id)).path));
  // ViewService shares concurrent computations of the same view.
  const viewIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);
  handle('view', z.tuple([idSchema, viewIdSchema, z.strictObject({ depth: z.number().int().min(0).max(4).optional() }).optional()]),
    async (id: string, viewId: string, options?: { depth?: number }) => views.computeView(id, (await git.workspace(id)).path, viewId, options));
  handle('view-state', z.tuple([idSchema, viewIdSchema]), (id: string, viewId: string) => viewState.get(id, viewId));
  handle('save-view-state', z.tuple([idSchema, viewIdSchema, viewLocalStateSchema]), (id, viewId, state) => viewState.set(id, viewId, state));
  handle('save-view-as', z.tuple([idSchema, z.strictObject({
    name: z.string().max(200), basedOn: viewIdSchema, exclude: z.array(z.string().max(300)).max(2000),
    layout: z.strictObject({ positions: positionsSchema }).nullable(),
  })]), async (id, input) => saveViewAs((await git.workspace(id)).path, input));
  handle('editor-settings', z.tuple([]), () => editors.settings());
  handle('set-editor', z.tuple([z.enum(EDITOR_IDS)]), editor => editors.select(editor));
  handle('codegraph-settings', z.tuple([]), () => ({ sharedBase: sharedBaseEnabled(app.getPath('userData')) }));
  handle('set-codegraph-shared-base', z.tuple([z.boolean()]), enabled => setSharedBase(app.getPath('userData'), enabled));
  handle('codegraph-conflicts', z.tuple([idSchema]), (id: string) => {
    const shared = sharedBaseWorkspaces(app.getPath('userData'), id);
    return shared ? codegraph.conflicts(shared.target, shared.workspaceIds) : null;
  });
  handle('open-source', z.tuple([idSchema, repoPathSchema, z.number().int().positive().max(10_000_000).nullable()]), async (id, file, line) =>
    editors.openSource((await git.workspace(id)).path, file, line));
  handle('pull-request', z.tuple([idSchema, z.boolean().optional()]), async (id, refresh) => pullRequests.status((await git.workspace(id)).path, refresh));
  handle('containers', z.tuple([]), () => containers.list());
  handle('ports', z.tuple([]), () => ports.list());
  handle('preview', z.tuple([idSchema, z.union([z.literal(''), urlSchema])]), (id, url) => git.preview(id, url));
  handle('activity', z.tuple([]), () => activity.snapshot());
  handle('activity-view', z.tuple([z.array(idSchema).max(2)]), (ids: string[]) => {
    const known = new Set(terminals.list().map(t => t.id));
    visibleTerminals = new Set(ids.filter(id => known.has(id)));
  });
  handle('acknowledge-activity', z.tuple([idSchema, idSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]), (id, terminalId, revision) => {
    if (win.isFocused() && win.isVisible() && !win.isMinimized() && visibleTerminals.has(terminalId)) activity.acknowledge(id, terminalId, revision);
  });
  win.webContents.on('did-start-loading', () => { visibleTerminals.clear(); });
  handle('terminals', z.tuple([]), () => terminals.list());
  handle('create-terminal', z.tuple([idSchema]), id => git.useWorkspace(id, w => terminals.create(id, w.path)));
  handle('write-terminal', z.tuple([idSchema, z.string().max(65536)]), (id, data) => terminals.write(id, data));
  handle('open-terminal-link', z.tuple([idSchema, z.string().min(1).max(8192)]), async (id, uri) => {
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
        openExternal: target => shell.openExternal(target),
        openPath: target => shell.openPath(target),
        showItemInFolder: target => shell.showItemInFolder(target),
      });
    } finally { openingLink = false; }
  });
  handle('resize-terminal', z.tuple([idSchema, z.number().int().min(2).max(500), z.number().int().min(1).max(300)]), (id, cols, rows) => terminals.resize(id, cols, rows));
  handle('close-terminal', z.tuple([idSchema]), id => terminals.close(id));
  handle('git-state', z.tuple([idSchema]), id => gitState.get(id));
  handle('refresh-git-state', z.tuple([idSchema]), id => gitState.refresh(id, true));
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
app.on('window-all-closed', () => app.quit());
let cleanedUp = false;
app.on('will-quit', event => {
  if (cleanedUp) return;
  event.preventDefault(); terminals.closeAll(); gitState.dispose();
  void Promise.allSettled([activity.close(), views.dispose()]).finally(() => { closeDatabase(app.getPath('userData')); cleanedUp = true; app.quit(); });
});
