// App feature (editors) core + real adapters under the names and signatures the rest of the app and the existing tests use.
import './core-ports';
import { resolveSource } from '../../adapters/driven/fs/source-files';
import { isExecutable, launch } from '../../adapters/driven/process/editor-launcher';
import { sqliteSettingsRepository } from '../../adapters/driven/sqlite/settings-repository';
import { EditorService as CoreEditorService, type EditorDeps as CoreEditorDeps } from '../../core/app';

export { resolveSource };
/** The pre-split deps shape (no resolveSource: the real fs adapter is always used unless overridden). */
export type EditorDeps = Omit<CoreEditorDeps, 'resolveSource'>;
export class EditorService extends CoreEditorService {
  constructor(directory: string, deps: Partial<CoreEditorDeps> & Pick<CoreEditorDeps, 'showItemInFolder'>) {
    super(sqliteSettingsRepository(directory), { env: process.env, isExecutable, launch, resolveSource, ...deps });
  }
}
