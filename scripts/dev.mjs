// npm run dev: own data dir, Vite for the renderer, esbuild watch for main/preload/worker/CLI with an Electron restart
// after every successful rebuild. A failed rebuild prints esbuild's errors and leaves the running app alone.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { context } from 'esbuild';
import { createServer } from 'vite';
import { buildExtras, electronBuildOptions } from './build-electron.mjs';

const appData = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
  : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const dataDir = path.resolve(process.env.STINGRAY_DATA_DIR || path.join(appData, 'Stingray-dev'));
console.log(`Stingray dev data: ${dataDir}`);

await buildExtras();
const server = await createServer();
await server.listen();
const env = { ...process.env, STINGRAY_DEV_URL: 'http://127.0.0.1:5178', STINGRAY_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;

let child = null, restarting = false, pending = false, stopping = false;
const stopChild = c => new Promise(resolve => { if (c.exitCode !== null || c.signalCode !== null) resolve(); else { c.once('exit', resolve); c.kill('SIGTERM'); } });
function launch() {
  const c = spawn('node_modules/.bin/electron', ['.'], { stdio: 'inherit', env });
  child = c;
  // Quitting the app (not a restart) ends the dev session, as before.
  c.on('exit', code => { if (child === c) child = null; if (!restarting && !stopping) void shutdown(code || 0); });
}
async function restart() {
  if (restarting) { pending = true; return; } // coalesce: at most one pending restart
  restarting = true;
  if (child) await stopChild(child);
  restarting = false;
  if (stopping) return;
  launch();
  if (pending) { pending = false; await restart(); }
}
const restartPlugin = { name: 'restart-electron', setup(build) {
  build.onEnd(result => {
    if (result.errors.length) { console.error(`Main-process build failed (${result.errors.length} error(s)); Electron keeps running the previous build.`); return; }
    void restart();
  });
} };
const ctx = await context({ ...electronBuildOptions, plugins: [restartPlugin] });
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  await ctx.dispose();
  if (child) await stopChild(child);
  await server.close();
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown(0));
await ctx.watch();
