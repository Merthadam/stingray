// Keeps the CodeGraph cache (<worktree>/.codegraph/) out of git status by listing it in the repository's local
// info/exclude (shared by all worktrees, never committed). CodeGraph's own .codegraph/.gitignore is itself untracked.
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ENTRY = '/.codegraph/';
const done = new Set<string>();

export async function excludeCodeGraphCache(root: string): Promise<void> {
  if (done.has(root)) return;
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', 'rev-parse', '--git-path', 'info/exclude'],
    { cwd: root, timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  const file = path.resolve(root, stdout.trim());
  const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (!text.split(/\r?\n/).some(line => ['.codegraph', '.codegraph/', '/.codegraph', ENTRY].includes(line.trim()))) {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, (text && !text.endsWith('\n') ? '\n' : '') + `# Stingray code graph cache\n${ENTRY}\n`);
  }
  done.add(root);
}
