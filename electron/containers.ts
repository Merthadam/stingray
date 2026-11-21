import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { readdir, realpath, stat } from 'node:fs/promises';
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
  // Labels set by scripts/test-env.sh; absent on other containers.
  workspace: z.string().nullish(), cdp: z.string().nullish(), testEnv: z.string().nullish(),
});
// Never request environment variables, credentials, or full inspect output.
export const inspectFormat = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}""{{end}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"mounts":[{{range $i, $m := .Mounts}}{{if $i}},{{end}}{"Type":{{json $m.Type}},"Source":{{json $m.Source}}}{{end}}],"ports":{{json .NetworkSettings.Ports}},"workspace":{{json (index .Config.Labels "stingray.workspace")}},"cdp":{{json (index .Config.Labels "stingray.cdp")}},"testEnv":{{json (index .Config.Labels "stingray.test-env")}}}';

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
        if (!ports.some(p => p.url === url)) ports.push({ port, target, url, ...(row.cdp && target === `${row.cdp}/tcp` ? { cdp: true } : {}) });
      }
    }
    return { id: row.id, name: row.name.replace(/^\//, ''), image: row.image, state: row.state, health: row.health, testEnv: Boolean(row.testEnv),
      paths: [...(row.workspace?.startsWith('/') ? [row.workspace] : []), ...(row.workingDir ? [row.workingDir] : []), ...(row.mounts || []).filter(m => m.Type === 'bind').map(m => m.Source)], ports };
  }).filter(c => c.state === 'running').sort((a, b) => a.name.localeCompare(b.name));
}

export type DockerRunner = (args: string[], options?: { timeout?: number; stderr?: boolean }) => Promise<string>;
async function runDocker(args: string[], options: { timeout?: number; stderr?: boolean } = {}) {
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
}

const TEST_ENV_ONLY = 'Only running Stingray test environments (scripts/test-env.sh) can be stopped or read here.';

export class ContainerService {
  private pending: Promise<ContainerInfo[]> | null = null;
  private cached: ContainerInfo[] = [];
  private expires = 0;
  /** Docker endpoint each discovered container was found on, for test-env stop/logs. */
  private hosts = new Map<string, string>();
  constructor(private run: DockerRunner = runDocker, private env: NodeJS.ProcessEnv = process.env) {}
  list(): Promise<ContainerInfo[]> {
    if (this.pending) return this.pending;
    if (Date.now() < this.expires) return Promise.resolve(this.cached);
    this.pending = this.discover().then(value => {
      this.cached = value; this.expires = Date.now() + 4000; return value;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async stop(id: string) {
    await this.run(['--host', await this.testEnvHost(id), 'container', 'stop', '--time', '5', id], { timeout: 20000 });
    this.expires = 0;
  }
  /** Last 300 lines of stdout and stderr, merged in timestamp order. */
  async logs(id: string) {
    const output = await this.run(['--host', await this.testEnvHost(id), 'container', 'logs', '--timestamps', '--tail', '300', id], { stderr: true, timeout: 10000 });
    // RFC3339Nano drops trailing zeros: pad the fraction so timestamps compare as strings. Stable sort keeps stream order on ties.
    const key = (line: string) => line.split(' ', 1)[0].replace(/(?:\.(\d+))?Z$/, (_, f = '') => `.${f.padEnd(9, '0')}Z`);
    const lines = output.split('\n').filter(Boolean).map(line => ({ line, key: key(line) }))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(l => l.line).slice(-300);
    return lines.join('\n').slice(-256 * 1024);
  }
  // Re-check labels at action time: never act on a stale or non-test container.
  private async testEnvHost(id: string) {
    this.expires = 0;
    const container = (await this.list()).find(c => c.id === id);
    const host = this.hosts.get(id);
    if (!container?.testEnv || !host) throw new Error(TEST_ENV_ONLY);
    return host;
  }
  /** Local unix-socket endpoints: the active context, DOCKER_HOST and Colima profile sockets, deduplicated. */
  private async endpoints() {
    const hosts: string[] = [], errors: Error[] = [];
    let remote = false;
    const add = (host: string) => {
      if (host.startsWith('unix:///')) hosts.push(host); else if (host) remote = true;
    };
    try {
      add(this.env.DOCKER_CONTEXT
        ? (await this.run(['context', 'inspect', this.env.DOCKER_CONTEXT, '--format', '{{.Endpoints.docker.Host}}'])).trim()
        : this.env.DOCKER_HOST || (await this.run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).trim());
    } catch (error) { errors.push(error as Error); }
    if (this.env.DOCKER_HOST) add(this.env.DOCKER_HOST);
    const home = this.env.HOME;
    if (home) {
      const colima = path.join(home, '.colima');
      const profiles = await readdir(colima).catch(() => [] as string[]);
      const sockets = [path.join(colima, 'docker.sock'), ...profiles.filter(p => !p.startsWith('_')).map(p => path.join(colima, p, 'docker.sock'))];
      for (const socket of sockets) if (await stat(socket).then(s => !s.isDirectory(), () => false)) add('unix://' + socket);
    }
    // ~/.colima/docker.sock links to the default profile socket: dedupe by the resolved path.
    const unique = new Map<string, string>();
    for (const host of hosts) {
      const socket = host.slice('unix://'.length);
      const key = await realpath(socket).catch(() => socket);
      if (!unique.has(key)) unique.set(key, host);
    }
    if (!unique.size) throw errors[0] || new Error(remote ? 'Select a local Docker context. Remote container discovery is not supported.' : 'No local Docker endpoint found.');
    return [...unique.values()];
  }
  private async discover() {
    // Read-only commands are pinned to each local endpoint. Remote contexts must not become misleading localhost links.
    const results = await Promise.allSettled((await this.endpoints()).map(async host => ({ host, containers: await this.discoverHost(host) })));
    const found = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
    if (!found.length) throw (results[0] as PromiseRejectedResult).reason;
    const containers = new Map<string, ContainerInfo>();
    this.hosts = new Map();
    for (const { host, containers: list } of found) for (const c of list) {
      if (!containers.has(c.id)) { containers.set(c.id, c); this.hosts.set(c.id, host); }
    }
    return [...containers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  private async discoverHost(host: string) {
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
