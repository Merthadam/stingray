import type { Events, Invoke } from '../../../shared/contracts/define';
import type { appContract, EditorSettings } from '../../../shared/contracts/app';
import type { DemoContext } from '../../shared/demo-context';

let editor: EditorSettings = { selected: 'vscode', available: ['repo-map', 'vscode', 'cursor', 'system'] };

export function createAppDemo(ctx: DemoContext): Invoke<typeof appContract> & Events<typeof appContract> {
  return {
    state: async () => ctx.snapshot(),
    preview: async (id, url) => { const w = ctx.state.workspaces.find(w => w.id === id); if (w) w.previewUrl = url; return ctx.save(); },
    editorSettings: async () => structuredClone(editor),
    setEditor: async selected => { editor = { ...editor, selected }; return structuredClone(editor); },
    openSource: async (id, file, line) => { console.info('Demo: would open', file, line, 'in', editor.selected, 'for workspace', id); },
  };
}
