import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { ActivityService } from '../../electron/core/activity/activity';
import { claudeHookEvents } from '../../electron/core/activity/harnesses';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import * as pty from 'node-pty';
import { ActivityShell, shellQuote } from '../../electron/adapters/driven/fs/activity-shell';

const exec = promisify(execFile);
const clientRoot = await mkdtemp('/tmp/stingray-shell-client-'), client = path.join(clientRoot, 'hook-client.cjs');
await build({ entryPoints: ['agents/hook-client.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: client, logLevel: 'silent' });
after(() => rm(clientRoot, { recursive: true, force: true }));
async function fixture(views = '') {
  const root = await mkdtemp('/tmp/stingray-shell-');
  const home = path.join(root, "home space ' quote"), bin = path.join(root, 'real bin'), bridge = path.join(root, 'bridge');
  await Promise.all([mkdir(home), mkdir(bin), mkdir(bridge)]);
  const record = path.join(root, 'args.json');
  for (const cmd of ['pi', 'claude', 'codex']) await writeFile(path.join(bin, cmd), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({cmd:${JSON.stringify(cmd)}, args:process.argv.slice(2), marker:process.env.MARKER, run:process.env.STINGRAY_PI_RUN, zdot:process.env.ZDOTDIR, agentPid:process.env.STINGRAY_AGENT_PID, pid:String(process.pid)}));`, { mode: 0o700 });
  const extension = path.join(root, "extension '; echo BAD; '.js");
  const service = new ActivityService(() => {}); await service.start();
  const binding = service.bind(randomUUID(), randomUUID());
  const shell = new ActivityShell(); await shell.prepare(bridge, { extension, hookClient: client, execPath: process.execPath, endpoint: service.endpoint }, views && path.join(root, views));
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TERM: 'xterm-256color', STINGRAY_PI_RUN: 'inherited-parent', STINGRAY_PI_PID: '1', ...binding };
  const run = (command: string, tty = true): Promise<{ stdout: string }> => {
    const options = { env: { ...env, ...shell.environment('/bin/zsh', env) }, cwd: root };
    if (!tty) return exec('/bin/zsh', ['-lic', command], { ...options, timeout: 10000 });
    return new Promise((resolve, reject) => {
      const child = pty.spawn('/bin/zsh', ['-lic', command], options);
      let stdout = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture PTY timeout')); }, 10000);
      child.onData(data => { stdout += data; });
      child.onExit(({ exitCode }) => { clearTimeout(timer); exitCode ? reject(new Error(stdout)) : resolve({ stdout }); });
    });
  };
  const args = async () => JSON.parse(await readFile(record, 'utf8'));
  return { root, home, bin, env, extension, shell, service, run, args, close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); } };
}

test('zsh typed Pi is additive, quoted, invocation-time PATH resolved; startup ordering preserved', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.home, '.zshenv'), 'export MARKER=env\n');
    await writeFile(path.join(f.home, '.zprofile'), 'MARKER=$MARKER-profile\n');
    // System zprofile may replace PATH: preserve a normal user override.
    await writeFile(path.join(f.home, '.zshrc'), `export PATH=${shellQuote(f.env.PATH)}\nMARKER=$MARKER-rc\n`);
    await writeFile(path.join(f.home, '.zlogin'), 'MARKER=$MARKER-login\n');
    await f.run(`pi --extension 'existing extension.ts' 'prompt with spaces and $literal'`);
    const actual = await f.args();
    assert.deepEqual(actual.args, ['--extension', f.extension, '--extension', 'existing extension.ts', 'prompt with spaces and $literal']);
    assert.equal(actual.marker, 'env-profile-rc-login'); assert.equal(actual.run, undefined); assert.equal(actual.zdot, f.home);
    const later = path.join(f.root, 'later'); await mkdir(later);
    await writeFile(path.join(later, 'pi'), `#!/bin/sh\nexec ${shellQuote(path.join(f.bin, 'pi'))} later "$@"\n`, { mode: 0o700 });
    await f.run(`export PATH=${shellQuote(f.shell.bin + ':' + later + ':' + f.env.PATH)}; pi`);
    assert.deepEqual((await f.args()).args, ['later', '--extension', f.extension]);
  } finally { await f.close(); }
});

test('ZDOTDIR changes, aliases and functions are preserved, unsupported shells untouched', async () => {
  const f = await fixture();
  try {
    const alternate = path.join(f.root, 'alternate'); await mkdir(alternate);
    await writeFile(path.join(f.home, '.zshenv'), `export ZDOTDIR=${shellQuote(alternate)}\n`);
    await writeFile(path.join(alternate, '.zshrc'), `export PATH=${shellQuote(f.env.PATH)}\nexport MARKER=alternate\n`);
    await f.run('pi'); assert.equal((await f.args()).marker, 'alternate'); assert.equal((await f.args()).zdot, alternate);
    await writeFile(path.join(alternate, '.zshrc'), `alias pi=${shellQuote(shellQuote(path.join(f.bin, 'pi')) + ' alias')}\n`);
    await f.run('pi'); assert.deepEqual((await f.args()).args, ['alias']);
    await writeFile(path.join(alternate, '.zshrc'), `pi() { ${shellQuote(path.join(f.bin, 'pi'))} function "$@"; }\n`);
    await f.run('pi arg'); assert.deepEqual((await f.args()).args, ['function','arg']);
    assert.deepEqual(f.shell.environment('/bin/bash', f.env), {});
    assert.deepEqual(new ActivityShell().environment('/bin/zsh', f.env), {});
  } finally { await f.close(); }
});

test('maintenance, no extensions, noninteractive, explicit paths and missing Pi pass through safely', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.home, '.zshrc'), `export PATH=${shellQuote(f.env.PATH)}\n`);
    for (const args of [['--help'], ['--version'], ['--no-extensions'], ['-ne'], ['-p','test'], ['--mode','rpc'], ['--mode=json'], ['list'], ['config'], ['update'], ['install','pkg'], ['--list-models']]) {
      await f.run('pi ' + args.map(shellQuote).join(' ')); assert.deepEqual((await f.args()).args, args);
    }
    await f.run('pi no-tty', false); assert.deepEqual((await f.args()).args, ['no-tty']);
    await f.run(shellQuote(path.join(f.bin, 'pi')) + ' explicit'); assert.deepEqual((await f.args()).args, ['explicit']);
    const result = await f.run(`export PATH=${shellQuote(f.shell.bin + ':/usr/bin:/bin')}; pi; print status=$?`);
    assert.match(result.stdout, /Pi is not installed/); assert.match(result.stdout, /status=127/);
  } finally { await f.close(); }
});

