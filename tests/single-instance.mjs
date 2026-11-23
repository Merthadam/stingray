// Native check, run by hand and in the done-bar run (needs `npm run build` and a display): a second instance on the
// same data dir exits with code 1 and names the data dir on stderr.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'stingray-single-instance-'));
const env = { ...process.env, STINGRAY_DATA_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE; delete env.STINGRAY_DEV_URL;
const electron = 'node_modules/.bin/electron';
const first = spawn(electron, ['.', '--remote-debugging-port=0'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let firstErr = '';
first.stderr.on('data', b => { firstErr += b; });
try {
  for (const end = Date.now() + 30000; !/DevTools listening/.test(firstErr); await new Promise(r => setTimeout(r, 100))) {
    if (first.exitCode !== null) throw new Error('First instance exited early');
    if (Date.now() > end) throw new Error('First instance not ready');
  }
  const second = spawn(electron, ['.'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  second.stderr.on('data', b => { stderr += b; });
  const code = await new Promise(resolve => second.on('exit', resolve));
  assert.equal(code, 1, 'second instance exit code');
  assert.ok(stderr.includes(`Stingray is already running with data dir ${dir}`), stderr);
  console.log('PASS second instance on the same data dir exits 1 and names the data dir.');
} finally {
  first.kill();
  await new Promise(resolve => (first.exitCode !== null ? resolve() : first.once('exit', resolve)));
  await rm(dir, { recursive: true, force: true });
}
