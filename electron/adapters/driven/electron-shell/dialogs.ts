// Every native dialog of the main process (texts unchanged from the pre-restructure electron/main.ts).
import { dialog, type BrowserWindow } from 'electron';
import type { TerminalLink } from '../../../core/terminals';

export async function pickFolder(win: BrowserWindow, title: string): Promise<string | null> {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title });
  return result.canceled ? null : result.filePaths[0];
}
export async function confirmTerminalLink(win: BrowserWindow, link: TerminalLink): Promise<boolean> {
  const action = link.kind === 'web' ? 'Open in browser' : link.kind === 'file' ? 'Open file' : 'Show in file manager';
  const { response } = await dialog.showMessageBox(win, { type: 'question', title: 'Open terminal link',
    message: action + '?', detail: link.target + '\n\nTerminal output can contain misleading links. Only open targets you trust.',
    buttons: ['Cancel', action], defaultId: 0, cancelId: 0, noLink: true });
  return response === 1;
}
export function cloneInProgress(win: BrowserWindow): void {
  void dialog.showMessageBox(win, { type: 'info', message: 'A project is still being cloned.',
    detail: 'Keep Stingray open until it finishes or reports an error (up to five minutes).', buttons: ['Keep open'] });
}
export async function confirmQuitWithTerminals(win: BrowserWindow): Promise<boolean> {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', message: 'Quit Stingray and stop running terminals?',
    detail: 'Shells and their foreground jobs will be closed. Worktrees and branches will stay on disk.',
    buttons: ['Keep working', 'Quit and stop terminals'], defaultId: 0, cancelId: 0,
  });
  return response === 1;
}
