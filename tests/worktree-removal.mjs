// Real Git and isolated Electron. Only disposable test worktrees are removed.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'stingray-removal-ui-'));
const repo = path.join(root, 'fixture'), bin = path.join(root, 'bin'), home = path.join(root, 'home');
const evidence = path.resolve(process.env.STINGRAY_TEST_EVIDENCE || 'artifacts/testing/worktree-removal/native');
await Promise.all([mkdir(repo), mkdir(bin), mkdir(home), mkdir(evidence, { recursive: true })]);
for (const name of ['gh', 'docker']) { await writeFile(path.join(bin, name), '#!/bin/sh\nexit 1\n'); await chmod(path.join(bin, name), 0o755); }
await writeFile(path.join(home, '.zshrc'), "PROMPT='fixture % '\n");
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
git(repo, 'init', '-b', 'main');
await writeFile(path.join(repo, 'file.txt'), 'base\n'); await writeFile(path.join(repo, '.gitignore'), 'ignored/\n');
const commit = cwd => { git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'); return git(cwd, 'rev-parse', 'HEAD').trim(); };
const base = commit(repo);
const env = { ...process.env, HOME: home, ZDOTDIR: home, PATH: bin + path.delimiter + process.env.PATH, STINGRAY_DATA_DIR: path.join(root, 'data'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'STINGRAY_DEV_URL', 'DOCKER_CONTEXT', 'DOCKER_HOST']) delete env[key];
let app, page; const checks = [], errors = [];
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
const active = () => page.locator('.workspace-entry.selected .workspace-link');
const card = name => page.locator('.workspace-entry').filter({ has: page.getByRole('button', { name, exact: true }) });
const dialog = () => page.getByRole('dialog');
const removeButton = () => dialog().getByRole('button', { name: 'Remove worktree', exact: true });
const acknowledge = () => dialog().getByRole('checkbox');
const cancel = () => dialog().getByRole('button', { name: 'Keep worktree', exact: true }).click();
async function selected(name) { await page.waitForFunction(name => document.querySelector('.workspace-entry.selected .workspace-link')?.getAttribute('aria-label') === name, name); }
async function openRemoval(name) {
  await card(name).getByRole('button', { name: `Remove worktree ${name}`, exact: true }).click();
  await dialog().getByLabel('Worktree safety checks').waitFor();
}
try {
  app = await electron.launch({ args: ['.'], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
  const state = await page.evaluate(async repo => {
    const s = await window.stingray.openRepository(repo);
    return window.stingray.createWorkspace(s.repos[0].id, 'feature/remove');
  }, repo);
  const worktree = state.workspaces.find(w => w.managed);
  await page.reload(); await page.getByRole('button', { name: 'Open project fixture', exact: true }).click();
  await selected('main');
  // Synthetic metadata, not a provider invocation; exercise the actual Idle component.
  await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].webContents.send('activity-event', {
    revision: 100000, agents: [{ id: 'fixture-agent', terminalId: 'fixture-terminal', workspaceId: w.id, connection: 'connected', phase: 'idle', reviewRevision: null }],
  }), worktree);
  await card('feature/remove').getByRole('status', { name: 'Pi: Idle', exact: true }).waitFor();
  for (const size of [[1200, 800], [760, 540]]) {
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), size);
    await page.waitForFunction(width => innerWidth === width, size[0]);
    for (const target of ['padding', 'center', 'right edge', 'bottom edge', 'icon', 'Idle', 'name']) {
      await page.getByRole('button', { name: 'main', exact: true }).click(); await selected('main');
      const c = card('feature/remove'); await c.scrollIntoViewIfNeeded();
      if (target === 'icon') await c.locator('.pr-symbol').click();
      else if (target === 'Idle') {
        const b = await c.getByRole('status', { name: 'Pi: Idle', exact: true }).boundingBox();
        const point = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        if (!process.env.STINGRAY_CARD_ONLY) check(`${size[0]}px: Idle tooltip remains accessible above the card hit area`, await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.workspace-activity')?.getAttribute('title')), point));
        await page.mouse.click(point.x, point.y);
      }
      else if (target === 'name') await c.locator('.workspace-link').click();
      else {
        const b = await c.evaluate(el => {
          const r = el.getBoundingClientRect(), nav = el.closest('nav').getBoundingClientRect();
          return { x: r.x, y: Math.max(r.y, nav.y), width: r.width, height: Math.min(r.bottom, nav.bottom) - Math.max(r.y, nav.y) };
        });
        const points = { padding: [3, 3], center: [b.width / 2, b.height / 2], 'right edge': [b.width - 3, b.height / 2], 'bottom edge': [b.width / 2, b.height - 3] };
        // Raw mouse click tests the actual hit target, not locator retries/forced events.
        const point = { x: b.x + points[target][0], y: b.y + points[target][1] };
        if (!process.env.STINGRAY_CARD_ONLY) check(`${size[0]}px: ${target} resolves to a card action or its activity tooltip`, await page.evaluate(({ x, y, center }) => {
          const el = document.elementFromPoint(x, y);
          return el?.closest('button')?.classList.contains('workspace-link') || (center && Boolean(el?.closest('.workspace-activity')?.getAttribute('title')));
        }, { ...point, center: target === 'center' }));
        await page.mouse.click(point.x, point.y);
      }
      await selected('feature/remove'); check(`${size[0]}px: ${target} selects the entire workspace card`);
    }
    await page.getByRole('button', { name: 'main', exact: true }).focus();
    await page.keyboard.press('Space'); await selected('main');
    await card('feature/remove').locator('.git-refresh').click(); await selected('main');
    check(`${size[0]}px: keyboard selection works; background refresh stays independent`);
  }
  await card('feature/remove').locator('.git-lines').click(); await selected('feature/remove');
  await page.getByRole('tab', { name: /^(Repo Map|Changes)/ }).waitFor();
  check('line-count action selects its own workspace and opens Repo Map', await page.getByRole('tab', { name: /^(Repo Map|Changes)/ }).getAttribute('aria-selected') === 'true');
  await page.getByRole('tab', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'main', exact: true }).click(); await selected('main');
  if (!process.env.STINGRAY_CARD_ONLY) {
    check('primary repository has no sidebar remove action', await card('main').locator('.workspace-remove').count() === 0);
    const missingConsent = await page.evaluate(async w => {
      try { await window.stingray.removeWorkspace(w.id, w.branch); return false; } catch { return true; }
    }, worktree);
    await access(worktree.path);
    check('IPC refuses removal without the safety-review consent object', missingConsent);
    await openRemoval('feature/remove');
    check('sidebar removal does not select a background workspace', await active().getAttribute('aria-label') === 'main');
    check('no-upstream warning and branch preservation are explicit', (await dialog().innerText()).includes('No upstream') && (await dialog().innerText()).includes('Keeps its branch and commits'));
    await dialog().getByLabel('Branch confirmation').fill(worktree.branch);
    check('unknown push status requires acknowledgement', await removeButton().isDisabled());
    await acknowledge().check(); check('acknowledgement enables removal for a clean worktree', await removeButton().isEnabled());
    await page.screenshot({ path: path.join(evidence, 'unknown-push-compact.png') });
    await cancel(); await access(worktree.path); check('cancel preserves worktree and branch');
    await writeFile(path.join(worktree.path, 'local.txt'), 'keep my changes');
    await mkdir(path.join(worktree.path, 'ignored')); await writeFile(path.join(worktree.path, 'ignored', 'keep'), 'keep ignored too');
    const terminal = await page.evaluate(id => window.stingray.createTerminal(id), worktree.id);
    await openRemoval('feature/remove');
    check('preflight lists files and terminals before any removal attempt', (await dialog().innerText()).includes('Close every terminal') && (await dialog().innerText()).includes('1 untracked entries, 1 ignored entries'));
    await dialog().getByLabel('Branch confirmation').fill(worktree.branch); await acknowledge().check();
    check('blockers cannot be overridden by typed confirmation and acknowledgement', await removeButton().isDisabled());
    await page.screenshot({ path: path.join(evidence, 'blocked-compact.png') }); await cancel();
    await page.evaluate(id => window.stingray.closeTerminal(id), terminal.id);
    await rm(path.join(worktree.path, 'local.txt')); await rm(path.join(worktree.path, 'ignored'), { recursive: true });
    git(repo, 'remote', 'add', 'origin', path.join(root, 'unused-local-remote'));
    git(repo, 'update-ref', 'refs/remotes/origin/feature/remove', base);
    git(worktree.path, 'branch', '--set-upstream-to=origin/feature/remove');
    await openRemoval('feature/remove');
    check('clean local tracking is qualified, not claimed remotely verified', (await dialog().innerText()).includes('No commits ahead of') && (await dialog().innerText()).includes('may be stale') && await acknowledge().count() === 0);
    await dialog().getByLabel('Branch confirmation').fill(worktree.branch);
    await writeFile(path.join(worktree.path, 'file.txt'), 'late unpushed commit\n'); const tip = commit(worktree.path);
    await removeButton().click();
    await dialog().getByRole('alert').filter({ hasText: 'review changed' }).waitFor();
    await acknowledge().waitFor();
    check('commit after opening dialog is caught and refreshed before deletion', (await dialog().innerText()).includes('1 unpushed commit') && await removeButton().isDisabled() && await dialog().getByLabel('Branch confirmation').inputValue() === '');
    await dialog().getByLabel('Branch confirmation').fill(worktree.branch); await acknowledge().check();
    await page.screenshot({ path: path.join(evidence, 'unpushed-confirmation.png') });
    await removeButton().click(); await dialog().waitFor({ state: 'hidden' });
    await assert.rejects(access(worktree.path));
    check('confirmed removal deletes only the fixture worktree and preserves its unpushed commit', git(repo, 'rev-parse', 'refs/heads/feature/remove').trim() === tip && git(repo, 'show', `${tip}:file.txt`).trim() === 'late unpushed commit');
    check('background removal preserves current workspace selection', await active().getAttribute('aria-label') === 'main');
    await access(path.join(repo, 'file.txt'));
  }
  check('no renderer exceptions', errors.length === 0);
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ checks, errors, scope: 'Source Electron; real disposable local Git; synthetic Idle metadata; no live GitHub/Docker, provider, production mutation or installed-app GUI claim.' }, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ checks, errors, error: String(error) }, null, 2));
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') });
  throw error;
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
