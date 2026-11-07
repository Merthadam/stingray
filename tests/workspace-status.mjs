// Real Electron, Git, PTY-launched HTTP servers and process scanning; Docker ONLY is a fixture.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const executablePath = process.env.STINGRAY_TEST_APP ? path.resolve(process.env.STINGRAY_TEST_APP) : undefined;
const root = await mkdtemp(path.join(tmpdir(), 'stingray-ports-'));
const repo = path.join(root, 'fixture-project');
const bin = path.join(root, 'bin');
const fixturePath = path.join(root, 'containers.json');
const evidence = path.resolve(process.env.STINGRAY_TEST_EVIDENCE || 'artifacts/testing/compact-workspace-ports');
await mkdir(repo); await mkdir(bin); await mkdir(evidence, { recursive: true });
await mkdir(path.join(root, 'shell')); await writeFile(path.join(root, 'shell', '.zshrc'), "PROMPT='fixture % '\n");
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
git('init', '-b', 'main'); await writeFile(path.join(repo, 'README.md'), '# Fixture\n'); git('add', '.');
git('-c', 'user.name=Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
// An unrelated host server must never be attributed to a Stingray terminal.
const external = createServer((_req, res) => res.end('unrelated'));
await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
const unrelatedPort = external.address().port;
const dockerPort = unrelatedPort;
const rows = [{ id: 'a'.repeat(64), name: '/fixture-web', image: 'node:24', state: 'running', health: 'healthy', workingDir: repo, mounts: [], ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: String(dockerPort) }] } }];
await writeFile(fixturePath, JSON.stringify({ delay: 1200, rows: [] }));
const docker = path.join(bin, 'docker');
await writeFile(docker, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); const value = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, 'utf8')); setTimeout(() => { if(value.error) process.exit(1); const rows=value.rows; if (args[0] === 'context') console.log('unix:///fixture/docker.sock'); else if (args.includes('ls')) console.log(rows.map(r => r.id).join('\\n')); else if (args.includes('inspect')) console.log(rows.map(r => JSON.stringify(r)).join('\\n')); else process.exit(2); }, value.delay||0);\n`);
await chmod(docker, 0o755);
const serverScript = path.join(root, 'server.cjs');
await writeFile(serverScript, `const http=require('node:http'),fs=require('node:fs'); const server=http.createServer((req,res)=>{const respond=()=>{res.setHeader('Content-Type','text/html');res.end('<h1>Real PTY server '+process.argv[3]+'</h1>');}; if(req.url==='/slow')setTimeout(respond,10000);else respond();});server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(process.argv[2],String(server.address().port));console.log('LISTENING '+server.address().port);});`);
const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ZDOTDIR: path.join(root, 'shell'), STINGRAY_DATA_DIR: path.join(root, 'data') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'STINGRAY_DEV_URL', 'DOCKER_CONTEXT', 'DOCKER_HOST']) delete env[key];
let app, page;
const errors = [], checks = [], createdTerminals = [];
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
const dialog = name => page.getByRole('dialog', { name: `Ports for ${name}`, exact: true });
async function openDetails(name) {
  const chip = page.locator('.workspace-entry').filter({ has: page.locator('.workspace-link', { hasText: name }) }).locator('.ports-chip');
  // Move away first so hover and click cannot accidentally toggle the same opening.
  await page.mouse.move(700, 70);
  if (!(await dialog(name).isVisible())) { await chip.focus(); await chip.press('Enter'); }
  await dialog(name).waitFor();
  return dialog(name);
}
async function startServer(workspaceId, label) {
  const info = await page.evaluate(id => window.stingray.createTerminal(id), workspaceId);
  createdTerminals.push(info.id);
  const portFile = path.join(root, label + '.port');
  const quote = v => `'${v.replaceAll("'", "'\\''")}'`;
  const serverCommand = [process.execPath, serverScript, portFile, label].map(quote).join(' ');
  let command = serverCommand + '\r';
  if (label === 'second') {
    const fixturePackage = path.join(root, 'npm-fixture'); await mkdir(fixturePackage);
    await writeFile(path.join(fixturePackage, 'package.json'), JSON.stringify({private:true,scripts:{dev:serverCommand}}));
    command = `${quote(path.join(path.dirname(process.execPath),'npm'))} --prefix ${quote(fixturePackage)} run dev\r`;
  }
  await page.evaluate(({id, command}) => window.stingray.writeTerminal(id, command), {id: info.id, command});
  for (let i=0;i<100;i++) { try { const port = Number(await readFile(portFile,'utf8')); if(port) return { info, port }; } catch {} await new Promise(r=>setTimeout(r,100)); }
  throw new Error('PTY server did not start');
}
async function waitPreview(expected) {
  await page.waitForFunction(expected => { try { return document.querySelector('webview')?.getURL() === expected && !document.querySelector('.preview-loading'); } catch { return false; } }, expected);
}
try {
  app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env, timeout: 30000 });
  app.process().on('exit', (code, signal) => console.log('Test Electron exit:', {code,signal}));
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByLabel('Repository path', { exact: true }).fill(repo);
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('button', { name: 'Open project fixture-project', exact: true }).click();
  check('initial discovery does not show an empty loading badge', await page.locator('.ports-chip').count() === 0);
  await page.evaluate(() => window.stingray.containers());
  check('empty discovery has no badge or popover', await page.locator('.ports-chip,.ports-popover').count() === 0);
  await page.screenshot({path:path.join(evidence,'no-ports.png')});
  let popover;
  await page.getByRole('button', { name: 'main: 0 lines added, 0 lines deleted', exact: true }).waitFor();
  check('Git details and ports live in compact sidebar cards; large cards are removed', await page.locator('.workspace-overview,.container-card').count() === 0);
  await writeFile(path.join(repo, 'README.md'), '# Edited\n'); await writeFile(path.join(repo,'new.txt'),'new');
  const gitChip = page.getByRole('button',{name:'main: 1 lines added, 1 lines deleted',exact:true});
  await gitChip.waitFor();
  check('Git line counts refresh automatically with honest exclusions in the tooltip', (await gitChip.getAttribute('title')).includes('Excludes untracked'));
  await gitChip.click(); await page.locator('.change').filter({hasText:'new.txt'}).waitFor(); check('Git line counts open Changes including untracked files');
  const state = await page.evaluate(() => window.stingray.state());
  const main = state.workspaces[0];
  const next = await page.evaluate(id => window.stingray.createWorkspace(id, 'other'), main.repoId);
  const other = next.workspaces.find(w => w.branch === 'other');
  const first = await startServer(main.id, 'first');
  const second = await startServer(other.id, 'second');
  // Reload restores state and terminal registry; both background workspaces must be scanned.
  await page.reload();
  await page.getByRole('button',{name:'main: 1 active port',exact:true}).waitFor();
  await page.getByRole('button',{name:'other: 1 active port',exact:true}).waitFor();
  check('real PTY servers, including npm run dev descendants, are discovered independently in two workspaces');
  const listeners = await page.evaluate(() => window.stingray.ports());
  check('unrelated host listeners are excluded', !listeners.some(p => p.port === unrelatedPort));
  popover = await openDetails('other');
  check('popover is scoped to its workspace', (await popover.innerText()).includes(':'+second.port) && !(await popover.innerText()).includes(':'+first.port));
  await popover.getByRole('button',{name:new RegExp(':'+second.port)}).click();
  await waitPreview(`http://127.0.0.1:${second.port}/`);
  check('opening a background workspace port selects its workspace and loads the real preview', await page.locator('.workspace-link.selected').innerText() === 'other');
  await page.getByLabel('Preview URL').fill(`http://127.0.0.1:${second.port}/slow`);
  await page.getByRole('button',{name:'Load preview',exact:true}).click();
  await page.getByText('Loading preview…',{exact:true}).waitFor();
  await page.getByText('Still waiting for the server… Check its terminal output.',{exact:true}).waitFor();
  check('slow real HTTP response shows loading and then waiting');
  await waitPreview(`http://127.0.0.1:${second.port}/slow`);
  check('waiting clears when the server finishes loading');
  await writeFile(fixturePath, JSON.stringify({rows}));
  await page.getByRole('button',{name:'main: 2 active ports',exact:true}).waitFor();
  check('workspace-associated Docker ports join terminal ports in the badge');
  popover = await openDetails('main');
  await page.screenshot({path:path.join(evidence,'ports-wide.png')});
  // Keyboard opening and dismissal, no nested buttons, no navigation on badge click.
  await page.keyboard.press('Escape');
  const chip = page.getByRole('button',{name:'main: 2 active ports',exact:true});
  await chip.focus(); await chip.press('ArrowDown'); await dialog('main').waitFor();
  check('keyboard opens details without changing workspace', await page.locator('.workspace-link.selected').innerText() === 'other');
  await page.keyboard.press('Escape');
  check('Escape restores focus to the badge', await chip.evaluate(el => el === document.activeElement));
  check('sidebar has no nested buttons', await page.locator('.workspace-entry button button').count() === 0);
  // Move away first: Escape can close a popover while the pointer is still over its trigger.
  await page.locator('.workspace-heading h1').hover();
  await chip.hover(); await dialog('main').waitFor();
  await page.locator('.workspace-heading h1').click(); await dialog('main').waitFor({state:'hidden'});
  check('hover opens details and outside click dismisses them');
  await page.getByRole('button',{name:'Close preview',exact:true}).click();
  popover = await openDetails('main');
  await popover.getByRole('button',{name:new RegExp(':'+first.port)}).click();
  await waitPreview(`http://127.0.0.1:${first.port}/`);
  check('quick-open reveals closed preview and persists correct workspace URL', (await page.evaluate(()=>window.stingray.state())).workspaces.find(w=>w.id===main.id).previewUrl === `http://127.0.0.1:${first.port}`);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(760,540));
  await page.waitForFunction(()=>innerWidth===760);
  popover = await openDetails('main');
  check('compact popover stays inside the viewport', await popover.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
  check('compact layout has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(evidence,'ports-compact.png')});
  await popover.getByRole('button',{name:new RegExp(':'+first.port)}).click();
  check('compact quick-open reveals the preview',await page.evaluate(()=>{const p=document.querySelector('.browser-pane').getBoundingClientRect(),c=document.querySelector('.workspace-content').getBoundingClientRect();return p.top<c.bottom&&p.bottom>c.top;}));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,940));
  await writeFile(fixturePath, JSON.stringify({error:true, rows:[]}));
  popover=await openDetails('main');
  await popover.getByText(/Docker discovery: Docker is unavailable/).waitFor();
  check('partial discovery failure is explicit; healthy terminal ports remain usable',await popover.locator('.port-row').count()===1);
  await page.screenshot({path:path.join(evidence,'partial-error.png')});
  await writeFile(fixturePath,JSON.stringify({rows:[]}));
  await popover.getByRole('button',{name:'Retry discovery',exact:true}).click();
  await popover.getByText(/Docker discovery:/).waitFor({state:'hidden'});
  check('discovery retry recovers without restarting the app');
  await page.keyboard.press('Escape');
  await openDetails('main');
  await page.evaluate(id=>window.stingray.writeTerminal(id,'\u0003'),first.info.id);
  // Keep details open as the last port disappears: neither badge nor portal may linger.
  await page.locator('.workspace-entry').filter({ has: page.getByRole('button', { name: 'main', exact: true }) }).locator('.ports-chip').waitFor({state:'hidden'});
  await dialog('main').waitFor({state:'hidden'});
  check('a stopped real server removes its badge and open popover automatically');
  await page.getByRole('button',{name:'Reload preview',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Could not load this page'}).waitFor();
  check('failed preview clears loading and provides retry guidance',await page.locator('.preview-loading').count()===0);
  await page.evaluate(id=>window.stingray.closeTerminal(id),second.info.id);
  await page.locator('.ports-chip,.ports-popover').waitFor({state:'hidden'});
  check('closing the last terminal removes its port badge and details without cross-workspace leakage');
  await writeFile(fixturePath, JSON.stringify({error:true, rows:[]}));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(1500);
  check('failed discovery with no ports does not show Unavailable or an empty badge', await page.locator('.ports-chip,.ports-popover').count() === 0);
  await rm(path.join(repo,'.git'),{recursive:true});
  await page.getByRole('tab',{name:/Changes/}).click();
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('button',{name:'main: Line counts unavailable',exact:true}).waitFor();
  check('Git errors are not displayed as a clean working tree');
  check('no renderer exceptions', errors.length===0);
  await writeFile(path.join(evidence,'results.json'),JSON.stringify({checks,errors,executablePath:executablePath||null,scope:`${executablePath ? 'Packaged macOS app' : 'Source Electron build'}; real Git, real PTY HTTP servers, macOS ps/lsof, isolated app data; Docker fixture only. No Superset runtime equivalence claim.`},null,2));
} catch(error) {
  console.error('Workspace-status failure:', error);
  if(page && !page.isClosed()) {console.error((await page.locator('body').innerText()).slice(0,6000));await page.screenshot({path:path.join(evidence,'failure.png')});}
  throw error;
} finally {
  if(page) for(const id of createdTerminals) await page.evaluate(id=>window.stingray.closeTerminal(id),id).catch(()=>{});
  if(app) await app.close(); external.close(); await rm(root,{recursive:true,force:true});
}
