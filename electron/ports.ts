import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspacePort } from '../src/shared';

const exec = promisify(execFile);
export type PortRoot = { id: string; workspaceId: string; pid: number; title: string };
export type PortRunner = (file: string, args: string[]) => Promise<string>;
const scanError = 'Could not scan terminal ports. Check that ps and lsof are available, then retry.';
async function run(file: string, args: string[]) {
  try { return (await exec(file, args, { timeout: 3000, maxBuffer: 1024 * 1024 })).stdout; }
  catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    // lsof exits 1 for an empty selection. Diagnostics or timeouts are NOT empty success.
    if (file === '/usr/sbin/lsof' && e.code === 1 && !e.killed && !e.stdout?.trim() && !e.stderr?.trim()) return '';
    throw new Error(scanError);
  }
}

// Only PID/PPID metadata is read. No process command lines, output, or environments.
export function processOwners(table: string, roots: PortRoot[]) {
  const children = new Map<number, number[]>();
  const alive = new Set<number>();
  for (const line of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) { if (line.trim()) throw new Error(scanError); continue; }
    const pid = Number(match[1]), parent = Number(match[2]);
    alive.add(pid); children.set(parent, [...(children.get(parent) || []), pid]);
  }
  const rootPids = new Set(roots.map(r => r.pid));
  const owners = new Map<number, PortRoot>();
  for (const root of roots) {
    if (!alive.has(root.pid)) continue;
    const pending = [root.pid], seen = new Set<number>();
    while (pending.length) {
      const pid = pending.pop()!;
      if (seen.has(pid) || (pid !== root.pid && rootPids.has(pid))) continue;
      seen.add(pid); owners.set(pid, root);
      pending.push(...(children.get(pid) || []));
    }
  }
  if (owners.size > 512) throw new Error('Too many terminal child processes to scan safely (limit 512).');
  return owners;
}

export function parseListeners(output: string, owners: Map<number, PortRoot>): WorkspacePort[] {
  let owner: PortRoot | undefined;
  const found = new Map<string, WorkspacePort>();
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { owner = owners.get(Number(line.slice(1))); continue; }
    if (!line.startsWith('n') || !owner) continue;
    const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(line.slice(1));
    if (!match) continue;
    const address = match[1] || match[2], port = Number(match[3]);
    if (port < 1 || port > 65535) continue;
    // Never turn LAN-only/remote listeners into misleading localhost links.
    const host = address === '::1' || address === '::' ? '[::1]'
      : address === '*' || address === '0.0.0.0' ? '127.0.0.1'
      : /^127(?:\.\d{1,3}){3}$/.test(address) ? address : null;
    if (!host) continue;
    const key = `${owner.workspaceId}:${port}`;
    const existing = found.get(key);
    if (!existing || (existing.url.includes('[::1]') && host !== '[::1]')) {
      found.set(key, { workspaceId: owner.workspaceId, terminalId: owner.id, port,
        url: `http://${host}:${port}`, label: owner.title, source: 'terminal' });
    }
  }
  return [...found.values()].sort((a, b) => a.port - b.port);
}

export class PortService {
  private pending: Promise<WorkspacePort[]> | null = null;
  private cached: WorkspacePort[] = [];
  private signature = '';
  private expires = 0;
  constructor(private roots: () => PortRoot[], private runner: PortRunner = run, private platform = process.platform) {}
  async list(): Promise<WorkspacePort[]> {
    while (this.pending) await this.pending;
    const roots = this.roots();
    const signature = JSON.stringify(roots);
    if (signature === this.signature && Date.now() < this.expires) return this.cached;
    if (!roots.length) { this.cached = []; this.signature = signature; return []; }
    if (this.platform !== 'darwin') throw new Error('Terminal port discovery currently supports macOS only.');
    const task = this.scan(roots).then(ports => {
      // Discard closed/exited sessions even if a scan was already in flight.
      const current = new Set(this.roots().map(r => `${r.id}:${r.pid}`));
      const active = new Set(roots.filter(r => current.has(`${r.id}:${r.pid}`)).map(r => r.id));
      this.cached = ports.filter(p => active.has(p.terminalId!));
      this.signature = signature; this.expires = Date.now() + 1500;
      return this.cached;
    });
    this.pending = task;
    try { return await task; } finally { if (this.pending === task) this.pending = null; }
  }
  private async scan(roots: PortRoot[]) {
    const owners = processOwners(await this.runner('/bin/ps', ['-axo', 'pid=,ppid=']), roots);
    if (!owners.size) return [];
    // -a is essential: AND selectors, never scan every listener on the machine.
    const output = await this.runner('/usr/sbin/lsof', ['-a', '-p', [...owners.keys()].join(','), '-iTCP', '-sTCP:LISTEN', '-n', '-P', '-Fpn']);
    return parseListeners(output, owners);
  }
}
