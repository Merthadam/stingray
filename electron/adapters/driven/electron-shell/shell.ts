import { shell } from 'electron';

export const electronShell = {
  openExternal: (url: string) => shell.openExternal(url),
  openPath: (file: string) => shell.openPath(file),
  showItemInFolder: (file: string) => shell.showItemInFolder(file),
};
