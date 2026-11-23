// "Open in editor" for Views: detects VS Code, Cursor and Zed CLIs and opens worktree files at a line, without a shell.
// Electron's main process on macOS gets a minimal PATH, so standard install folders and app bundles are checked too.
import { z } from 'zod';
import { EDITOR_IDS, type EditorId, type EditorSettings } from '../../../shared/contracts/app';
import type { SettingsRepository } from '../shared/ports';
import { isAbsolute, join } from '../shared/posix-path';
import type { EditorDeps } from './ports';

const CLIS: Record<Exclude<EditorId, 'system' | 'repo-map'>, { command: string; bundle: string }> = {
  vscode: { command: 'code', bundle: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' },
  cursor: { command: 'cursor', bundle: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor' },
  zed: { command: 'zed', bundle: '/Applications/Zed.app/Contents/MacOS/cli' },
};
const settingsSchema = z.strictObject({ selected: z.enum(EDITOR_IDS) });

export class EditorService {
  constructor(private readonly settingsStore: SettingsRepository, private readonly deps: EditorDeps) {}

  /** Path of each detected editor CLI (first match on PATH, then standard folders, then the app bundle). */
  async detect(): Promise<Map<EditorId, string>> {
    const { PATH = '', HOME = '' } = this.deps.env;
    const dirs = [...new Set([...PATH.split(':').filter(d => isAbsolute(d)), '/usr/local/bin', '/opt/homebrew/bin', ...(HOME ? [join(HOME, '.local/bin')] : [])])];
    const found = new Map<EditorId, string>();
    for (const [id, cli] of Object.entries(CLIS) as [EditorId, (typeof CLIS)['zed']][]) {
      for (const candidate of [...dirs.map(d => join(d, cli.command)), cli.bundle]) {
        if (await this.deps.isExecutable(candidate)) { found.set(id, candidate); break; }
      }
    }
    return found;
  }

  async settings(): Promise<EditorSettings> {
    const external: EditorId[] = [...(await this.detect()).keys(), 'system'];
    const available: EditorId[] = ['repo-map', ...external];
    const saved = await this.saved();
    return { selected: saved && available.includes(saved) ? saved : external[0]!, available };
  }

  async select(editor: EditorId): Promise<EditorSettings> {
    const { selected } = settingsSchema.parse({ selected: editor });
    this.settingsStore.set('editor', selected);
    return this.settings();
  }

  /** Open a worktree-relative file (at a 1-based line when given) in the selected editor; falls back to the default text editor. */
  async openSource(root: string, file: string, line: number | null): Promise<void> {
    const { selected } = await this.settings();
    if (selected === 'repo-map') throw new Error('Repo Map source links must be opened by the renderer.');
    const target = await this.deps.resolveSource(root, file);
    const cli = selected === 'system' ? undefined : (await this.detect()).get(selected);
    if (cli) {
      const at = line ? `${target}:${line}` : target;
      try { await this.deps.launch(cli, selected === 'zed' ? [at] : ['-g', at]); return; } catch { /* fall back silently */ }
    }
    // Never the file's default app: for repo files that can run code (.py via Python Launcher, .command, .webarchive, ...).
    // `open -t` always uses the default text editor; if even that fails, reveal the file in Finder.
    try { await this.deps.launch('/usr/bin/open', ['-t', target]); } catch { this.deps.showItemInFolder(target); }
  }

  private async saved(): Promise<EditorId | null> {
    try {
      const value = this.settingsStore.get('editor');
      return value === undefined ? null : settingsSchema.parse({ selected: value }).selected;
    } catch { return null; }
  }
}
