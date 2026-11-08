import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { idSchema, urlSchema, repoPathSchema, snapshotHintSchema, removalConsentSchema } from '../src/shared';
import { Store } from './store';
import { GitService } from './git';
import { Terminals } from './terminals';
import { openTerminalLink } from './terminal-links';
import { ContainerService } from './containers';
import { PortService } from './ports';
import { PullRequestService } from './pull-requests';
import { ActivityService } from './activity';
import { ActivityShell } from './activity-shell';

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
const activity = new ActivityService(snapshot => { if (win && !win.isDestroyed()) win.webContents.send('activity-event', snapshot); });
const activityShell = new ActivityShell();
let visibleTerminals = new Set<string>();
const terminals = new Terminals(event => { if (win && !win.isDestroyed()) win.webContents.send('terminal-event', event); }, activity, activityShell);
const git = new GitService(store, id => terminals.hasWorkspace(id));
const lockedSessions = new Set<string>();
const containers = new ContainerService();
const ports = new PortService(() => terminals.portRoots());
const pullRequests = new PullRequestService();

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
  try {
    if (process.platform !== 'win32') {
      await activity.start();
      await activityShell.prepare(activity.directory, path.join(__dirname, 'pi-extension.js'));
    }
  } catch { activityShell.startup = ''; await activity.close(); }
  win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 760, minHeight: 540, title: 'Stingray',
    backgroundColor: '#151110', titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
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
  handle('remove-workspace', z.tuple([idSchema, z.string().max(200), removalConsentSchema]), (id, confirmation, consent) => git.removeWorkspace(id, confirmation, consent));
  handle('git-status', z.tuple([idSchema]), id => git.status(id));
  handle('repo-snapshot', z.tuple([idSchema, snapshotHintSchema.optional()]), (id, hint) => git.repoSnapshot(id, hint));
  handle('inspect-file', z.tuple([idSchema, repoPathSchema]), (id, path) => git.inspectFile(id, path));
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
  event.preventDefault(); terminals.closeAll();
  void activity.close().finally(() => { cleanedUp = true; app.quit(); });
});
