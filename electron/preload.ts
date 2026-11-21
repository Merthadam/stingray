import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, TerminalEvent, WorkspaceGitState } from '../src/shared';
import type { ActivitySnapshot } from '../src/activity';
import type { ViewsChangedEvent } from '../src/views';
import type { LiveViewEvent } from '../src/live-view';
const api: DesktopAPI = {
  mode: 'desktop',
  state: () => ipcRenderer.invoke('state'),
  pickRepository: () => ipcRenderer.invoke('pick-repository'),
  openRepository: path => ipcRenderer.invoke('open-repository', path),
  pickCloneParent: () => ipcRenderer.invoke('pick-clone-parent'),
  cloneRepository: (url, destination) => ipcRenderer.invoke('clone-repository', url, destination),
  createWorkspace: (id, branch) => ipcRenderer.invoke('create-workspace', id, branch),
  reviewRemoval: id => ipcRenderer.invoke('review-removal', id),
  removeWorkspace: (id, consent) => ipcRenderer.invoke('remove-workspace', id, consent),
  repoSnapshot: id => ipcRenderer.invoke('repo-snapshot', id),
  inspectFile: (id, path) => ipcRenderer.invoke('inspect-file', id, path),
  dbSchema: id => ipcRenderer.invoke('db-schema', id),
  views: id => ipcRenderer.invoke('views', id),
  view: (id, viewId, options) => ipcRenderer.invoke('view', id, viewId, ...(options ? [options] : [])),
  onViewsChanged: listener => {
    const handler = (_event: unknown, payload: ViewsChangedEvent) => listener(payload);
    ipcRenderer.on('views-changed', handler);
    return () => ipcRenderer.removeListener('views-changed', handler);
  },
  viewState: (id, viewId) => ipcRenderer.invoke('view-state', id, viewId),
  saveViewState: (id, viewId, state) => ipcRenderer.invoke('save-view-state', id, viewId, state),
  saveViewAs: (id, input) => ipcRenderer.invoke('save-view-as', id, input),
  editorSettings: () => ipcRenderer.invoke('editor-settings'),
  setEditor: editor => ipcRenderer.invoke('set-editor', editor),
  codegraphSettings: () => ipcRenderer.invoke('codegraph-settings'),
  setCodegraphSharedBase: enabled => ipcRenderer.invoke('set-codegraph-shared-base', enabled),
  codegraphConflicts: id => ipcRenderer.invoke('codegraph-conflicts', id),
  openSource: (id, file, line) => ipcRenderer.invoke('open-source', id, file, line),
  openServiceDocs: serviceId => ipcRenderer.invoke('open-service-docs', serviceId),
  containers: () => ipcRenderer.invoke('containers'),
  stopContainer: id => ipcRenderer.invoke('container-stop', id),
  containerLogs: id => ipcRenderer.invoke('container-logs', id),
  inspectCdp: port => ipcRenderer.invoke('inspect-cdp', port),
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
  terminalSnapshot: id => ipcRenderer.invoke('terminal-snapshot', id),
  createTerminal: id => ipcRenderer.invoke('create-terminal', id),
  writeTerminal: (id, data) => ipcRenderer.invoke('write-terminal', id, data),
  openTerminalLink: (id, uri) => ipcRenderer.invoke('open-terminal-link', id, uri),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('resize-terminal', id, cols, rows),
  closeTerminal: id => ipcRenderer.invoke('close-terminal', id),
  onTerminal: listener => {
    const handler = (_event: unknown, payload: TerminalEvent) => listener(payload);
    ipcRenderer.on('terminal-event', handler);
    return () => ipcRenderer.removeListener('terminal-event', handler);
  },
  gitState: id => ipcRenderer.invoke('git-state', id),
  refreshGitState: id => ipcRenderer.invoke('refresh-git-state', id),
  onGitStateChanged: listener => {
    const handler = (_event: unknown, payload: WorkspaceGitState) => listener(payload);
    ipcRenderer.on('git-state-changed', handler);
    return () => ipcRenderer.removeListener('git-state-changed', handler);
  },
  liveViewStart: options => ipcRenderer.invoke('live-view-start', options),
  liveViewInput: (sessionId, input) => ipcRenderer.invoke('live-view-input', sessionId, input),
  liveViewResize: (sessionId, maxWidth, maxHeight) => ipcRenderer.invoke('live-view-resize', sessionId, maxWidth, maxHeight),
  liveViewStop: sessionId => ipcRenderer.invoke('live-view-stop', sessionId),
  liveViewAck: sessionId => ipcRenderer.invoke('live-view-ack', sessionId),
  onLiveView: listener => {
    const handler = (_event: unknown, payload: LiveViewEvent) => listener(payload);
    ipcRenderer.on('live-view-event', handler);
    return () => ipcRenderer.removeListener('live-view-event', handler);
  },
};
contextBridge.exposeInMainWorld('stingray', api);
