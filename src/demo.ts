import type { DesktopAPI, State, TerminalInfo, TerminalEvent, RepoFile } from './shared';
const repoId = '00000000-0000-4000-8000-000000000001';
const mainId = '00000000-0000-4000-8000-000000000002';
const demoContent = (path: string) => path.endsWith('.tsx') ? 'export function Button() {\n  return <button className="primary">Continue</button>;\n}\n' : '// Simulated file contents for the browser demo.\n';
const demoFiles: RepoFile[] = [
  { path: 'src/App.tsx', status: ' M' }, { path: 'src/styles.css', status: ' M' },
  { path: 'src/components/Button.tsx', status: ' M' }, { path: 'src/components/Dialog.tsx', status: '??' },
  { path: 'src/components/Sidebar.tsx', status: '' }, { path: 'src/hooks/useWorkspace.ts', status: '' },
  { path: 'src/legacy.ts', status: ' D' }, { path: 'src/main.tsx', status: '' },
  { path: 'electron/main.ts', status: '' }, { path: 'electron/git.ts', status: ' M' },
  { path: 'electron/preload.ts', status: '' }, { path: 'tests/git.test.ts', status: '??' },
  { path: 'tests/navigation.test.ts', status: '' }, { path: 'public/stingray.svg', status: '' },
  { path: 'src/conflict.ts', status: 'UU' }, { path: 'assets/binary.png', status: '??' },
  ...Array.from({ length: 160 }, (_, i) => ({ path: `src/features/feature-${Math.floor(i / 12)}/module-${i}.ts`, status: i % 13 === 0 ? ' M' : '' })),
  { path: 'README.md', status: '' }, { path: 'package.json', status: '' }, { path: 'tsconfig.json', status: '' },
].map((file, i) => ({ ...file, size: file.path.endsWith('.png') ? { state: 'unavailable' as const, source: 'working tree' as const, reason: 'Synthetic binary fixture' } : { state: 'known' as const, textLines: 10 + (i * 97 % 700), source: file.status.includes('D') ? 'HEAD' as const : 'working tree' as const }, lines: {
  added: file.status && !file.status.includes('D') ? demoContent(file.path).split('\n').length - 1 : 0,
  removed: file.status && file.status !== '??' ? 1 : 0,
} }));
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
  reviewRemoval: async id => {
    const w = state.workspaces.find(w => w.id === id);
    if (!w?.managed) throw new Error('Only managed worktrees can be removed.');
    return { branch: w.branch, token: '0'.repeat(64), blockers: terminalList.some(t => t.workspaceId === id) ? ['Close every terminal in this workspace first.'] : [], push: { kind: 'unknown', message: 'Simulated demo: push status is unknown. No real Git check was performed.' } };
  },
  removeWorkspace: async (id, confirmation, consent) => {
    const w = state.workspaces.find(w => w.id === id);
    if (!w?.managed || w.branch !== confirmation) throw new Error('Type the exact branch name.');
    if (terminalList.some(t => t.workspaceId === id)) throw new Error('Close every terminal in this workspace first.');
    if (consent.token !== '0'.repeat(64) || !consent.acknowledge) throw new Error('Review and acknowledge the simulated push status first.');
    state.workspaces = state.workspaces.filter(w => w.id !== id); return save();
  },
  gitStatus: async id => ({ lines: { kind: 'available' as const, added: id === mainId ? 8 : 124, deleted: id === mainId ? 2 : 36, binaryFiles: 0 }, branch: state.workspaces.find(w => w.id === id)?.branch || 'unknown', changes: demoFiles.filter(file => file.status) }),
  repoSnapshot: async id => ({
    lines: { kind: 'available' as const, added: id === mainId ? 8 : 124, deleted: id === mainId ? 2 : 36, binaryFiles: 0 },
    branch: state.workspaces.find(w => w.id === id)?.branch || 'unknown',
    changes: demoFiles.filter(file => file.status),
    files: demoFiles,
    statsNotice: 'Simulated demo counts, not a real repository. Desktop counts use Git.',
    sizeNotice: 'Synthetic varied text-line sizes for layout demonstration; not measured repository content.',
  }),
  inspectFile: async (_id, path) => {
    const file = demoFiles.find(file => file.path === path);
    if (!file) throw new Error('Demo file not found.');
    const content = file.status.includes('D') ? '// Previous version\n' : demoContent(path);
    const { added, removed } = file.lines!;
    return { path, content, source: file.status.includes('D') ? 'HEAD' : 'working tree', staged: '',
      unstaged: file.status ? `--- ${removed ? 'a/' + path : '/dev/null'}\n+++ ${added ? 'b/' + path : '/dev/null'}\n@@ -${removed ? 1 : 0},${removed} +${added ? 1 : 0},${added} @@\n` + (removed ? '-// Previous version\n' : '') + (added ? content.trimEnd().split('\n').map(line => '+' + line).join('\n') + '\n' : '') : '',
      notice: file.status.includes('D') ? 'Deleted file · showing simulated HEAD contents.' : '',
      revision: 'demo-' + path,
    };
  },
  pullRequest: async id => {
    await new Promise(resolve => setTimeout(resolve, 700));
    const branch = state.workspaces.find(w => w.id === id)?.branch || 'unknown';
    return { kind: 'pr', branch, repository: 'demo/stingray', checkedAt: Date.now(), number: id === mainId ? 41 : 42, state: id === mainId ? 'merged' : 'open' };
  },
  ports: async () => { await new Promise(resolve => setTimeout(resolve, 650)); return []; },
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
  openTerminalLink: async () => { throw new Error('Opening terminal links requires the desktop app. No external app was opened.'); },
  resizeTerminal: async () => undefined,
  closeTerminal: async id => { terminalList = terminalList.filter(t => t.id !== id); },
  onTerminal: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
};
