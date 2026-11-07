import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const executablePath = process.env.STINGRAY_TEST_APP ? path.resolve(process.env.STINGRAY_TEST_APP) : undefined;
const root = await mkdtemp(path.join(tmpdir(), 'stingray-map-ui-'));
const repo = path.join(root, 'map-fixture');
const evidence = path.resolve(process.env.STINGRAY_TEST_EVIDENCE || 'artifacts/testing/repo-map-treemap');
await mkdir(evidence, { recursive: true }); await mkdir(repo);
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8' });
async function put(file, content) { await mkdir(path.dirname(path.join(repo, file)), { recursive: true }); await writeFile(path.join(repo, file), content); }
const padding = '// Fixture context\n'.repeat(120);
git('init', '-b', 'main');
await put('src/App.tsx', padding + 'export const App = () => "Before";\n');
await put('src/components/Button.tsx', padding + 'export const Button = () => "Button";\n');
await put('src/components/Sidebar.tsx', padding + 'export const Sidebar = () => "Sidebar";\n');
await put('src/legacy.ts', 'export const legacy = true;\n');
await put('electron/main.ts', '// Main process\n'.repeat(40));
await put('electron/git.ts', '// Git service\n'.repeat(80));
await put('tests/app.test.ts', '// Existing tests\n'.repeat(40));
await put('README.md', '# Repo map fixture\n');
await put('.gitignore', 'ignored/\n');
await put('long.txt', Array.from({ length: 6000 }, (_, i) => `line ${i + 1}`).join('\n'));
for (let start = 0; start < 2048; start += 64) await Promise.all(Array.from({ length: 64 }, (_, i) => put(`bulk/file-${String(start + i).padStart(4, '0')}.ts`, '// Tracked file\n')));
git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
await put('src/App.tsx', padding + 'export const App = () => "Staged";\n'); git('add', 'src/App.tsx');
await put('src/App.tsx', padding + 'export const App = () => "Working";\n');
await put('src/components/Dialog.tsx', 'export const Dialog = () => "New dialog";\n');
await rm(path.join(repo, 'src/legacy.ts'));
await put('tests/map.test.ts', '// New map tests\n');
await put('binary.bin', Buffer.from([1, 0, 2]));
await put('ignored/secret.txt', 'must not appear');
const env = { ...process.env, STINGRAY_DATA_DIR: path.join(root, 'data') };
delete env.ELECTRON_RUN_AS_NODE; delete env.STINGRAY_DEV_URL;
let app; const checks = []; const errors = []; const timings = {};
function check(name, value) { assert.ok(value, name); checks.push(name); console.log('PASS', name); }
try {
  app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env, timeout: 30000 });
  const page = await app.firstWindow();
  // Desktop pointer events must not race the CDP-driven test inputs. This
  // applies only to this test-owned window, not an existing/production app.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true));
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForFunction(() => !!window.stingray);
  if (executablePath) assert.ok(page.url().startsWith(pathToFileURL(path.resolve(path.dirname(executablePath), '../Resources/app')).href + '/'), 'renderer loaded from candidate bundle');
  const state = await page.evaluate(async repo => { const current = await window.stingray.openRepository(repo); return window.stingray.createWorkspace(current.repos[0].id, 'clean-worktree'); }, repo); const id = state.workspaces[0].id;
  await page.reload(); await page.getByRole('button', { name: 'Open project map-fixture', exact: true }).click();
  const start = performance.now();
  await page.getByRole('tab', { name: /Repo Map/ }).click();
  await page.locator('.map-tile').first().waitFor(); timings.initialMapMs = performance.now() - start;
  // Keep a bounded event/state trace to distinguish polling regressions from
  // unexpected input or document replacement in the isolated test window.
  await page.evaluate(() => {
    const trace = window.mapTestTrace = [];
    const record = event => {
      trace.push({ time: performance.now(), event, scope: document.querySelector('[aria-label="Map folders"]')?.textContent,
        file: document.querySelector('.inspector-file-heading')?.textContent,
        mode: document.querySelector('[aria-label="File views"] [aria-selected="true"]')?.textContent });
      if (trace.length > 150) trace.shift();
    };
    for (const type of ['click', 'keydown', 'pointerdown', 'pointerup', 'gotpointercapture', 'lostpointercapture']) document.addEventListener(type, event => record({ type, key: event.key, x: event.clientX, y: event.clientY, target: event.target.closest('button,input,[role="separator"]')?.getAttribute('aria-label') || event.target.textContent?.slice(0, 80), trusted: event.isTrusted }), true);
    let previous = '';
    new MutationObserver(() => {
      const state = [document.querySelector('[aria-label="Map folders"]')?.textContent, document.querySelector('[aria-label="File views"] [aria-selected="true"]')?.textContent].join('|');
      if (state !== previous) { previous = state; record('state'); }
    }).observe(document.querySelector('.repo-map-view'), { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected'] });
  });
  const button = name => page.getByRole('button', { name, exact: true });
  const rootButton = () => page.getByRole('navigation', { name: 'Map folders' }).getByRole('button', { name: 'Root', exact: true });
  const screenshot = name => page.screenshot({ path: path.join(evidence, `${name}.png`) });
  async function find(file) {
    const start = performance.now();
    await page.getByLabel('Find a file on the map').fill(file); await button(`Find file ${file}`).click();
    await page.waitForFunction(file => [...document.querySelectorAll('.map-tile.file')].some(el => el.getAttribute('aria-label')?.endsWith(' file ' + file)), file);
    timings[`search:${file}`] = performance.now() - start;
  }
  async function framed(label) {
    await page.waitForFunction(() => {
      const view = document.querySelector('.map-viewport')?.getBoundingClientRect();
      const tiles = [...document.querySelectorAll('.map-tile')].map(el => el.getBoundingClientRect());
      return view && tiles.length > 0 && tiles.length <= 2000 && tiles.every(tile => tile.left >= view.left - 1 && tile.top >= view.top - 1 && tile.right <= view.right + 1 && tile.bottom <= view.bottom + 1);
    }); check(label, true);
  }
  async function focusFolder(name) { await button(`Open folder ${name}`).click({ position: { x: 6, y: 6 } }); }
  // Test-owned main process only: delay a real IPC response after collection,
  // then release it after a new selection/workspace has already rendered.
  async function gateResponse(channel, match) {
    await app.evaluate(({ ipcMain }, { channel, match }) => {
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error('Missing test IPC handler');
      const gate = globalThis.mapTestGate = { channel, original, entered: false, release: null };
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        const result = await original(event, ...args);
        if (!gate.entered && (channel === 'inspect-file' ? args[1] : args[0]) === match) {
          gate.entered = true; await new Promise(resolve => { gate.release = resolve; });
        }
        return result;
      });
    }, { channel, match });
  }
  async function waitGate() { await app.evaluate(async () => { for (let i = 0; i < 150; i++) { if (globalThis.mapTestGate?.entered) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('IPC gate was not entered'); }); }
  async function releaseGate() { await app.evaluate(({ ipcMain }) => { const gate = globalThis.mapTestGate; ipcMain.removeHandler(gate.channel); ipcMain.handle(gate.channel, gate.original); gate.release?.(); delete globalThis.mapTestGate; }); }
  check('Repo Map replaces Changes', await page.getByRole('tab', { name: /Changes/ }).count() === 0);
  check('inspector starts closed with no reserved panel space', await page.locator('.map-inspector').count() === 0);
  await framed('dense nested overview fits on one screen');
  check('no pan/zoom controls, pictograms or pagination', await page.locator('.map-controls,.map-pagination,.map-tile.file svg').count() === 0);
  check('folder frames contain nested descendants', await page.locator('.map-tile[data-depth="1"]').count() > 0 && await page.locator('.folder-frame').count() > 0);
  check('default all-files view includes unchanged entries', await page.locator('.map-tile.file.clean').count() > 0);
  const snapshot = await page.evaluate(id => window.stingray.repoSnapshot(id), id);
  check('ignored files are absent from inventory', !snapshot.files.some(file => file.path.startsWith('ignored/')));
  check('size budget and partial progress are explicit', snapshot.sizeProgress.checked <= 64 && snapshot.sizeProgress.read <= 64 && snapshot.sizeProgress.pending > 0 && snapshot.sizeNotice.includes('pending'));
  await screenshot('map-overview'); await screenshot('map-unknown-sizing');
  await find('src/App.tsx'); await page.getByText('Staged · HEAD → index', { exact: true }).waitFor();
  check('right inspector separates staged and unstaged diffs', await page.getByText('Unstaged · index → working tree', { exact: true }).isVisible());
  check('inspector shows actual net counts', await page.locator('.inspector-file-heading').getByLabel('1 lines added, 1 lines removed', { exact: true }).count() === 1);
  await framed('opening inspector keeps map within viewport');
  check('clicking a file does not add selection highlighting', await page.locator('.map-tile.selected,.map-tile[aria-selected=true]').count() === 0);
  await screenshot('map-diff');
  await button('Close inspector').click();
  check('close removes whole inspector and separator', await page.locator('.map-inspector,.inspector-divider').count() === 0);
  await button('Modified file src/App.tsx').click(); await page.getByText('Staged · HEAD → index', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Whole file', exact: true }).click();
  check('Whole file mode shows current contents', (await page.getByLabel('File content', { exact: true }).innerText()).includes('Working'));
  await screenshot('map-whole-file');
  await button('Mark reviewed').click(); check('review records this file version', await button('Reviewed').getAttribute('aria-pressed') === 'true');
  const scopeBeforePoll = await page.getByRole('navigation', { name: 'Map folders' }).innerText();
  const inputsBeforePoll = await page.evaluate(() => window.mapTestTrace.filter(entry => typeof entry.event === 'object').length);
  await put('src/App.tsx', padding + 'export const App = () => "Updated after review";\n// New line\n');
  await button('Mark reviewed').waitFor({ timeout: 15000 });
  check('polling wait has no unexpected pointer or keyboard input', await page.evaluate(() => window.mapTestTrace.filter(entry => typeof entry.event === 'object').length) === inputsBeforePoll);
  check('polling preserves focused scope and Whole file mode', await page.getByRole('navigation', { name: 'Map folders' }).innerText() === scopeBeforePoll && await page.getByRole('tab', { name: 'Whole file', exact: true }).getAttribute('aria-selected') === 'true');
  check('polling refreshes contents and invalidates review after edits', (await page.getByLabel('File content', { exact: true }).innerText()).includes('Updated after review'));
  await page.locator('.inspector-file-heading').getByLabel('2 lines added, 1 lines removed', { exact: true }).waitFor({ timeout: 15000 });
  check('polling updates actual line counts', await page.locator('.inspector-file-heading').getByLabel('2 lines added, 1 lines removed', { exact: true }).count() === 1);
  const sidebar = page.locator('.map-inspector'); const initialWidth = (await sidebar.boundingBox()).width;
  const divider = page.getByRole('separator', { name: 'Resize inspector' });
  await divider.focus(); await page.keyboard.press('ArrowLeft');
  check('keyboard separator resizes inspector', (await sidebar.boundingBox()).width > initialWidth + 10);
  const d = await divider.boundingBox(); await page.mouse.move(d.x + 2, d.y + 50); await page.mouse.down(); await page.mouse.move(d.x - 100, d.y + 50, { steps: 5 }); await page.mouse.up();
  timings.dividerDrag = { initialWidth, divider: d, immediate: (await sidebar.boundingBox()).width };
  // Pointer-move state updates may commit on the next renderer frame.
  await page.waitForFunction(min => document.querySelector('.map-inspector').getBoundingClientRect().width > min, initialWidth + 80);
  timings.dividerDrag.after = (await sidebar.boundingBox()).width;
  check('pointer-captured divider resizes inspector', timings.dividerDrag.after > initialWidth + 80);
  await framed('wide inspector leaves bounded map'); await screenshot('map-divider-wide');
  await divider.focus(); for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight');
  check('divider clamps minimum sidebar width', Math.abs((await sidebar.boundingBox()).width - 210) < 2);
  // ResizeObserver coalesces map geometry to a later frame. This single-file
  // scope should fill the resized viewport before we capture visual evidence.
  await page.waitForFunction(() => {
    const view = document.querySelector('.map-viewport').getBoundingClientRect();
    const tile = document.querySelector('.map-tile.file').getBoundingClientRect();
    return tile.width >= view.width - 12 && tile.right <= view.right;
  });
  await screenshot('map-divider-narrow');
  const priorWidth = (await sidebar.boundingBox()).width;
  await button('Expand inspector').click();
  check('expanded reader fills workspace content, not app navigation', await page.evaluate(() => {
    const a = document.querySelector('.map-inspector').getBoundingClientRect(), b = document.querySelector('.repo-map-body').getBoundingClientRect();
    return Math.abs(a.width - b.width) < 1 && a.left === b.left && b.left > 0;
  })); await screenshot('map-expanded');
  await page.keyboard.press('Escape');
  check('Escape restores reader before closing it', await sidebar.count() === 1 && await button('Expand inspector').count() === 1 && Math.abs((await sidebar.boundingBox()).width - priorWidth) < 2);
  check('restore preserves file mode and focused map', await page.getByRole('tab', { name: 'Whole file', exact: true }).getAttribute('aria-selected') === 'true' && await button('Modified file src/App.tsx').count() === 1);
  await screenshot('map-restored');
  await find('src/legacy.ts'); await page.getByText('Deleted file · showing index contents.', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Whole file', exact: true }).click();
  check('deleted ghost opens prior contents and real removals', (await page.getByLabel('File content', { exact: true }).innerText()).includes('legacy = true') && await page.locator('.inspector-file-heading').getByLabel('0 lines added, 1 lines removed', { exact: true }).count() === 1);
  await find('src/components/Dialog.tsx'); await page.getByText('New untracked file', { exact: true }).waitFor();
  check('global file search reveals nested files', await button('New file src/components/Dialog.tsx').isVisible());
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  check('component preview stays unsupported without executing source', await page.getByRole('heading', { name: 'No component preview configured' }).isVisible());
  await page.getByRole('tab', { name: 'Agent tracker', exact: true }).click();
  check('tracker does not invent agents or activity', await page.getByRole('heading', { name: 'No agent integrations connected' }).isVisible());
  await page.getByRole('tab', { name: 'File inspector', exact: true }).click();
  await button('Close inspector').click(); await rootButton().click(); await page.getByLabel('Only changes', { exact: true }).check();
  check('Only changes omits clean files', await page.locator('.map-tile.file.clean').count() === 0);
  await screenshot('map-only-changes');
  await page.getByLabel('Find a file on the map').fill('bulk/file-2047.ts');
  check('search explains clean results hidden by filter', (await button('Find file bulk/file-2047.ts').innerText()).includes('Hidden by Only changes'));
  await button('Find file bulk/file-2047.ts').click();
  check('explicit search action shows all and reveals filtered file', !await page.getByLabel('Only changes', { exact: true }).isChecked());
  await page.getByLabel('File content', { exact: true }).waitFor();
  await page.getByLabel('Find a file on the map').fill('src'); await page.getByLabel('Find a file on the map').press('Escape');
  check('Escape dismisses search before inspector', await sidebar.count() === 1 && await page.locator('.map-search-results').count() === 0);
  await page.getByLabel('Find a file on the map').fill('src'); await divider.focus(); await page.keyboard.press('Escape');
  check('search-first Escape also works with separator focus', await sidebar.count() === 1 && await page.locator('.map-search-results').count() === 0);
  await page.getByLabel('Find a file on the map').fill('src'); await button('Close inspector').focus(); await page.keyboard.press('Escape');
  check('search-first Escape also works with inspector focus', await sidebar.count() === 1 && await page.locator('.map-search-results').count() === 0);
  const boundsBefore = await page.locator('.map-viewport').boundingBox();
  await page.locator('.map-viewport').hover(); await page.mouse.wheel(0, 150);
  await page.mouse.move(boundsBefore.x + 2, boundsBefore.y + 2); await page.mouse.down(); await page.mouse.move(boundsBefore.x + 35, boundsBefore.y + 35); await page.mouse.up();
  await page.locator('.map-viewport').focus(); await page.keyboard.press('ArrowDown');
  check('wheel, drag and navigation keys do not pan map', JSON.stringify(await page.locator('.map-viewport').boundingBox()) === JSON.stringify(boundsBefore) && await page.locator('.map-viewport').evaluate(el => el.scrollTop === 0 && el.scrollLeft === 0));
  await find('binary.bin'); await page.getByText('Binary or non-UTF-8 file. Text inspection is unavailable.', { exact: true }).waitFor();
  check('binary inspection cannot be marked reviewed', await button('Mark reviewed').count() === 0);
  check('IPC blocks traversal and invalid priority hints', await page.evaluate(async id => {
    let rejected = 0; for (const op of [() => window.stingray.inspectFile(id, '../outside'), () => window.stingray.repoSnapshot(id, { file: '../outside' }), () => window.stingray.repoSnapshot(id, { file: 'ignored/secret.txt' })]) try { await op(); } catch { rejected++; } return rejected === 3;
  }, id));
  await button('Close inspector').click(); await rootButton().click(); await focusFolder('bulk');
  await framed('2,048-file scope renders dense treemap within 2,000-node budget');
  const nodeCount = await page.locator('.map-tile').count(); timings.bulkRenderedNodes = nodeCount;
  check('large scope is dense, not 24 large cards', nodeCount > 24 && nodeCount <= 2000);
  check('terminal tiles represent every file exactly once', await page.locator('.map-tile[data-terminal="true"]').evaluateAll(tiles => tiles.reduce((sum, el) => sum + Number(el.dataset.fileCount), 0)) === 2048);
  await screenshot('map-large-groups');
  const group = page.locator('.map-tile.group').first(); const groupCount = Number(await group.getAttribute('data-file-count'));
  await group.focus(); await page.keyboard.press('Enter');
  check('keyboard drill restores persistent map focus', await page.locator('.map-viewport').evaluate(el => document.activeElement === el));
  check('aggregate drill reduces scope without omission', groupCount < 2048 && await page.locator('.map-tile[data-terminal="true"]').evaluateAll(tiles => tiles.reduce((sum, el) => sum + Number(el.dataset.fileCount), 0)) === groupCount);
  await page.keyboard.press('Escape');
  check('Back restores prior scope', (await page.locator('.map-summary').innerText()).includes('2,048 files'));
  await find('bulk/file-2047.ts'); await page.getByLabel('File content', { exact: true }).waitFor();
  check('search reveals final file beyond rendered aggregates', await button('Unchanged file bulk/file-2047.ts').isVisible()); await screenshot('map-large-search');
  await gateResponse('inspect-file', 'README.md');
  await find('README.md'); await waitGate(); await find('src/App.tsx'); await page.getByText('Staged · HEAD → index', { exact: true }).waitFor();
  await button('Mark reviewed').click(); await releaseGate(); await page.waitForTimeout(150);
  check('late inspection cannot replace newer file, mode or review state', (await page.locator('.inspector-file-heading').innerText()).includes('src/App.tsx') && await button('Reviewed').count() === 1 && await page.getByRole('tab', { name: 'Git diff', exact: true }).getAttribute('aria-selected') === 'true');
  await find('long.txt'); await page.getByLabel('File content', { exact: true }).waitFor();
  const code = page.getByLabel('File content', { exact: true }); await code.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByText('line 6000', { exact: true }).waitFor();
  check('full-file reader reaches line 6,000 with bounded DOM', await page.locator('.code-line').count() <= 200);
  const scroll = await code.evaluate(el => el.scrollTop); await button('Expand inspector').click(); await button('Restore inspector').click();
  check('expand/restore preserves reader scroll position', Math.abs(await code.evaluate(el => el.scrollTop) - scroll) < 1);
  await put('long-diff.txt', Array.from({ length: 6001 }, (_, i) => `diff line ${i}`).join('\n'));
  await button('Refresh repository map').click(); await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh repository map"]').disabled);
  await find('long-diff.txt'); await page.getByLabel('Git diff content', { exact: true }).waitFor();
  await page.getByLabel('Git diff content', { exact: true }).evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByText('+diff line 6000', { exact: true }).waitFor();
  check('long diff also reaches its last line without silent truncation', await page.locator('.code-line').count() <= 200);
  await put('transient/removed.txt', 'temporary file\n');
  await button('Refresh repository map').click(); await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh repository map"]').disabled);
  await find('transient/removed.txt'); await page.getByLabel('Git diff content', { exact: true }).waitFor();
  await rm(path.join(repo, 'transient'), { recursive: true });
  await button('Refresh repository map').click(); await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh repository map"]').disabled);
  check('removed priority file and folder do not trap refresh on stale inventory', !(await page.locator('.inline-error').allTextContents()).some(text => text.includes('Showing the last successful map')) && (await page.locator('.map-summary').innerText()).startsWith('0 files'));
  await page.locator('.map-inspector .inline-error').filter({ hasText: 'File is not in this workspace’s Git inventory. Refresh the map.' }).waitFor();
  check('removed selected file has an explicit inspection error', await button('Mark reviewed').count() === 0);
  await find('src/App.tsx');
  // Geometry can settle before inspection IPC returns. Capture loaded content,
  // not the transient "Reading file…" state, in compact-reader evidence.
  await page.getByText('Staged · HEAD → index', { exact: true }).waitFor();
  await page.getByText('Unstaged · index → working tree', { exact: true }).waitFor();
  await page.getByLabel('Git diff content', { exact: true }).filter({ hasText: 'Updated after review' }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 540)); await page.waitForFunction(() => innerWidth === 760);
  await framed('compact map fits alongside sidebar');
  check('compact layout stays side-by-side without workspace overflow', await page.evaluate(() => {
    const body = document.querySelector('.repo-map-body'), map = document.querySelector('.map-column').getBoundingClientRect(), reader = document.querySelector('.map-inspector').getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth && body.scrollHeight <= body.clientHeight && Math.abs(map.top - reader.top) < 1 && reader.bottom <= innerHeight;
  }));
  check('compact sidebar keeps all reading-mode tabs inside the inspector', await page.locator('.inspector-modes').evaluate(el => {
    const bounds = el.closest('.map-inspector').getBoundingClientRect();
    return [...el.querySelectorAll('button')].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right && button.scrollWidth <= button.clientWidth; });
  })); await screenshot('map-compact');
  await button('Expand inspector').click(); await screenshot('map-compact-expanded'); await button('Restore inspector').click();
  check('compact expand/restore retains selected file', await button('Modified file src/App.tsx').isVisible());
  await button('Close inspector').click(); await rootButton().click(); await screenshot('map-compact-closed');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
  // Focus src so its real measured hierarchy is visible, not dominated by bulk.
  await focusFolder('src'); await page.waitForTimeout(1000); await screenshot('map-focused-folder');
  await find('src/App.tsx'); await page.getByText('Staged · HEAD → index', { exact: true }).waitFor();
  await gateResponse('repo-snapshot', id);
  // Let the real automatic refresh enter the gate. A poll/hint refresh can
  // arrive before a manual click and keep Refresh disabled until releaseGate;
  // waiting to click it here would deadlock the test against its own gate.
  await waitGate();
  timings.delayedSnapshot = {
    entered: await app.evaluate(() => globalThis.mapTestGate.entered),
    refreshDisabled: await button('Refresh repository map').isDisabled(),
  };
  check('automatic snapshot is held with Refresh disabled before workspace switch', timings.delayedSnapshot.entered && timings.delayedSnapshot.refreshDisabled);
  await page.getByRole('navigation', { name: 'Project workspaces' }).getByRole('button', { name: /clean-worktree/ }).click(); await page.locator('.map-tile').first().waitFor();
  check('workspace switch resets an open inspector without renderer reload', await sidebar.count() === 0 && state.workspaces.length === 2);
  await find('README.md'); await page.getByLabel('File content', { exact: true }).waitFor(); await releaseGate(); await page.waitForTimeout(150);
  check('late snapshot cannot overwrite new workspace inventory or inspector', (await page.locator('.inspector-file-heading').innerText()).includes('README.md') && (await page.locator('.map-title').innerText()).includes('0 changes') && await page.locator('.inline-error').count() === 0);
  await gateResponse('inspect-file', 'README.md'); await button('Refresh repository map').click(); await waitGate();
  await page.getByRole('navigation', { name: 'Project workspaces' }).getByRole('button', { name: 'main Local repository', exact: true }).click();
  await page.locator('.map-tile').first().waitFor(); await find('src/App.tsx'); await page.getByText('Staged · HEAD → index', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Whole file', exact: true }).click(); await button('Mark reviewed').click(); await releaseGate(); await page.waitForTimeout(150);
  check('late inspection from previous workspace preserves new content and review', (await page.getByLabel('File content', { exact: true }).innerText()).includes('Updated after review') && await button('Reviewed').count() === 1 && await page.locator('.inline-error').count() === 0);
  // An actual IPC rejection must remain visible with the last successful map,
  // and recovery must clear it without resetting navigation or reader state.
  await app.evaluate(({ ipcMain }) => {
    globalThis.mapSnapshotHandler = ipcMain._invokeHandlers.get('repo-snapshot');
    ipcMain.removeHandler('repo-snapshot'); ipcMain.handle('repo-snapshot', () => { throw new Error('Fixture snapshot unavailable'); });
  });
  await button('Refresh repository map').click();
  await page.locator('.repo-map-view > .inline-error').filter({ hasText: 'Showing the last successful map.' }).waitFor();
  check('snapshot failure is explicit and keeps the prior map', await button('Modified file src/App.tsx').count() === 1 && await button('Reviewed').isDisabled());
  await screenshot('map-refresh-error');
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('repo-snapshot'); ipcMain.handle('repo-snapshot', globalThis.mapSnapshotHandler); delete globalThis.mapSnapshotHandler; });
  await button('Refresh repository map').click(); await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh repository map"]').disabled);
  check('snapshot recovery preserves navigation and reading mode', await page.locator('.repo-map-view > .inline-error').count() === 0 && await page.getByRole('tab', { name: 'Whole file', exact: true }).getAttribute('aria-selected') === 'true' && await button('Modified file src/App.tsx').count() === 1);
  await page.getByRole('navigation', { name: 'Project workspaces' }).getByRole('button', { name: /clean-worktree/ }).click(); await page.locator('.map-tile').first().waitFor();
  await rootButton().click();
  await page.getByLabel('Only changes', { exact: true }).check(); await page.getByRole('heading', { name: 'All clear.', exact: true }).waitFor();
  check('clean workspace has explicit empty filtered state', await page.locator('.map-tile').count() === 0);
  await button('Toggle agent tracker').click(); check('tracker opens independently of files', await page.getByRole('heading', { name: 'No agent integrations connected' }).isVisible());
  await button('Close inspector').focus(); await page.keyboard.press('Escape');
  check('Escape closes inspector and returns focus to map', await sidebar.count() === 0 && await page.locator('.map-viewport').evaluate(el => document.activeElement === el));
  check('no renderer exceptions', errors.length === 0);
  await writeFile(path.join(evidence, 'input-state-trace.json'), JSON.stringify(await page.evaluate(() => window.mapTestTrace || []), null, 2));
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ checks, errors, timings, scope: `${executablePath ? 'Packaged macOS Electron' : 'Isolated source Electron'}, temporary Git fixtures with 2,048-file directory. OS pointer input ignored; Playwright CDP input retained. 100k coverage is model-only. No real agents or component rendering.` }, null, 2));
} catch (error) {
  console.error(error); process.exitCode = 1;
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ checks, errors, timings, failure: String(error) }, null, 2));
  if (app) { const page = (await app.windows())[0]; if (page) {
    await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    await writeFile(path.join(evidence, 'input-state-trace.json'), JSON.stringify(await page.evaluate(() => window.mapTestTrace || []), null, 2)).catch(() => {});
  } }
} finally {
  if (app) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {}); await app.close().catch(() => {}); }
  await rm(root, { recursive: true, force: true });
}
