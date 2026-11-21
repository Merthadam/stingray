import { createConnection } from 'node:net';
import type { AgentPhase } from '../src/activity';

// Short-lived reporter run once per Claude Code hook / Codex notify invocation.
// Bundled to dist-electron/hook-client.cjs and run with Stingray's Electron binary as plain Node
// (ELECTRON_RUN_AS_NODE=1): always present, unlike a `node` on the user's PATH.
// It reads only session/event identity fields, never prompts, tool data or model output, prints
// nothing, always exits 0 within a tight deadline, and so never blocks or changes an agent decision.

export type HookReport = { session: string; phase: AgentPhase; completed: boolean; ended: boolean };
const session = /^[A-Za-z0-9_-]{1,128}$/;
const report = (id: unknown, phase: AgentPhase, completed = false, ended = false): HookReport | undefined =>
  typeof id === 'string' && session.test(id) ? { session: id, phase, completed, ended } : undefined;

/** Claude Code hook stdin -> report. `event` is the hook name Stingray registered the command for. */
export function claudeReport(event: string, input: unknown): HookReport | undefined {
  if (!input || typeof input !== 'object') return;
  const { session_id: id, hook_event_name: name, notification_type: kind } = input as Record<string, unknown>;
  if (name !== undefined && name !== event) return;
  switch (event) {
    case 'SessionStart': return report(id, 'idle');
    case 'UserPromptSubmit': case 'PreToolUse': case 'PostToolUse': return report(id, 'working');
    case 'Notification': return kind === 'permission_prompt' || kind === 'idle_prompt' || kind === 'elicitation_dialog' ? report(id, 'waiting') : undefined;
    case 'Stop': return report(id, 'idle', true);
    case 'StopFailure': return report(id, 'failed');
    case 'SessionEnd': return report(id, 'idle', false, true);
  }
}

/** Codex: `start` from the PATH wrapper, `notify` from the legacy notify program (JSON as last argv).
 * Codex reports only turn completion, so working/waiting are never observed: phase stays unknown. */
export function codexReport(event: string, pid: string, payload?: string): HookReport | undefined {
  if (event === 'start') return report(pid, 'unknown');
  if (event !== 'notify' || !payload || payload.length > 1 << 20) return;
  try { return (JSON.parse(payload) as { type?: unknown })?.type === 'agent-turn-complete' ? report(pid, 'unknown', true) : undefined; } catch { return; }
}

async function readStdin(limit = 1 << 20) {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length; if (size > limit) return ''; // huge tool payloads are dropped, not parsed
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(endpoint: string | undefined, token: string | undefined, harness: 'claude' | 'codex', pid: number, value: HookReport | undefined) {
  if (!value || !endpoint?.startsWith('/') || !token || !/^[a-f0-9]{64}$/.test(token) || !Number.isInteger(pid) || pid < 2) return Promise.resolve();
  return new Promise<void>(resolve => {
    const socket = createConnection(endpoint);
    socket.on('error', () => resolve()); socket.on('close', () => resolve());
    socket.on('connect', () => { socket.end(JSON.stringify({ type: 'event', v: 2, token, harness, pid, at: Date.now(), ...value }) + '\n'); });
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [harness, event] = argv;
  if (harness === 'claude') {
    let input: unknown; try { input = JSON.parse(await readStdin()); } catch { return; }
    await send(env.STINGRAY_ACTIVITY_SOCKET, env.STINGRAY_ACTIVITY_TOKEN, 'claude', Number(env.STINGRAY_AGENT_PID), claudeReport(event, input));
  } else if (harness === 'codex') {
    // Codex may run notify from a shared daemon without the terminal environment, so the wrapper passes the binding in argv.
    const [, , endpoint, token, pid, payload] = argv;
    await send(endpoint, token, 'codex', Number(pid), codexReport(event, pid, payload));
  }
}

if (process.argv[1]?.endsWith('hook-client.cjs')) {
  setTimeout(() => process.exit(0), 1500).unref();
  main().catch(() => {}).finally(() => process.exit(0));
}
