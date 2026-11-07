import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const executablePath = process.env.STINGRAY_TEST_APP ? path.resolve(process.env.STINGRAY_TEST_APP) : undefined;
const evidence = path.resolve(process.env.STINGRAY_TEST_EVIDENCE || `artifacts/testing/terminal-links/${Date.now()}`);
await mkdir(evidence, { recursive: true });
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'stingray-links-native-')));
const repo = path.join(root, 'link-fixture');
await mkdir(repo); await mkdir(path.join(root, 'shell'));
await writeFile(path.join(root, 'shell', '.zshrc'), "PROMPT='fixture % '\n");
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-b', 'main'); await writeFile(path.join(repo, 'README.md'), '# Link fixture\n'); git('add', '.');
git('-c', 'user.name=Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
const image = path.join(repo, 'screen shot.png');
await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'), { mode: 0o600 });
await writeFile(path.join(repo, 'run.command'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const inputLog = path.join(root, 'input.log'); await writeFile(inputLog, '');
const osc = (label, uri) => `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\\r\n`;
const output = '\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h' +
  osc('OPEN_SCREENSHOT', pathToFileURL(image).href) + osc('OPEN_RELATIVE', 'screen%20shot.png') +
  osc('OPEN_WEB', 'https://example.com/docs?q=fixture') + osc('REVEAL_SCRIPT', 'run.command') +
  osc('REJECT_SCHEME', 'javascript:alert(1)') + 'LINK_FIXTURE_READY\r\n';
const fixture = path.join(root, 'fixture.cjs');
const redrawFile = path.join(root, 'redraw.txt'); await writeFile(redrawFile, '');
await writeFile(fixture, `const fs = require('node:fs'); process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write(${JSON.stringify(output)}); process.stdin.on('data', d => fs.appendFileSync(${JSON.stringify(inputLog)}, d)); fs.watchFile(${JSON.stringify(redrawFile)}, { interval: 20 }, () => process.stdout.write(fs.readFileSync(${JSON.stringify(redrawFile)}, 'utf8')));`);
const env = { ...process.env, STINGRAY_DATA_DIR: path.join(root, 'data'), ZDOTDIR: path.join(root, 'shell') };
delete env.ELECTRON_RUN_AS_NODE; delete env.STINGRAY_DEV_URL;
let app, page;
const checks = [], errors = [], pointerChecks = [];
const check = (name, ok) => { assert.ok(ok, name); checks.push(name); console.log('PASS', name); };
async function wait(fn, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out: ' + label);
}
try {
  app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env, timeout: 30000 });
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
  if (executablePath) assert.ok(page.url().startsWith(pathToFileURL(path.resolve(path.dirname(executablePath), '../Resources/app')).href + '/'), 'renderer loaded from candidate bundle');
  // Stub only OS dispatch and native confirmation in this isolated test process.
  // Never launch the real browser, a document handler, or fixture scripts.
  await app.evaluate(({ BrowserWindow, shell, dialog }) => {
    const window = BrowserWindow.getAllWindows()[0];
    // macOS still delivered desktop mousemove/leave with ignoreMouseEvents.
    // Hide only this fixture window; CDP input/rendering stay active. This is
    // renderer integration coverage, not native window/OS-handler acceptance.
    window.webContents.setBackgroundThrottling(false);
    window.hide();
    globalThis.linkCalls = []; globalThis.linkDialogs = []; globalThis.linkAnswer = 1;
    shell.openExternal = async target => { globalThis.linkCalls.push({ kind: 'web', target }); };
    shell.openPath = async target => { globalThis.linkCalls.push({ kind: 'file', target }); return globalThis.linkOpenError || ''; };
    shell.showItemInFolder = target => { globalThis.linkCalls.push({ kind: 'reveal', target }); };
    dialog.showMessageBox = async (_window, options) => {
      globalThis.linkDialogs.push(options);
      if (globalThis.holdLinkDialog) await new Promise(resolve => { globalThis.releaseLinkDialog = resolve; });
      return { response: globalThis.linkAnswer };
    };
  });
  await page.evaluate(async repo => { await window.stingray.openRepository(repo); }, repo);
  await page.reload(); await page.getByRole('button', { name: 'Open project link-fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
  await wait(() => page.evaluate(async () => (await window.stingray.terminals()).length === 1), 'terminal');
  const terminal = (await page.evaluate(() => window.stingray.terminals()))[0];
  await page.evaluate(async ({ id, command }) => window.stingray.writeTerminal(id, command), { id: terminal.id, command: `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}\r` });
  await page.locator('.xterm-rows').getByText('LINK_FIXTURE_READY', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.linkPointerEvents = [];
    const screen = document.querySelector('.xterm-screen');
    for (const type of ['mousemove', 'mouseenter', 'mouseleave']) screen.addEventListener(type, event => {
      window.linkPointerEvents.push({ type, x: event.clientX, y: event.clientY, trusted: event.isTrusted, time: performance.now() });
      window.linkPointerEvents.splice(0, Math.max(0, window.linkPointerEvents.length - 80));
    });
  });
  const calls = () => app.evaluate(() => globalThis.linkCalls);
  const dialogs = () => app.evaluate(() => globalThis.linkDialogs);
  async function click(label) {
    const el = page.locator('.xterm-rows').getByText(label, { exact: true });
    // Error banners can resize/repaint xterm between checks. Wait for fresh,
    // stable text geometry and a new hover, not a detached painted span.
    await page.mouse.move(0, 0);
    await wait(async () => !await page.locator('.terminal-surface').getAttribute('title'), 'previous hover cleared');
    let box, previous;
    await wait(async () => {
      box = await el.boundingBox();
      const stable = box && JSON.stringify(box) === JSON.stringify(previous);
      previous = box; return stable;
    }, 'stable terminal link');
    // xterm's screen owns pointer events; its painted text spans do not.
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const sample = { label, box, x, y };
    pointerChecks.push(sample);
    const inspect = () => page.evaluate(({ label, x, y }) => {
      const text = [...document.querySelectorAll('.xterm-rows span')].find(el => el.textContent === label);
      const screen = document.querySelector('.xterm-screen');
      const hit = document.elementFromPoint(x, y);
      return { text: text?.getBoundingClientRect().toJSON(), screen: screen?.getBoundingClientRect().toJSON(),
        hit: hit && { tag: hit.tagName, class: hit.className }, title: document.querySelector('.terminal-surface')?.getAttribute('title') };
    }, { label, x, y });
    await page.mouse.move(x, y);
    try { await wait(() => page.locator('.terminal-surface').getAttribute('title'), 'link hover'); }
    catch (error) {
      sample.failedHover = await inspect();
      // Diagnostic only: keep the failure even if entering an adjacent cell
      // restores hover. Do not retry the click or hide a real re-entry defect.
      await page.mouse.move(x + 8, y);
      sample.adjacentCellTitle = await page.locator('.terminal-surface').getAttribute('title');
      throw error;
    }
    finally { sample.afterMove = await inspect(); }
    await page.mouse.click(x, y);
  }
  // A direct outside/back movement must restore hover in the identical cell.
  // No adjacent-cell nudge, private xterm access or direct callback activation.
  const reentryBox = await page.locator('.xterm-rows').getByText('OPEN_SCREENSHOT', { exact: true }).boundingBox();
  assert.ok(reentryBox);
  const reentryPoint = { x: reentryBox.x + reentryBox.width / 2, y: reentryBox.y + reentryBox.height / 2 };
  await page.mouse.move(reentryPoint.x, reentryPoint.y);
  await wait(() => page.locator('.terminal-surface').getAttribute('title'), 'initial same-cell hover');
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.mouse.move(0, 0);
    await wait(async () => !await page.locator('.terminal-surface').getAttribute('title'), 'same-cell leave');
    assert.deepEqual(await page.locator('.xterm-rows').getByText('OPEN_SCREENSHOT', { exact: true }).boundingBox(), reentryBox);
    await page.mouse.move(reentryPoint.x, reentryPoint.y);
    await wait(() => page.locator('.terminal-surface').getAttribute('title'), 'same-cell re-entry hover');
  }
  check('same-cell re-entry restores hover three times without layout changes or adjacent movement', true);
  await page.mouse.click(reentryPoint.x, reentryPoint.y);
  await wait(async () => (await calls()).length === 1, 'file dispatch');
  check('actual OSC 8 screenshot click reaches main-process file opener', (await calls())[0].kind === 'file' && (await calls())[0].target === image);
  const first = (await dialogs())[0];
  check('confirmation exposes actual target and defaults to Cancel', first.detail.includes(image) && first.defaultId === 0 && first.cancelId === 0 && first.buttons[0] === 'Cancel');
  check('link click is not also forwarded to the mouse-reporting terminal program', (await readFile(inputLog, 'utf8')) === '');
  await click('OPEN_RELATIVE'); await wait(async () => (await calls()).length === 2, 'relative dispatch');
  check('relative OSC 8 link resolves against terminal workspace', (await calls())[1].target === image);
  await click('OPEN_WEB'); await wait(async () => (await calls()).length === 3, 'web dispatch');
  check('HTTP(S) OSC 8 click uses external browser handler, not window.open', (await calls())[2].kind === 'web' && (await calls())[2].target === 'https://example.com/docs?q=fixture');
  await click('REVEAL_SCRIPT'); await wait(async () => (await calls()).length === 4, 'reveal dispatch');
  check('script link is revealed rather than executed', (await calls())[3].kind === 'reveal');
  await click('REJECT_SCHEME');
  await page.getByRole('alert').filter({ hasText: 'Use an HTTP(S) link' }).waitFor();
  check('unsafe scheme click is rejected before any dialog or OS call', (await calls()).length === 4 && (await dialogs()).length === 4);
  await app.evaluate(() => { globalThis.linkAnswer = 0; });
  await click('OPEN_SCREENSHOT'); await wait(async () => (await dialogs()).length === 5, 'cancel dialog');
  await page.waitForTimeout(100);
  check('cancel does not invoke a system handler', (await calls()).length === 4);
  await app.evaluate(() => { globalThis.linkAnswer = 1; globalThis.linkOpenError = 'test-only raw system detail'; });
  await click('OPEN_SCREENSHOT');
  await page.getByRole('alert').filter({ hasText: 'The system could not open this link.' }).waitFor();
  check('OS open failure is visible without leaking raw details', !(await page.getByRole('alert').innerText()).includes('raw system detail'));
  await app.evaluate(() => { globalThis.linkOpenError = ''; });
  const before = (await calls()).length;
  const invalid = ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.com/', '../outside.png', 'data:text/html,unsafe'];
  for (const uri of invalid) {
    check('IPC rejects ' + uri.split(':')[0], await page.evaluate(async ({ id, uri }) => {
      try { await window.stingray.openTerminalLink(id, uri); return false; } catch { return true; }
    }, { id: terminal.id, uri }));
  }
  check('unknown terminal cannot invoke opener', await page.evaluate(async () => {
    try { await window.stingray.openTerminalLink('00000000-0000-4000-8000-000000000000', 'https://example.com'); return false; } catch { return true; }
  }));
  check('invalid IPC requests produce no OS calls', (await calls()).length === before);
  const senderBlocked = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const handler = ipcMain._invokeHandlers.get('open-terminal-link');
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    for (const event of [{ sender: {}, senderFrame: wc.mainFrame }, { sender: wc, senderFrame: {} }]) {
      try { await handler(event, '00000000-0000-4000-8000-000000000000', 'https://example.com'); return false; } catch { /* expected */ }
    }
    return true;
  });
  check('untrusted IPC sender and subframe are rejected', senderBlocked);
  await app.evaluate(() => { globalThis.holdLinkDialog = true; });
  const pending = page.evaluate(async id => window.stingray.openTerminalLink(id, 'https://example.com/'), terminal.id);
  await wait(() => app.evaluate(() => !!globalThis.releaseLinkDialog), 'held confirmation');
  check('concurrent link requests do not stack confirmation dialogs', await page.evaluate(async id => {
    try { await window.stingray.openTerminalLink(id, 'https://example.com/'); return false; } catch { return true; }
  }, terminal.id));
  await app.evaluate(() => { globalThis.holdLinkDialog = false; globalThis.releaseLinkDialog(); }); await pending;
  const priorDrag = (await calls()).length;
  const el = page.locator('.xterm-rows').getByText('OPEN_SCREENSHOT', { exact: true });
  const box = await el.boundingBox();
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await wait(() => page.locator('.terminal-surface').getAttribute('title'), 'drag hover');
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + box.height / 2); await page.mouse.up(); await page.waitForTimeout(100);
  check('dragging across a link does not open it', (await calls()).length === priorDrag);
  const plain = await page.locator('.xterm-rows').getByText('LINK_FIXTURE_READY', { exact: true }).boundingBox();
  await page.mouse.click(plain.x + 10, plain.y + plain.height / 2);
  await wait(async () => (await readFile(inputLog, 'utf8')).includes('\x1b[<'), 'ordinary mouse reporting');
  check('non-link clicks still reach the fullscreen terminal program', true);
  // Remounting terminals must replace, rather than duplicate, click handlers.
  await page.reload();
  await page.locator('.xterm-rows').getByText('OPEN_SCREENSHOT', { exact: true }).waitFor();
  const beforeReloadClick = (await calls()).length;
  const beforeReloadInput = await readFile(inputLog, 'utf8');
  await click('OPEN_SCREENSHOT');
  await wait(async () => (await calls()).length === beforeReloadClick + 1, 'remounted link');
  await page.waitForTimeout(100);
  check('reloaded terminal opens the link once and still suppresses terminal mouse reports',
    (await calls()).length === beforeReloadClick + 1 && (await readFile(inputLog, 'utf8')) === beforeReloadInput);
  // Re-entry must resolve the current OSC link, not reuse cached text/URI.
  const replaceBox = await page.locator('.xterm-rows').getByText('OPEN_SCREENSHOT', { exact: true }).boundingBox();
  assert.ok(replaceBox);
  const replacePoint = { x: replaceBox.x + replaceBox.width / 2, y: replaceBox.y + replaceBox.height / 2 };
  const beforeReplace = (await calls()).length;
  await page.mouse.move(0, 0);
  await wait(async () => !await page.locator('.terminal-surface').getAttribute('title'), 'replacement leave');
  await writeFile(redrawFile, '\x1b7\x1b[H\x1b[2K' + osc('OPEN_REPLACED__', 'https://example.com/replaced') + '\x1b8');
  await page.locator('.xterm-rows').getByText('OPEN_REPLACED__', { exact: true }).waitFor();
  await page.mouse.move(replacePoint.x, replacePoint.y);
  await wait(() => page.locator('.terminal-surface').getAttribute('title'), 'replaced link hover');
  await page.mouse.click(replacePoint.x, replacePoint.y);
  await wait(async () => (await calls()).length === beforeReplace + 1, 'replaced link dispatch');
  check('same-cell re-entry after PTY redraw opens only the new destination', (await calls()).at(-1).target === 'https://example.com/replaced');
  await page.mouse.move(0, 0);
  await wait(async () => !await page.locator('.terminal-surface').getAttribute('title'), 'removed link leave');
  await writeFile(redrawFile, '\x1b7\x1b[H\x1b[2KLINK_REMOVED___\x1b8');
  await page.locator('.xterm-rows').getByText('LINK_REMOVED___', { exact: true }).waitFor();
  const beforeRemovedInput = await readFile(inputLog, 'utf8');
  await page.mouse.move(replacePoint.x, replacePoint.y);
  await page.mouse.click(replacePoint.x, replacePoint.y);
  await wait(async () => (await readFile(inputLog, 'utf8')).length > beforeRemovedInput.length, 'removed link ordinary input');
  check('same-cell re-entry after link removal cannot open the stale destination',
    (await calls()).length === beforeReplace + 1 && !await page.locator('.terminal-surface').getAttribute('title'));
  const windows = app.windows().length;
  await page.evaluate(() => { window.open('https://example.com/'); }); await page.waitForTimeout(100);
  check('renderer popup blocking remains intact', app.windows().length === windows);
  await page.screenshot({ path: path.join(evidence, 'terminal-links.png') });
  check('no renderer exceptions', errors.length === 0);
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ checks, errors, pointerChecks, scope: `${executablePath ? 'Packaged macOS Electron' : 'Isolated source Electron'}, real PTY OSC 8 links and CDP mouse clicks; mouse-reporting terminal fixture; native confirmation and OS dispatch stubbed; no external app/network opened.` }, null, 2));
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  const pointerEvents = page ? await page.evaluate(() => window.linkPointerEvents).catch(() => null) : null;
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ checks, errors, pointerChecks, pointerEvents, failure: String(error) }, null, 2));
} finally {
  if (app) {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
    await app.close().catch(() => {});
  }
  await rm(root, { recursive: true, force: true });
}
