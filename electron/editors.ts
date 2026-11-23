// "Open in editor" for Views: detects VS Code, Cursor and Zed CLIs and opens worktree files at a line, without a shell.
// Electron's main process on macOS gets a minimal PATH, so standard install folders and app bundles are checked too.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { EDITOR_IDS, type EditorId, type EditorSettings } from '../shared/contracts/app';
import { database } from './database';

const CLIS: Record<Exclude<EditorId, 'system' | 'repo-map'>, { command: string; bundle: string }> = {
  vscode: { command: 'code', bundle: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' },
  cursor: { command: 'cursor', bundle: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor' },
  zed: { command: 'zed', bundle: '/Applications/Zed.app/Contents/MacOS/cli' },
};
const settingsSchema = z.strictObject({ selected: z.enum(EDITOR_IDS) });

export interface EditorDeps {
  env: { PATH?: string; HOME?: string };
  isExecutable(file: string): Promise<boolean>;
  /** Run a CLI without a shell; rejects when it cannot start or exits non-zero. */
  launch(file: string, args: string[]): Promise<void>;
  showItemInFolder(file: string): void;
}

const isExecutable = async (file: string) => {
  try { await access(file, constants.X_OK); return (await stat(file)).isFile(); } catch { return false; }
};
const launch = (file: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', timeout: 15_000, windowsHide: true });
  child.once('error', reject);
  // A CLI killed at the timeout (code null) has started the editor; only failures to start or non-zero exits count.
  child.once('exit', code => { if (code) reject(new Error(`${path.basename(file)} exited with ${code}`)); else resolve(); });
  child.unref();
});

export class EditorService {
  private readonly deps: EditorDeps;
  private readonly directory: string;
  constructor(directory: string, deps: Partial<EditorDeps> & Pick<EditorDeps, 'showItemInFolder'>) {
    this.directory = directory;
    this.deps = { env: process.env, isExecutable, launch, ...deps };
  }

  /** Path of each detected editor CLI (first match on PATH, then standard folders, then the app bundle). */
  async detect(): Promise<Map<EditorId, string>> {
    const { PATH = '', HOME = os.homedir() } = this.deps.env;
    const dirs = [...new Set([...PATH.split(path.delimiter).filter(d => path.isAbsolute(d)), '/usr/local/bin', '/opt/homebrew/bin', path.join(HOME, '.local/bin')])];
    const found = new Map<EditorId, string>();
    for (const [id, cli] of Object.entries(CLIS) as [EditorId, (typeof CLIS)['zed']][]) {
      for (const candidate of [...dirs.map(d => path.join(d, cli.command)), cli.bundle]) {
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
    database(this.directory).prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('editor', selected);
    return this.settings();
  }

  /** Open a worktree-relative file (at a 1-based line when given) in the selected editor; falls back to the default text editor. */
  async openSource(root: string, file: string, line: number | null): Promise<void> {
    const { selected } = await this.settings();
    if (selected === 'repo-map') throw new Error('Repo Map source links must be opened by the renderer.');
    const target = await resolveSource(root, file);
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
      const row = database(this.directory).prepare('SELECT value FROM settings WHERE key = ?').get('editor') as { value: string } | undefined;
      return row ? settingsSchema.parse({ selected: row.value }).selected : null;
    } catch { return null; }
  }
}

/** Absolute real path of a regular file inside the worktree; rejects absolute paths, `..`, and symlinks leading outside. */
export async function resolveSource(root: string, file: string): Promise<string> {
  const invalid = () => new Error('Choose a regular file inside this worktree.');
  if (!file || file.includes('\0') || file.includes('\\') || path.posix.isAbsolute(file) || file.split('/').some(p => p === '..')) throw invalid();
  let realRoot, target;
  try { realRoot = await realpath(root); target = await realpath(path.join(realRoot, file)); } catch { throw new Error('The file is unavailable.'); }
  const relative = path.relative(realRoot, target);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw invalid();
  if (!(await stat(target)).isFile()) throw invalid();
  return target;
}
