import type { DesktopAPI, State, TerminalInfo, TerminalEvent } from './shared';
const repoId = '00000000-0000-4000-8000-000000000001';
const mainId = '00000000-0000-4000-8000-000000000002';
const initial: State = {
  version: 1, repos: [{ id: repoId, name: 'stingray', path: '/demo/stingray' }],
  workspaces: [
    { id: mainId, repoId, name: 'main', branch: 'main', path: '/demo/stingray', managed: false, previewUrl: '' },
    { id: '00000000-0000-4000-8000-000000000003', repoId, name: 'feature/browser', branch: 'feature/browser', path: '/demo/browser', managed: true, previewUrl: '' },
  ],
};
let state = structuredClone(initial);
try { const saved = localStorage.getItem('stingray-demo-v1'); if (saved) { const { stateSchema } = await import('./shared'); state = stateSchema.parse(JSON.parse(saved)); } } catch { /* Invalid demo data is disposable; desktop data never uses this adapter. */ }
let terminalList: TerminalInfo[] = [];
const listeners = new Set<(event: TerminalEvent) => void>();
const snapshot = () => structuredClone(state);
const save = () => { localStorage.setItem('stingray-demo-v1', JSON.stringify(state)); return snapshot(); };
export const demoAPI: DesktopAPI = {
  mode: 'demo',
  state: async () => snapshot(),
  pickRepository: async () => { throw new Error('Native folder selection is available in the desktop app. This is a simulated browser demo.'); },
  openRepository: async () => { throw new Error('Real repositories require the desktop app. Demo workspaces are simulated.'); },
  pickCloneParent: async () => { throw new Error('Folder selection requires the desktop app. No files were changed.'); },
  cloneRepository: async () => { throw new Error('Cloning requires the desktop app. No repository was downloaded or added in this browser demo.'); },
  createWorkspace: async (id, branch) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(branch) || branch.includes('..') || branch.endsWith('/')) throw new Error('Enter a valid branch name.');
    if (state.workspaces.some(w => w.branch === branch)) throw new Error('This branch already exists.');
    if (state.workspaces.length >= 20) throw new Error('Demo workspace limit reached.');
    state.workspaces.push({ id: crypto.randomUUID(), repoId: id, name: branch, branch, path: '/demo/' + branch, managed: true, previewUrl: '' }); return save();
  },
  removeWorkspace: async (id, confirmation) => {
    const w = state.workspaces.find(w => w.id === id);
    if (!w?.managed || w.branch !== confirmation) throw new Error('Type the exact branch name.');
    if (terminalList.some(t => t.workspaceId === id)) throw new Error('Close every terminal in this workspace first.');
    state.workspaces = state.workspaces.filter(w => w.id !== id); return save();
  },
  pullRequest: async id => {
    await new Promise(resolve => setTimeout(resolve, 700));
    const branch = state.workspaces.find(w => w.id === id)?.branch || 'unknown';
    return { kind: 'pr', branch, repository: 'demo/stingray', checkedAt: Date.now(), number: id === mainId ? 41 : 42, state: id === mainId ? 'merged' : 'open' };
  },
  ports: async () => { await new Promise(resolve => setTimeout(resolve, 650)); return []; },
  gitStatus: async id => ({ lines: { kind: 'available', added: id === mainId ? 8 : 124, deleted: id === mainId ? 2 : 36, binaryFiles: 0 }, branch: state.workspaces.find(w => w.id === id)?.branch || 'unknown', changes: [{ path: 'src/App.tsx', status: ' M' }, { path: 'src/styles.css', status: ' M' }, { path: 'README.md', status: '??' }] }),
  containers: async () => { await new Promise(resolve => setTimeout(resolve, 650)); return [{ id: 'demo-web', name: 'demo-web', image: 'node:24', state: 'running', health: 'healthy', paths: state.workspaces.slice(0, 1).map(w => w.path), ports: [{ port: 3000, target: '3000/tcp', url: 'http://127.0.0.1:3000' }] }, { id: 'demo-db', name: 'demo-db', image: 'postgres:17', state: 'running', health: '', paths: [], ports: [] }]; },
  preview: async (id, url) => { const w = state.workspaces.find(w => w.id === id); if (w) w.previewUrl = url; return save(); },
  // No real Pi runs in the browser demo; never fabricate live activity.
  activity: async () => ({ revision: 0, agents: [] }),
  activityView: async () => undefined,
  acknowledgeActivity: async () => undefined,
  onActivity: () => () => {},
  terminals: async () => structuredClone(terminalList),
  createTerminal: async workspaceId => {
    if (terminalList.length >= 24) throw new Error('Terminal limit reached.');
    const t = { id: crypto.randomUUID(), workspaceId, title: 'Terminal ' + (terminalList.length + 1), exited: false, sequence: 0, buffer: '\x1b[38;2;224;120;80mStingray\x1b[0m · browser demo\r\n\r\nSimulated terminal. Commands are not executed.\r\nUse the Electron app for a real shell and installed agents.\r\n\r\n❯ ' };
    terminalList.push(t); return { ...t };
  },
  writeTerminal: async (id, data) => {
    const output = data === '\r' ? '\r\nDemo only — no command was executed.\r\n❯ ' : data === '\x7f' ? '\b \b' : data;
    const t = terminalList.find(t => t.id === id); if (t) t.buffer = (t.buffer + output).slice(-128 * 1024);
    const sequence = t ? ++t.sequence : 0;
    listeners.forEach(fn => fn({ id, data: output, sequence }));
  },
  resizeTerminal: async () => undefined,
  closeTerminal: async id => { terminalList = terminalList.filter(t => t.id !== id); },
  onTerminal: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
};
