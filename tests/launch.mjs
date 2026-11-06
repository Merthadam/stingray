// Production npm entrypoint smoke test; isolated app data, no repositories or terminals.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
const root = await mkdtemp(path.join(tmpdir(), 'stingray-launch-'));
const evidence = path.resolve(process.env.STINGRAY_TEST_EVIDENCE || 'artifacts/testing/2026-11-06-stingray');
await mkdir(evidence, { recursive: true });
const env = { ...process.env, STINGRAY_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE; delete env.STINGRAY_DEV_URL;
const child = spawn('npm', ['start', '--', '--remote-debugging-port=0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-32768); });
child.stdout.resume();
const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
let browser;
try {
  const deadline = Date.now() + 20000;
  let endpoint;
  while (Date.now() < deadline) {
    endpoint = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
    if (endpoint) break;
    if (child.exitCode !== null) throw new Error('Desktop process exited before becoming ready');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!endpoint) throw new Error('Desktop debug endpoint not ready');
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => window.stingray?.mode === 'desktop');
  await page.getByRole('button', { name: 'Add project', exact: true }).waitFor();
  const noTerminals = await page.evaluate(async () => (await window.stingray.terminals()).length === 0);
  if (!noTerminals) throw new Error('Unexpected terminal auto-launch');
  const session = await browser.newBrowserCDPSession();
  // Electron can disconnect CDP before acknowledging Browser.close. Require clean process exit below.
  await session.send('Browser.close').catch(e => { if (!String(e).includes('has been closed')) throw e; });
  let timer;
  const exit = await Promise.race([
    exited,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Launch did not close')), 10000); }),
  ]).finally(() => clearTimeout(timer));
  if (exit.code !== 0) throw new Error('Nonzero launch exit');
  await writeFile(path.join(evidence, 'launch-results.json'), JSON.stringify({
    command: 'npm start -- --remote-debugging-port=0', desktopBridge: true, emptyState: true,
    isolatedAppData: true, noTerminalsLaunched: noTerminals, exit,
  }, null, 2));
  console.log('PASS npm start opens real desktop bridge and empty state, closes cleanly.');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null) child.kill();
  await rm(root, { recursive: true, force: true });
}
