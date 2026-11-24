import type { appContract } from '../../../../shared/contracts/app';
import type { Handlers } from '../../../../shared/contracts/define';
import type { EditorService } from '../../../core/app';
import type { GitService } from '../../../core/git';

export function appHandlers(d: { git: GitService; editors: EditorService }): Handlers<typeof appContract> {
  return {
    state: () => d.git.store.load(),
    preview: (id, url) => d.git.preview(id, url),
    editorSettings: () => d.editors.settings(),
    setEditor: editor => d.editors.select(editor),
    openSource: async (id, file, line) => d.editors.openSource((await d.git.workspace(id)).path, file, line),
  };
}
