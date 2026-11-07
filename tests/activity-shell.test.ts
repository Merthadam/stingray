import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import * as pty from 'node-pty';
import { ActivityShell, shellQuote } from '../electron/activity-shell';

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp('/tmp/stingray-shell-');
  const home = path.join(root, "home space ' quote"), bin = path.join(root, 'real bin'), bridge = path.join(root, 'bridge');
  await Promise.all([mkdir(home), mkdir(bin), mkdir(bridge)]);
  const record = path.join(root, 'args.json');
  await writeFile(path.join(bin, 'pi'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv.slice(2), marker:process.env.MARKER, run:process.env.STINGRAY_PI_RUN, zdot:process.env.ZDOTDIR}));`, { mode: 0o700 });
  const extension = path.join(root, "extension '; echo BAD; '.js");
  const shell = new ActivityShell(); await shell.prepare(bridge, extension);
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TERM: 'xterm-256color', STINGRAY_PI_RUN: 'inherited-parent', STINGRAY_PI_PID: '1' };
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
  return { root, home, bin, env, extension, shell, run, args, close: () => rm(root, { recursive: true, force: true }) };
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
