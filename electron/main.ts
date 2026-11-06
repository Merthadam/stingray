import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { idSchema, urlSchema } from '../src/shared';
import { Store } from './store';
import { GitService } from './git';
import { Terminals } from './terminals';

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
const store = new Store(app.getPath('userData'));
const terminals = new Terminals(event => { if (win && !win.isDestroyed()) win.webContents.send('terminal-event', event); });
const git = new GitService(store, id => terminals.hasWorkspace(id));
const lockedSessions = new Set<string>();

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
app.whenReady().then(() => {
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
  handle('remove-workspace', z.tuple([idSchema, z.string().max(200)]), (id, confirmation) => git.removeWorkspace(id, confirmation));
  handle('git-status', z.tuple([idSchema]), id => git.status(id));
  handle('preview', z.tuple([idSchema, z.union([z.literal(''), urlSchema])]), (id, url) => git.preview(id, url));
  handle('terminals', z.tuple([]), () => terminals.list());
  handle('create-terminal', z.tuple([idSchema]), id => git.useWorkspace(id, w => terminals.create(id, w.path)));
  handle('write-terminal', z.tuple([idSchema, z.string().max(65536)]), (id, data) => terminals.write(id, data));
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
app.on('will-quit', () => terminals.closeAll());
