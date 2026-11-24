// The main window: webview hardening (moved verbatim from electron/main.ts), close guard and reload hooks.
import { BrowserWindow, app } from 'electron';
import { urlSchema } from '../../shared/contracts/common';
import { cloneInProgress, confirmQuitWithTerminals } from '../adapters/driven/electron-shell/dialogs';

let quitting = false;

export function focusExisting(win: BrowserWindow | undefined) {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

export function createMainWindow(o: { rendererUrl: string; preload: string; lockSession(partition: string): void }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 760, minHeight: 540, title: 'Stingray',
    backgroundColor: '#151110', titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: { preload: o.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== o.rendererUrl) event.preventDefault(); });
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    if (!/^persist:stingray-[0-9a-f-]{36}$/.test(params.partition || '') || !urlSchema.safeParse(params.src).success) {
      event.preventDefault(); return;
    }
    delete preferences.preload;
    preferences.nodeIntegration = false; preferences.contextIsolation = true; preferences.sandbox = true; preferences.webSecurity = true;
    preferences.nodeIntegrationInSubFrames = false; preferences.webviewTag = false;
    delete params.allowpopups;
    o.lockSession(params.partition);
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    const restrict = (event: Electron.Event, url: string) => { if (!urlSchema.safeParse(url).success) event.preventDefault(); };
    guest.on('will-navigate', restrict);
    guest.on('will-redirect', restrict);
  });
  return win;
}

/** Quit without the running-terminals prompt (scripts/dev.mjs restarts with SIGUSR2); the clone guard still applies. */
export function quitSkippingTerminalPrompt() { quitting = true; app.quit(); }

export function guardClose(win: BrowserWindow, o: { cloneBusy(): boolean; runningTerminals(): boolean }) {
  win.on('close', event => {
    if (o.cloneBusy()) { event.preventDefault(); cloneInProgress(win); return; }
    if (!quitting && o.runningTerminals()) {
      event.preventDefault();
      void confirmQuitWithTerminals(win).then(quit => { if (quit) quitSkippingTerminalPrompt(); });
    }
  });
}

/** A reloaded renderer has lost its session ids and visible terminals; a closed window has no viewer. */
export function onRendererReset(win: BrowserWindow, reset: () => void, closed: () => void) {
  win.webContents.on('did-start-loading', reset);
  win.on('closed', closed);
}
