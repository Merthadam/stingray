// LaunchServices smoke: packaged app, isolated data, no repositories or terminals.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const bundle = path.resolve(process.env.STINGRAY_TEST_BUNDLE || 'release/Stingray.app');
const evidence = path.resolve(process.env.STINGRAY_TEST_EVIDENCE || 'artifacts/testing/2026-11-06-stingray-app');
const root = await mkdtemp(path.join(tmpdir(), 'stingray-package-launch-'));
const data = path.join(root, 'data');
await mkdir(data);
await mkdir(path.join(evidence, 'implementation'), { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.STINGRAY_DEV_URL;
const child = spawn('/usr/bin/open', [
  '-n', '-W', '-a', bundle,
  '--env', `STINGRAY_DATA_DIR=${data}`,
  '--env', 'STINGRAY_DEV_URL=', '--env', 'ELECTRON_RUN_AS_NODE=',
  '--env', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
  '--args', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-8192); });
const exited = new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', (code, signal) => resolve({ code, signal }));
});
let browser;
let closed = false;
try {
  let port;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { port = (await readFile(path.join(data, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (port) break;
    if (child.exitCode !== null) throw new Error(`LaunchServices exited before app readiness: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(port || '', /^\d+$/, 'packaged app created a debug endpoint in isolated data');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  // Let initial startup finish before reloading; otherwise our reload aborts startup resources.
  await page.waitForFunction(() => window.stingray?.mode === 'desktop');
  await page.getByRole('button', { name: 'Add project', exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  const errors = []; const consoleIssues = []; const failedRequests = []; const responses = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (['warning', 'error'].includes(m.type())) consoleIssues.push({ type: m.type(), text: m.text() }); });
  page.on('requestfailed', r => failedRequests.push({ url: r.url(), failure: r.failure() }));
  page.on('response', r => responses.push({ url: r.url(), status: r.status() }));
  // Reload after attaching instrumentation to observe every renderer resource.
  await page.reload();
  await page.waitForFunction(() => window.stingray?.mode === 'desktop');
  await page.getByRole('button', { name: 'Add project', exact: true }).waitFor();
  const state = await page.evaluate(async () => ({ state: await window.stingray.state(), terminals: await window.stingray.terminals() }));
  assert.equal(state.state.repos.length, 0);
  assert.equal(state.state.workspaces.length, 0);
  assert.equal(state.terminals.length, 0);
  const resourceBase = pathToFileURL(path.join(bundle, 'Contents/Resources/app/')).href;
  assert.ok(page.url().startsWith(resourceBase), 'renderer loaded from packaged resources');
  assert.ok(responses.length > 0 && responses.every(r => r.url.startsWith(resourceBase) && r.status < 400), 'all renderer resources loaded from the bundle, not a dev server');
  assert.deepEqual(errors, []); assert.deepEqual(consoleIssues, []); assert.deepEqual(failedRequests, []);
  await page.screenshot({ path: path.join(evidence, 'implementation/launchservices-empty.png') });
  const session = await browser.newBrowserCDPSession();
  await session.send('Browser.close').catch(e => { if (!String(e).includes('has been closed')) throw e; });
  let timer;
  const exit = await Promise.race([
    exited,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LaunchServices did not finish')), 10000); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(exit.code, 0);
  closed = true;
  await writeFile(path.join(evidence, 'launchservices-results.json'), JSON.stringify({
    launch: '/usr/bin/open -n -W -a ' + path.relative(process.cwd(), bundle),
    isolatedAppData: true, temporaryWorkingDirectory: true, restrictedPath: '/usr/bin:/bin:/usr/sbin:/sbin',
    desktopBridge: true, emptyState: true, noTerminalsLaunched: true,
    packagedResourcesOnly: true, resources: responses.map(r => ({ path: r.url.slice(resourceBase.length), status: r.status })),
    errors, consoleIssues, failedRequests, openExit: exit,
    limitation: 'LaunchServices with test-only environment/debugging flags; not a literal Finder double-click or Gatekeeper/notarization test.',
  }, null, 2));
  console.log('PASS LaunchServices opens packaged desktop with only bundled renderer resources, empty isolated state, no console/network failures; closes cleanly.');
} finally {
  if (browser && !closed) {
    const session = await browser.newBrowserCDPSession().catch(() => null);
    if (session) await session.send('Browser.close').catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  if (!closed) {
    let timer;
    const exit = await Promise.race([
      exited.catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),
    ]).finally(() => clearTimeout(timer));
    closed = exit?.code === 0;
  }
  if (child.exitCode === null) child.kill();
  // Preserve fixture data if app shutdown could not be established.
  if (closed) await rm(root, { recursive: true, force: true });
  else console.error('Unconfirmed launch cleanup; isolated fixture retained:', root);
}
