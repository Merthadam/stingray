import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ContainerInfo } from '../src/shared';

const exec = promisify(execFile);
const binding = z.object({ HostIp: z.string(), HostPort: z.string() });
const containerSchema = z.object({
  id: z.string(), name: z.string(), image: z.string(), state: z.string(), health: z.string(),
  workingDir: z.string().nullable(),
  mounts: z.array(z.object({ Type: z.string(), Source: z.string() })).nullable(),
  ports: z.record(z.string(), z.array(binding).nullable()).nullable(),
});
// Never request environment variables, credentials, or full inspect output.
export const inspectFormat = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}""{{end}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"mounts":[{{range $i, $m := .Mounts}}{{if $i}},{{end}}{"Type":{{json $m.Type}},"Source":{{json $m.Source}}}{{end}}],"ports":{{json .NetworkSettings.Ports}}}';

export function parseContainers(output: string): ContainerInfo[] {
  return output.split('\n').filter(line => line.trim()).map(line => {
    const row = containerSchema.parse(JSON.parse(line));
    const ports: ContainerInfo['ports'] = [];
    for (const [target, bindings] of Object.entries(row.ports || {})) {
      if (!/^\d+\/tcp$/.test(target)) continue;
      for (const b of bindings || []) {
        const port = Number(b.HostPort);
        if (!/^\d+$/.test(b.HostPort) || port < 1 || port > 65535) continue;
        // Wildcard bindings are reached through loopback. Never fabricate a
        // localhost link for a specific LAN binding or a remote Docker daemon.
        const host = b.HostIp === '::' || b.HostIp === '::1' ? '[::1]'
          : ['', '0.0.0.0', '127.0.0.1'].includes(b.HostIp) ? '127.0.0.1' : null;
        if (!host) continue;
        const url = `http://${host}:${port}`;
        if (!ports.some(p => p.url === url)) ports.push({ port, target, url });
      }
    }
    return { id: row.id, name: row.name.replace(/^\//, ''), image: row.image, state: row.state, health: row.health,
      paths: [...(row.workingDir ? [row.workingDir] : []), ...(row.mounts || []).filter(m => m.Type === 'bind').map(m => m.Source)], ports };
  }).filter(c => c.state === 'running').sort((a, b) => a.name.localeCompare(b.name));
}

export type DockerRunner = (args: string[]) => Promise<string>;
async function runDocker(args: string[]) {
  const candidates = ['docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker', path.join(homedir(), '.docker/bin/docker')];
  for (const executable of candidates) {
    try {
      const env = { ...process.env };
      if (args[0] === '--host') { delete env.DOCKER_CONTEXT; delete env.DOCKER_HOST; }
      return (await exec(executable, args, { timeout: 5000, maxBuffer: 2 * 1024 * 1024, env })).stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('Docker is unavailable. Start your local container engine, then refresh.');
    }
  }
  throw new Error('Docker CLI not found. Install Docker or make its CLI available to Stingray.');
}

export class ContainerService {
  private pending: Promise<ContainerInfo[]> | null = null;
  private cached: ContainerInfo[] = [];
  private expires = 0;
  constructor(private run: DockerRunner = runDocker, private env: NodeJS.ProcessEnv = process.env) {}
  list(): Promise<ContainerInfo[]> {
    if (this.pending) return this.pending;
    if (Date.now() < this.expires) return Promise.resolve(this.cached);
    this.pending = this.discover().then(value => {
      this.cached = value; this.expires = Date.now() + 4000; return value;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  private async discover() {
    // Resolve the active endpoint once, then pin subsequent read-only commands
    // to it. Remote contexts must not become misleading localhost quick links.
    const host = this.env.DOCKER_CONTEXT
      ? (await this.run(['context', 'inspect', this.env.DOCKER_CONTEXT, '--format', '{{.Endpoints.docker.Host}}'])).trim()
      : this.env.DOCKER_HOST || (await this.run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).trim();
    if (!host.startsWith('unix:///')) throw new Error('Select a local Docker context. Remote container discovery is not supported.');
    const prefix = ['--host', host];
    const ids = (await this.run([...prefix, 'container', 'ls', '--quiet', '--no-trunc', '--filter', 'status=running'])).trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return [];
    if (ids.length > 200 || ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error('Docker returned an unsupported container list (limit: 200).');
    const containers = parseContainers(await this.run([...prefix, 'container', 'inspect', '--format', inspectFormat, ...ids]));
    // Git registrations are canonical paths; Compose and bind mounts can use
    // symlinks (notably /var versus /private/var on macOS).
    return Promise.all(containers.map(async container => ({ ...container,
      paths: await Promise.all(container.paths.map(p => realpath(p).catch(() => p))),
    })));
  }
}
