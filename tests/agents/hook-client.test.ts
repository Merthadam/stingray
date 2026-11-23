import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { claudeReport, codexReport } from '../../agents/hook-client';
import { ActivityService } from '../../electron/core/activity/activity';

const fixture = async (name: string) => readFile(path.join('tests/fixtures/hooks', name + '.json'), 'utf8');
const session = '8f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

test('claude hook stdin fixtures map to phases from identity fields only', async () => {
  const parse = async (name: string, event: string) => claudeReport(event, JSON.parse(await fixture(name)));
  assert.deepEqual(await parse('claude-user-prompt-submit', 'UserPromptSubmit'), { session, phase: 'working', completed: false, ended: false });
  assert.deepEqual(await parse('claude-post-tool-use', 'PostToolUse'), { session, phase: 'working', completed: false, ended: false, resume: true });
  assert.deepEqual(await parse('claude-notification-permission', 'Notification'), { session, phase: 'waiting', completed: false, ended: false });
  // idle_prompt follows every turn by ~60 s: it is not a question and must not hide an unseen review.
  assert.equal(claudeReport('Notification', { session_id: session, notification_type: 'idle_prompt' }), undefined);
  assert.equal(claudeReport('PreToolUse', { session_id: session }), undefined);
  assert.equal(await parse('claude-notification-auth', 'Notification'), undefined);
  assert.deepEqual(await parse('claude-stop', 'Stop'), { session, phase: 'idle', completed: true, ended: false });
  assert.deepEqual(await parse('claude-session-end', 'SessionEnd'), { session, phase: 'idle', completed: false, ended: true });
  assert.deepEqual(claudeReport('StopFailure', { session_id: session }), { session, phase: 'failed', completed: false, ended: false });
  assert.deepEqual(claudeReport('SessionStart', { session_id: session, hook_event_name: 'SessionStart' })?.phase, 'idle');
  // Mismatched event names, unknown events and unsafe identities are dropped.
  assert.equal(await parse('claude-stop', 'PostToolUse'), undefined);
  for (const input of [null, 'x', { session_id: '../etc' }, { session_id: 42 }, {}]) assert.equal(claudeReport('Stop', input), undefined);
  assert.equal(claudeReport('SubagentStop', { session_id: session }), undefined);
});

test('codex notify fixture reports completion only; working/waiting are never claimed', async () => {
  assert.deepEqual(codexReport('notify', '4242', await fixture('codex-notify')), { session: '4242', phase: 'unknown', completed: true, ended: false });
  assert.deepEqual(codexReport('start', '4242'), { session: '4242', phase: 'unknown', completed: false, ended: false });
  for (const payload of [undefined, '{bad', '{"type":"other"}', 'x'.repeat((1 << 20) + 1)]) assert.equal(codexReport('notify', '4242', payload), undefined);
  assert.equal(codexReport('bogus', '4242'), undefined);
});

test('bundled client: exits 0 silently, reports metadata only, never leaks payloads', async () => {
  const root = await mkdtemp('/tmp/stingray-hook-');
  const client = path.join(root, 'hook-client.cjs');
  await build({ entryPoints: ['agents/hook-client.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: client, logLevel: 'silent' });
  const frames: string[] = [];
  const service = new ActivityService(snapshot => frames.push(JSON.stringify(snapshot))); await service.start();
  const env = { ...service.bind(randomUUID(), randomUUID()), STINGRAY_AGENT_PID: String(process.pid), PATH: '/usr/bin:/bin' };
  const run = (args: string[], stdin = '', extra = {}) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const child = execFile(process.execPath, [client, ...args], { env: { ...env, ...extra }, timeout: 5000 }, (error, stdout, stderr) =>
      resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout, stderr }));
    child.stdin!.end(stdin);
  });
  try {
    for (const [name, event] of [['claude-user-prompt-submit', 'UserPromptSubmit'], ['claude-notification-permission', 'Notification']]) {
      const result = await run(['claude', event], await fixture(name));
      assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
    }
    assert.equal(service.snapshot().agents[0].phase, 'waiting');
    await run(['claude', 'PostToolUse'], await fixture('claude-post-tool-use')); // permission granted, tool ran
    assert.equal(service.snapshot().agents[0].phase, 'working');
    await run(['claude', 'Stop'], await fixture('claude-stop'));
    assert.ok(service.snapshot().agents[0].reviewRevision);
    // Failures stay silent and successful: no socket, bad stdin, no binding.
    for (const [args, stdin, extra] of [[['claude', 'Stop'], '{bad', {}], [['claude', 'Stop'], await fixture('claude-stop'), { STINGRAY_ACTIVITY_SOCKET: path.join(root, 'missing.sock') }],
      [['claude', 'Stop'], await fixture('claude-stop'), { STINGRAY_ACTIVITY_TOKEN: '' }], [['other'], '', {}]] as const) {
      assert.deepEqual(await run([...args], stdin, extra), { code: 0, stdout: '', stderr: '' });
    }
    // Codex: start registers a run nonce with the environment token; notify (possibly from a daemon without the
    // terminal environment) authenticates with the argv nonce alone; JSON is the last argument.
    const nonce = 'c'.repeat(64), codexArgs = ['codex', 'notify', env.STINGRAY_ACTIVITY_SOCKET, nonce, String(process.pid), await fixture('codex-notify')];
    const noEnv = { STINGRAY_ACTIVITY_SOCKET: '', STINGRAY_ACTIVITY_TOKEN: '' };
    await run(codexArgs, '', noEnv);
    assert.equal(service.snapshot().agents.some(a => a.harness === 'codex'), false, 'an unregistered nonce creates nothing');
    assert.deepEqual(await run(['codex', 'start', env.STINGRAY_ACTIVITY_SOCKET, nonce, String(process.pid)]), { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(await run(codexArgs, '', noEnv), { code: 0, stdout: '', stderr: '' });
    const codex = service.snapshot().agents.find(a => a.harness === 'codex')!;
    assert.equal(codex.phase, 'unknown'); assert.ok(codex.reviewRevision);
    const published = frames.join('\n');
    for (const secret of ['PRIVATE', 'secret-prompt', session, env.STINGRAY_ACTIVITY_TOKEN, nonce, '/tmp/project']) assert.ok(!published.includes(secret), secret);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
