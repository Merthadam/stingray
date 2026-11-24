import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DockerRunner, DockerSocketFiles } from '../../../core/runtime';

const exec = promisify(execFile);
export const runDocker: DockerRunner = async (args, options = {}) => {
  const candidates = ['docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker', path.join(homedir(), '.docker/bin/docker')];
  for (const executable of candidates) {
    try {
      const env = { ...process.env };
      if (args[0] === '--host') { delete env.DOCKER_CONTEXT; delete env.DOCKER_HOST; }
      const { stdout, stderr } = await exec(executable, args, { timeout: options.timeout ?? 5000, maxBuffer: 2 * 1024 * 1024, env });
      return options.stderr ? stdout + stderr : stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('Docker is unavailable. Start your local container engine, then refresh.');
    }
  }
  throw new Error('Docker CLI not found. Install Docker or make its CLI available to Stingray.');
};

export const nodeDockerSocketFiles: DockerSocketFiles = {
  async colimaSockets(home) {
    const colima = path.join(home, '.colima');
    const profiles = await readdir(colima).catch(() => [] as string[]);
    const sockets = [path.join(colima, 'docker.sock'), ...profiles.filter(p => !p.startsWith('_')).map(p => path.join(colima, p, 'docker.sock'))];
    const found: string[] = [];
    for (const socket of sockets) if (await stat(socket).then(s => !s.isDirectory(), () => false)) found.push(socket);
    return found;
  },
  realpath: p => realpath(p).catch(() => p),
};
