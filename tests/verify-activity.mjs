// Source-only verification. No installs, packaging, provider calls or real user data.
// Run from the repository root. Optional step names select a bounded rerun.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, appendFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const names = ['build', 'unit', 'pi-native', 'pi-smoke', 'pull-requests', 'ports', 'desktop', 'add-project'];
const selected = process.argv.slice(2);
assert.ok(selected.every(name => names.includes(name)), `Steps: ${names.join(', ')}`);
const steps = selected.length ? names.filter(name => selected.includes(name)) : names;
const base = path.resolve('artifacts/testing/agent-activity/pi-verification');
await mkdir(base, { recursive: true });
const evidence = await mkdtemp(path.join(base, 'run-'));
const root = await mkdtemp('/tmp/stingray-verify-');
const home = path.join(root, 'home'), bin = path.join(root, 'bin'), tmp = path.join(root, 'tmp');
await Promise.all([mkdir(home), mkdir(bin), mkdir(tmp), writeFile(path.join(root, 'user.npmrc'), ''), writeFile(path.join(root, 'global.npmrc'), '')]);
for (const command of ['gh', 'docker']) await writeFile(path.join(bin, command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
// Allowlist, not process.env: no API keys, proxy, agent, Git, npm, Electron,
// Docker or app overrides leak into a fixture. Each native test owns app data.
const env = {
  HOME: home, ZDOTDIR: home, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(home, '.config'),
  PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  npm_config_userconfig: path.join(root, 'user.npmrc'), npm_config_globalconfig: path.join(root, 'global.npmrc'),
  npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false',
};
await writeFile(path.join(home, '.zshrc'), `export PATH=${JSON.stringify(env.PATH)}\nPROMPT='fixture % '\n`);
const unitFiles = (await readdir('tests')).filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
const commands = {
  build: [path.join(path.dirname(process.execPath), 'npm'), 'run', 'build'],
  unit: [process.execPath, '--import', 'tsx', '--test', '--test-concurrency=1', ...unitFiles],
  'pi-native': [process.execPath, 'tests/pi-activity.mjs'],
  'pi-smoke': [process.execPath, '--import', 'tsx', 'tests/pi-smoke.ts'],
  'pull-requests': [process.execPath, 'tests/pull-requests.mjs'],
  ports: [process.execPath, 'tests/workspace-status.mjs'],
  desktop: [process.execPath, 'tests/desktop.mjs'],
  'add-project': [process.execPath, 'tests/add-project.mjs'],
};
const results = [];
console.log(`Evidence: ${evidence}`);
try {
  for (const name of steps) {
    if (name === 'pi-smoke' && !process.env.PI_TEST_CLI) {
      results.push({ name, skipped: 'Set PI_TEST_CLI to an existing absolute Pi dist/cli.js; never installs Pi.' });
      continue;
    }
    const directory = path.join(evidence, name); await mkdir(directory);
    const logfile = path.join(evidence, `${name}.log`);
    const [command, ...args] = commands[name];
    console.log(`START ${name}`);
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { env: { ...env, STINGRAY_TEST_EVIDENCE: directory,
        ...(name === 'pi-smoke' ? { PI_TEST_CLI: process.env.PI_TEST_CLI } : {}) },
        detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let timedOut = false, output = '';
      // Kill only this test-owned process group on a hard timeout.
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 240000);
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, output }); });
    });
    await writeFile(logfile, result.output);
    results.push({ name, code: result.code, signal: result.signal, timedOut: result.timedOut, ms: Date.now() - started });
    console.log(`${result.code === 0 && !result.timedOut ? 'PASS' : 'FAIL'} ${name} (${Date.now() - started} ms)`);
    if (result.code !== 0 || result.timedOut) {
      console.error(result.output.slice(-6000)); process.exitCode = 1; break;
    }
  }
} catch (error) {
  await appendFile(path.join(evidence, 'runner-error.log'), String(error));
  process.exitCode = 1;
} finally {
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ steps, results,
    scope: 'Source build only. Sanitized HOME/config/environment; local Git fixtures, fake gh/docker, test-owned app data/PTYs. Real Pi smoke is opt-in and separately network-sandboxed. No installed-app promotion.' }, null, 2));
  await rm(root, { recursive: true, force: true });
}
