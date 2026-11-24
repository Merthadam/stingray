import type { DesktopAPI } from '../../shared/contracts';
import type { State } from '../../shared/contracts/git';
import type { RepoFile } from '../../shared/contracts/repo-map';
import type { DemoContext } from '../shared/demo-context';
import { createActivityDemo } from '../features/activity/demo';
import { createAppDemo } from '../features/app/demo';
import { createGitDemo } from '../features/git/demo';
import { createRepoMapDemo } from '../features/repo-map/demo';
import { createRuntimeDemo } from '../features/runtime/demo';
import { createStinggraphDemo } from '../features/stinggraph/demo';
import { createTerminalsDemo } from '../features/terminals/demo';
import { createViewsDemo } from '../features/views/demo';
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
try { const saved = localStorage.getItem('stingray-demo-v1'); if (saved) { const { stateSchema } = await import('../../shared/contracts/git'); state = stateSchema.parse(JSON.parse(saved)); } } catch { /* Invalid demo data is disposable; desktop data never uses this adapter. */ }
const ctx: DemoContext = {
  state, terminals: [], terminalListeners: new Set(),
  snapshot: () => structuredClone(ctx.state),
  save: () => { localStorage.setItem('stingray-demo-v1', JSON.stringify(ctx.state)); return ctx.snapshot(); },
  mainId, files: demoFiles, content: demoContent,
  uncommitted: { kind: 'available', added: 6, deleted: 2, binaryFiles: 0 },
};
export const demoAPI: DesktopAPI = {
  mode: 'demo',
  ...createAppDemo(ctx), ...createGitDemo(ctx), ...createRepoMapDemo(ctx), ...createTerminalsDemo(ctx),
  ...createActivityDemo(ctx), ...createStinggraphDemo(ctx), ...createViewsDemo(ctx), ...createRuntimeDemo(ctx),
};
