// Composition root entry: startup checks, services, window, IPC contracts, quit cleanup.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { activityContract } from '../../shared/contracts/activity';
import { appContract } from '../../shared/contracts/app';
import { gitContract } from '../../shared/contracts/git';
import { repoMapContract } from '../../shared/contracts/repo-map';
import { runtimeContract } from '../../shared/contracts/runtime';
import { stinggraphContract } from '../../shared/contracts/stinggraph';
import { terminalsContract } from '../../shared/contracts/terminals';
import { viewsContract } from '../../shared/contracts/views';
import { electronClipboard } from '../adapters/driven/electron-shell/clipboard';
import { pickFolder } from '../adapters/driven/electron-shell/dialogs';
import { lockSession } from '../adapters/driven/electron-shell/sessions';
import { electronShell } from '../adapters/driven/electron-shell/shell';
import { openApp } from '../adapters/driven/process/open-app';
import { activityHandlers } from '../adapters/driving/ipc/activity';
import { appHandlers } from '../adapters/driving/ipc/app';
import { gitHandlers } from '../adapters/driving/ipc/git';
import { repoMapHandlers } from '../adapters/driving/ipc/repo-map';
import { runtimeHandlers } from '../adapters/driving/ipc/runtime';
import { stinggraphHandlers } from '../adapters/driving/ipc/stinggraph';
import { terminalsHandlers } from '../adapters/driving/ipc/terminals';
import { viewsHandlers } from '../adapters/driving/ipc/views';
import { inspectCdp } from '../core/runtime';
import { compose, startServices } from './compose';
import { registerContract, type IpcContext } from './ipc';
import { registerQuit } from './lifecycle';
import { createMainWindow, focusExisting, guardClose, onRendererReset, quitSkippingTerminalPrompt } from './window';
import { saveViewAs } from './wiring/views';

export function start() {
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
  let win: BrowserWindow | undefined;
  app.on('second-instance', () => focusExisting(win));
  const dataDir = app.getPath('userData');
  const s = compose({ dataDir, distDir: __dirname, window: () => win });
  app.whenReady().then(async () => {
    await startServices(s, { dataDir, distDir: __dirname, execPath: process.execPath });
    const window = createMainWindow({ rendererUrl, preload: path.join(__dirname, 'preload.cjs'), lockSession });
    win = window;
    const ipc: IpcContext = { ipcMain, window: () => win, rendererUrl };
    registerContract(ipc, appContract, appHandlers({ git: s.git, editors: s.editors }));
    registerContract(ipc, gitContract, gitHandlers({ git: s.git, gitState: s.gitState, pickFolder: title => pickFolder(window, title),
      cloneRepository: (url, destination) => s.cloneLock.run(() => s.git.cloneRepository(url, destination)) }));
    registerContract(ipc, repoMapContract, repoMapHandlers(s.git.repoMap));
    registerContract(ipc, terminalsContract, terminalsHandlers({ terminals: s.terminals, git: s.git, openLink: (id, uri) => s.linkOpener.open(id, uri) }));
    registerContract(ipc, activityContract, activityHandlers({ activity: s.activity, setVisible: ids => s.visibility.setVisible(ids),
      acknowledge: (id, terminalId, revision) => s.visibility.acknowledge(id, terminalId, revision) }));
    registerContract(ipc, stinggraphContract, stinggraphHandlers({ settings: s.stinggraphSettings, host: s.codegraph }));
    registerContract(ipc, viewsContract, viewsHandlers({ views: s.views, viewState: s.viewState, git: s.git, saveViewAs, openExternal: url => electronShell.openExternal(url) }));
    registerContract(ipc, runtimeContract, runtimeHandlers({ containers: s.containers, ports: s.ports, liveViews: s.liveViews,
      inspectCdp: port => inspectCdp(port, { clipboard: electronClipboard, openApp, platform: process.platform }) }));
    onRendererReset(window, () => { s.visibility.reset(); s.liveViews.stopAll(); s.gitState.select(null); }, () => s.liveViews.stopAll());
    guardClose(window, { cloneBusy: () => s.cloneLock.busy, runningTerminals: () => s.terminals.list().some(t => !t.exited) });
    void window.loadURL(rendererUrl);
  });
  // scripts/dev.mjs restarts the app with SIGUSR2: skip the running-terminals prompt (the clone guard still applies).
  if (devUrl) process.on('SIGUSR2', quitSkippingTerminalPrompt);
  registerQuit(s, dataDir);
}
