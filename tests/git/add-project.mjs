// Real native UI + clone IPC; local Git upload-pack shim, not live SSH auth.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'stingray-add-project-')));
const source = path.join(root, 'source'); await mkdir(source);
const evidence = path.resolve(process.env.STINGRAY_TEST_EVIDENCE || 'artifacts/testing/2026-11-06-add-project/implementation/native');
await mkdir(evidence, { recursive: true });
const ssh = path.join(root, 'ssh-fixture'); const gate = path.join(root, 'continue');
await writeFile(ssh, `#!/bin/sh\nwhile [ ! -f '${gate}' ]; do sleep 0.05; done\nfor last do :; done\nexec /bin/sh -c "$last"\n`, { mode: 0o700 });
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-b', 'main'); await writeFile(path.join(source, 'README.md'), '# Native clone fixture\n'); git('add', '.');
git('-c', 'user.name=Stingray Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
const executablePath = process.env.STINGRAY_TEST_APP ? path.resolve(process.env.STINGRAY_TEST_APP) : undefined;
const env = { ...process.env, STINGRAY_DATA_DIR: path.join(root, 'data'), GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: 'ssh', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
delete env.STINGRAY_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [], consoleIssues = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
let app;
async function launch() {
  app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) consoleIssues.push(m.text()); });
  await page.getByRole('button', { name: 'Add project', exact: true }).waitFor();
  return page;
}
try {
  let page = await launch();
  const state = () => page.evaluate(() => window.stingray.state());
  const add = () => page.getByRole('button', { name: 'Add project', exact: true }).click();
  const url = 'ssh://fixture@localhost' + source;
  check('empty home has exactly one Add project action', await page.getByRole('button', { name: 'Add project', exact: true }).count() === 1 && await page.locator('.project-add-card,.project-empty button').count() === 0);
  await page.screenshot({ path: path.join(evidence, 'empty-home.png') });
  await add();
  check('local folder is the default source', await page.getByRole('button', { name: 'Local folder', exact: true }).getAttribute('aria-pressed') === 'true');
  // Stub only native OS chooser responses; IPC/service and Git remain real.
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.getByRole('button', { name: 'Browse folders', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('form[aria-busy=true]'));
  check('cancelled local chooser adds nothing and keeps dialog open', (await state()).repos.length === 0 && await page.getByRole('dialog').isVisible());
  await page.getByRole('button', { name: 'Repository URL', exact: true }).click();
  await page.getByRole('button', { name: 'Choose parent folder' }).click();
  await page.waitForFunction(() => !document.querySelector('form[aria-busy=true]'));
  check('cancelled parent chooser leaves destination blank', await page.getByLabel('New local folder').inputValue() === '');
  await page.getByLabel('Repository URL', { exact: true }).fill(url);
  await app.evaluate(({ dialog }, parent) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] }); }, root);
  await page.getByRole('button', { name: 'Choose parent folder' }).click();
  await page.waitForFunction(() => !document.querySelector('form[aria-busy=true]'));
  check('parent picker only suggests a destination, does not clone/register', await page.getByLabel('New local folder').inputValue() === path.join(root, 'source') && (await state()).repos.length === 0);
  await page.getByRole('button', { name: 'Clone project', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'destination already exists' }).waitFor();
  check('existing destination is refused with original files preserved', await readFile(path.join(source, 'README.md'), 'utf8') === '# Native clone fixture\n' && (await state()).repos.length === 0);
  await page.getByLabel('Repository URL', { exact: true }).fill('file:///not-allowed');
  await page.getByLabel('New local folder').fill(path.join(root, 'cloned'));
  await page.getByRole('button', { name: 'Clone project', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'HTTPS or SSH' }).waitFor();
  check('UI rejects unsafe URL before cloning', (await state()).repos.length === 0);
  const ipcRejected = await page.evaluate(async target => {
    try { await window.stingray.cloneRepository('ext::unsafe', target); return false; } catch (e) { return String(e).includes('HTTPS or SSH') && !String(e).includes('ext::unsafe'); }
  }, path.join(root, 'unsafe'));
  check('IPC service independently rejects unsafe URLs with a sanitized error', ipcRejected);
  await page.getByLabel('Repository URL', { exact: true }).fill(url);
  await page.getByRole('button', { name: 'Local folder', exact: true }).click();
  await page.getByRole('button', { name: 'Repository URL', exact: true }).click();
  await page.screenshot({ path: path.join(evidence, 'clone-dialog.png') });
  await page.getByRole('button', { name: 'Clone project', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Cloning and saving' }).waitFor();
  check('pending clone has progress and no premature registration', (await state()).repos.length === 0 && await page.getByRole('button', { name: 'Cloning…', exact: true }).isDisabled() && await page.getByLabel('New local folder').isDisabled());
  await page.keyboard.press('Escape');
  check('Escape cannot dismiss an active clone', await page.getByRole('dialog').isVisible());
  const duplicate = await page.evaluate(async ({ url, target }) => { try { await window.stingray.cloneRepository(url, target); return false; } catch (e) { return String(e).includes('already in progress'); } }, { url, target: path.join(root, 'duplicate') });
  check('duplicate IPC clone is refused while busy', duplicate);
  await app.evaluate(({ BrowserWindow, dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); BrowserWindow.getAllWindows()[0].close(); });
  check('native window close is blocked during cloning', app.windows().length === 1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 540));
  await page.waitForFunction(() => innerWidth === 760);
  check('compact dialog stays within viewport and scrolls its content', await page.evaluate(() => { const d = document.querySelector('dialog'), b = d.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight && b.width <= innerWidth && d.scrollWidth <= d.clientWidth; }));
  await page.screenshot({ path: path.join(evidence, 'clone-progress-compact.png') });
  await page.getByRole('status').filter({ hasText: 'Cloning and saving' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, 'clone-progress-visible.png') });
  await writeFile(gate, 'continue');
  await page.getByRole('button', { name: 'Open project cloned', exact: true }).waitFor();
  const saved = await state();
  check('real clone completes checkout and saves exactly one project', saved.repos.length === 1 && saved.workspaces.length === 1 && await readFile(path.join(root, 'cloned', 'README.md'), 'utf8') === '# Native clone fixture\n');
  check('clone launches no terminals', (await page.evaluate(() => window.stingray.terminals())).length === 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
  await page.screenshot({ path: path.join(evidence, 'cloned-home.png') });
  await page.reload();
  await page.getByRole('button', { name: 'Open project cloned', exact: true }).waitFor();
  check('clone registration survives renderer reload', (await state()).repos[0].id === saved.repos[0].id);
  await page.getByLabel('Find a project').fill('nothing-matches');
  check('search-empty home still has one Add project action', await page.getByRole('button', { name: 'Add project', exact: true }).count() === 1);
  await add();
  await page.getByRole('button', { name: 'Repository URL', exact: true }).click();
  await page.getByLabel('Repository URL', { exact: true }).fill(url + '-missing');
  await page.getByLabel('New local folder').fill(path.join(root, 'failed'));
  await page.getByRole('button', { name: 'Clone project', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Clone failed or timed out' }).waitFor();
  check('transport failure leaves card count unchanged and enables recovery', (await state()).repos.length === 1 && !(await page.getByRole('button', { name: 'Clone project', exact: true }).isDisabled()));
  await page.screenshot({ path: path.join(evidence, 'clone-error.png') });
  await page.getByLabel('Repository URL', { exact: true }).fill(url);
  await page.getByLabel('New local folder').fill(path.join(root, 'retry'));
  await page.getByRole('button', { name: 'Clone project', exact: true }).click();
  await page.getByRole('button', { name: 'Open project retry', exact: true }).waitFor();
  check('retry succeeds with new destination and clears home search', (await state()).repos.length === 2 && await page.getByLabel('Find a project').inputValue() === '');
  await page.getByRole('button', { name: 'Open project cloned', exact: true }).click();
  await page.getByRole('heading', { name: 'main', exact: true }).waitFor();
  check('cloned project opens its own workspace without auto-launch', (await page.locator('.project-current').innerText()).includes('cloned') && (await page.evaluate(() => window.stingray.terminals())).length === 0);
  await app.close(); app = undefined;
  page = await launch();
  await page.getByRole('button', { name: 'Open project cloned', exact: true }).waitFor();
  check('full app restart retains both clones and starts at home without terminals', (await state()).repos.length === 2 && (await page.evaluate(() => window.stingray.terminals())).length === 0);
  check('no renderer exceptions or console warnings/errors', errors.length === 0 && consoleIssues.length === 0);
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ passed: checks.length, checks, errors, consoleIssues, scope: 'Native Electron UI/IPC, real isolated Git transfer via SSH transport shim, not live provider/SSH authentication. Native chooser responses stubbed.' }, null, 2));
} catch (e) {
  console.error(e); process.exitCode = 1;
  if (app) await app.windows()[0]?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ checks, errors, consoleIssues, error: String(e) }, null, 2));
} finally {
  await writeFile(gate, 'continue');
  if (app) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {}); await app.close().catch(() => {}); }
  await rm(root, { recursive: true, force: true });
}
