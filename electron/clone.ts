import { spawn } from 'node:child_process';

export const cloneFailure = 'Clone failed or timed out. Check the repository URL, network, and existing Git/SSH access. No project was added. Any remaining destination files were preserved; inspect them before retrying with a new folder, or open a completed repository using Local folder.';

// No shell, raw output, hooks, templates or recursive submodules. Transport
// allow-list also applies after Git insteadOf rewriting. Local trusted Git
// credential helpers / SSH configuration / checkout filters remain in use.
export function cloneGit(url: string, target: string, parent: string, timeoutMs = 300_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
      '-c', 'http.followRedirects=false', '-c', 'submodule.recurse=false',
      'clone', '--quiet', '--no-local', '--no-recurse-submodules', '--template=', '--', url, target,
    ], {
      cwd: parent, stdio: 'ignore', detached: process.platform !== 'win32',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0',
        GIT_ALLOW_PROTOCOL: 'https:ssh',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes' },
    });
    let finished = false;
    const done = (ok: boolean) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (ok) resolve(); else reject(new Error(cloneFailure));
    };
    const timer = setTimeout(() => {
      // macOS: kill this clone's process group, including hanging SSH/helpers.
      // Never target any other app/session. No disk cleanup on failure.
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
      done(false);
    }, timeoutMs);
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
  });
}