test('the stingray-views bin stays first on PATH after rc files rebuild it, only when installed', async () => {
  for (const views of ["views bin ' q", '']) {
    const f = await fixture(views);
    try {
      const viewsBin = path.join(f.root, views);
      // The rc file drops our directories and re-adds the views bin late: it moves up front again, once.
      await writeFile(path.join(f.home, '.zshrc'), `export PATH=${shellQuote(f.env.PATH + (views ? ':' + viewsBin : ''))}\n`);
      const { stdout } = await f.run('print -r -- "PATH=$PATH"');
      const expected = [f.shell.bin, ...(views ? [viewsBin] : []), f.bin, '/usr/bin', '/bin'].join(':');
      assert.ok(stdout.includes(`PATH=${expected}\r`), stdout);
    } finally { await f.close(); }
  }
});

test('claude wrapper adds the app-owned --settings hooks file and its own pid; passthroughs are untouched', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.home, '.zshrc'), `export PATH=${shellQuote(f.env.PATH)}\n`);
    const settings = path.join(path.dirname(f.shell.bin), 'claude-settings.json');
    await f.run(`claude 'prompt with $literal'`);
    const actual = await f.args();
    assert.deepEqual([actual.cmd, actual.args], ['claude', ['--settings', settings, 'prompt with $literal']]);
    assert.equal(actual.agentPid, actual.pid, 'exec keeps the wrapper pid for liveness');
    const hooks = JSON.parse(await readFile(settings, 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks), [...claudeHookEvents]);
    for (const event of claudeHookEvents) {
      const [{ hooks: [hook] }] = hooks[event];
      assert.equal(hook.type, 'command'); assert.equal(hook.timeout, 5); assert.equal(hook.async, event === 'PostToolUse' || undefined);
      assert.equal(hook.command, ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', process.execPath, client, 'claude', event].map(shellQuote).join(' '));
    }
    for (const args of [['--help'], ['-v'], ['-p', 'x'], ['--settings', 'mine.json'], ['--settings=mine.json'], ['--bare'], ['mcp', 'list'], ['config'], ['update'], ['doctor']]) {
      await f.run('claude ' + args.map(shellQuote).join(' ')); assert.deepEqual((await f.args()).args, args);
    }
    // Pass-through matching stops at `--`: later arguments are prompt text.
    await f.run(`claude -- -p`); assert.deepEqual((await f.args()).args, ['--settings', settings, '--', '-p']);
    await f.run('claude no-tty', false); assert.deepEqual((await f.args()).args, ['no-tty']);
    const result = await f.run(`export PATH=${shellQuote(f.shell.bin + ':/usr/bin:/bin')}; claude; print status=$?`);
    assert.match(result.stdout, /Claude Code is not installed/); assert.match(result.stdout, /status=127/);
  } finally { await f.close(); }
});

