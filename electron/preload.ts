import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, TerminalEvent } from '../src/shared';
import type { ActivitySnapshot } from '../src/activity';
const api: DesktopAPI = {
  mode: 'desktop',
  state: () => ipcRenderer.invoke('state'),
  pickRepository: () => ipcRenderer.invoke('pick-repository'),
  openRepository: path => ipcRenderer.invoke('open-repository', path),
  pickCloneParent: () => ipcRenderer.invoke('pick-clone-parent'),
  cloneRepository: (url, destination) => ipcRenderer.invoke('clone-repository', url, destination),
  createWorkspace: (id, branch) => ipcRenderer.invoke('create-workspace', id, branch),
  removeWorkspace: (id, confirmation) => ipcRenderer.invoke('remove-workspace', id, confirmation),
  gitStatus: id => ipcRenderer.invoke('git-status', id),
  pullRequest: (id, refresh) => ipcRenderer.invoke('pull-request', id, refresh),
  containers: () => ipcRenderer.invoke('containers'),
  ports: () => ipcRenderer.invoke('ports'),
  preview: (id, url) => ipcRenderer.invoke('preview', id, url),
  activity: () => ipcRenderer.invoke('activity'),
  activityView: ids => ipcRenderer.invoke('activity-view', ids),
  acknowledgeActivity: (id, terminalId, revision) => ipcRenderer.invoke('acknowledge-activity', id, terminalId, revision),
  onActivity: listener => {
    const handler = (_event: unknown, payload: ActivitySnapshot) => listener(payload);
    ipcRenderer.on('activity-event', handler);
    return () => ipcRenderer.removeListener('activity-event', handler);
  },
  terminals: () => ipcRenderer.invoke('terminals'),
  createTerminal: id => ipcRenderer.invoke('create-terminal', id),
  writeTerminal: (id, data) => ipcRenderer.invoke('write-terminal', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('resize-terminal', id, cols, rows),
  closeTerminal: id => ipcRenderer.invoke('close-terminal', id),
  onTerminal: listener => {
    const handler = (_event: unknown, payload: TerminalEvent) => listener(payload);
    ipcRenderer.on('terminal-event', handler);
    return () => ipcRenderer.removeListener('terminal-event', handler);
  },
};
contextBridge.exposeInMainWorld('stingray', api);
