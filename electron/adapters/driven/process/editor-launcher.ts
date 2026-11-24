// Editor CLI detection and launch for core/app EditorService (no shell).
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

export const isExecutable = async (file: string) => {
  try { await access(file, constants.X_OK); return (await stat(file)).isFile(); } catch { return false; }
};
export const launch = (file: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', timeout: 15_000, windowsHide: true });
  child.once('error', reject);
  // A CLI killed at the timeout (code null) has started the editor; only failures to start or non-zero exits count.
  child.once('exit', code => { if (code) reject(new Error(`${path.basename(file)} exited with ${code}`)); else resolve(); });
  child.unref();
});