test('codex wrapper attaches notify per invocation, reports start, and never overrides a user notify', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.home, '.zshrc'), `export PATH=${shellQuote(f.env.PATH)}\n`);
    await f.run(`codex resume --last`);
    const actual = await f.args();
    assert.equal(actual.args[0], '-c'); assert.deepEqual(actual.args.slice(2), ['resume', '--last']);
    // The -c value is a TOML array of basic strings; these are JSON-compatible.
    const notify = JSON.parse(actual.args[1].replace(/^notify=/, ''));
    const [nonce] = notify.splice(7, 1);
    assert.deepEqual(notify, ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', process.execPath, client, 'codex', 'notify', f.service.endpoint, actual.pid]);
    // argv is world-readable: it holds a fresh per-run nonce, never the terminal token.
    assert.match(nonce, /^[a-f0-9]{64}$/); assert.notEqual(nonce, f.env.STINGRAY_ACTIVITY_TOKEN);
    notify.splice(7, 0, nonce);
    // The wrapper's background start event registers the run (by pid) without claiming any phase.
    // The start event comes from a cold background process; CI runners can take several seconds.
    await (async () => { for (let i = 0; i < 1500 && !f.service.snapshot().agents.length; i++) await new Promise(r => setTimeout(r, 10)); })();
    const [codex] = f.service.snapshot().agents;
    assert.deepEqual([codex?.harness, codex?.phase], ['codex', 'unknown']);
    // Running the notify argv exactly as Codex would (JSON appended) marks the completion for review.
    await exec(notify[0], [...notify.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 't', 'last-assistant-message': 'PRIVATE' })]);
    assert.ok(f.service.snapshot().agents[0].reviewRevision);
    // A notify with any other nonce is rejected.
    f.service.acknowledge(codex.id, codex.terminalId, f.service.snapshot().agents[0].reviewRevision!);
    await exec(notify[0], [...notify.slice(1, 7), 'f'.repeat(64), notify[8], JSON.stringify({ type: 'agent-turn-complete' })]);
    assert.equal(f.service.snapshot().agents[0].reviewRevision, null);
    for (const args of [['--help'], ['-V'], ['exec', 'x'], ['e', 'x'], ['review'], ['login'], ['mcp', 'list'], ['features', 'list'], ['-c', 'notify=["x"]'], ['--config', 'notify = ["x"]'], ['--config=notify=["x"]'], ['--remote', 'ws://h:1']]) {
      await f.run('codex ' + args.map(shellQuote).join(' ')); assert.deepEqual((await f.args()).args, args);
    }
    // A prompt mentioning notify=, or anything after `--`, still attaches.
    for (const args of [['set notify=x'], ['--', '--help']]) {
      await f.run('codex ' + args.map(shellQuote).join(' ')); const { args: actual } = await f.args();
      assert.equal(actual[0], '-c'); assert.deepEqual(actual.slice(2), args);
    }
    await f.run('codex no-tty', false); assert.deepEqual((await f.args()).args, ['no-tty']);
    await mkdir(path.join(f.home, '.codex'));
    await writeFile(path.join(f.home, '.codex', 'config.toml'), 'model = "x"\n  notify = ["my-notifier"]\n');
    await f.run('codex'); assert.deepEqual((await f.args()).args, [], 'a user notify is never replaced');
    await rm(path.join(f.home, '.codex'), { recursive: true });
    await f.run('export STINGRAY_ACTIVITY_TOKEN=bad; codex'); assert.deepEqual((await f.args()).args, [], 'no valid binding: unattached');
  } finally { await f.close(); }
});
