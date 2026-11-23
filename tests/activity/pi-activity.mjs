// Native Electron + PTY + production socket/observer. Agent events are synthetic;
// tests/pi-smoke.ts separately loads the extension in the real installed Pi CLI.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const executablePath = process.env.STINGRAY_TEST_APP ? path.resolve(process.env.STINGRAY_TEST_APP) : undefined;
const root = await mkdtemp('/tmp/stingray-pi-ui-');
const home = path.join(root, 'home'), repo = path.join(root, 'activity-fixture'), bin = path.join(root, 'bin');
const evidence = path.resolve(process.env.STINGRAY_TEST_EVIDENCE || 'artifacts/testing/agent-activity/pi-implementation/native');
await Promise.all([mkdir(home), mkdir(repo), mkdir(bin), mkdir(evidence, { recursive: true })]);
const env = { HOME: home, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, ZDOTDIR: home,
  STINGRAY_DATA_DIR: path.join(root, 'data'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'en_US.UTF-8' };
await writeFile(path.join(home, '.zshrc'), `export PATH=${JSON.stringify(env.PATH)}\nPROMPT='fixture % '\n`);
for (const cmd of ['gh', 'docker']) await writeFile(path.join(bin, cmd), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const git = (...args) => execFileSync('/usr/bin/git', ['-c','core.hooksPath=/dev/null',...args], { cwd: repo, env, stdio: 'pipe' });
git('init','-b','main'); await writeFile(path.join(repo,'README.md'),'# Isolated fixture\n'); git('add','.');
git('-c','user.name=Test','-c','user.email=test@invalid','-c','commit.gpgsign=false','commit','-m','fixture');
const fixture = `
import { registerPiObserver } from ${JSON.stringify(path.resolve('agents/pi-observer.ts'))};
import { createInterface } from 'node:readline';
const handlers = new Map();
const emit = async (name, event = {}) => handlers.get(name)?.(event, { isIdle: () => true });
registerPiObserver({ on(name, fn) { handlers.set(name, fn); } }, '1.5.0');
await emit('session_start'); console.log('FIXTURE_READY');
for await (const cmd of createInterface({ input: process.stdin })) {
 if (cmd === 'work') await emit('agent_start');
 if (cmd === 'wait') await emit('ui_prompt_start');
 if (cmd === 'resume') await emit('ui_prompt_end');
 if (cmd === 'end') await emit('agent_end');
 if (cmd === 'done') { await emit('agent_before_settle', { outcome: 'completed' }); await emit('agent_settled', { aborted: false }); }
 if (cmd === 'fail') { await emit('agent_before_settle', { outcome: 'error' }); await emit('agent_settled', { aborted: false }); }
 if (cmd === 'abort') await emit('agent_settled', { aborted: true });
 if (cmd === 'scroll') for (let i=0;i<250;i++) console.log('Fixture line '+i);
 if (cmd === 'quit') { await emit('session_shutdown'); process.exit(0); }
 console.log('FIXTURE_COMMAND_DONE');
}
`;
await build({ stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: path.join(root,'fixture.mjs') });
await writeFile(path.join(bin,'pi'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root,'fixture.mjs'))} "$@"\n`, { mode: 0o700 });
const checks = [], errors = [];
const check = (label, value = true) => { assert.ok(value, label); checks.push(label); console.log('PASS',label); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let app, page;
try {
 app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env, timeout: 30000 });
 page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
 await page.getByRole('button',{name:'Add project',exact:true}).click();
 await page.getByLabel('Repository path',{exact:true}).fill(repo);
 await page.getByRole('button',{name:'Open repository',exact:true}).click();
 await page.getByRole('button',{name:'Open project activity-fixture',exact:true}).click();
 await page.getByRole('button',{name:'Open terminal',exact:true}).click();
 const terminal = (await page.evaluate(() => window.stingray.terminals()))[0];
 const send = (text, id = terminal.id) => page.evaluate(({ id, text }) => window.stingray.writeTerminal(id, text+'\r'), {id,text});
 const agents = () => page.evaluate(async () => (await window.stingray.activity()).agents);
 const phase = label => page.locator('.workspace-activity').filter({ hasText: label }).waitFor();
 check('shell alone never fabricates Idle', await page.locator('.workspace-activity').count() === 0);
 check('renderer terminal snapshot contains no capability', !JSON.stringify(terminal).includes('STINGRAY_'));
 await page.locator('.xterm-helper-textarea').click(); await page.keyboard.type('pi'); await page.keyboard.press('Enter');
 await phase('Idle'); check('typed Pi attaches in a new real PTY');
 await send('work'); await phase('Working');
 await send('wait'); await phase('Waiting for you'); check('blocking UI span reports waiting');
 await send('resume'); await phase('Working'); await send('end'); await sleep(100);
 check('agent_end cannot create review', (await agents())[0].reviewRevision === null && (await agents())[0].phase === 'working');
 await send('done'); await phase('Needs review'); await sleep(150);
 check('a completion snapshot does not auto-acknowledge a focused terminal', (await agents())[0].reviewRevision !== null);
 await page.screenshot({path:path.join(evidence,'needs-review.png')});
 await page.locator('.terminal-surface:visible').click(); await phase('Idle'); check('visible rendered bottom interaction acknowledges completion');
 await page.getByRole('tab',{name:/^Repo Map/}).click(); await send('work'); await send('done'); await phase('Needs review');
 const review = (await agents())[0];
 await page.evaluate(a => window.stingray.acknowledgeActivity(a.id,a.terminalId,a.reviewRevision), review);
 check('main rejects acknowledgement from a hidden terminal view', (await agents())[0].reviewRevision === review.reviewRevision);
 await send('work'); await send('done');
 await page.waitForFunction(old => window.stingray.activity().then(s=>s.agents[0].reviewRevision !== old), review.reviewRevision);
 await page.evaluate(a => window.stingray.acknowledgeActivity(a.id,a.terminalId,a.reviewRevision), review);
 check('late completion survives an old acknowledgement', (await agents())[0].reviewRevision !== review.reviewRevision);
 await page.getByRole('tab',{name:'Workspace',exact:true}).click(); await phase('Idle'); check('viewing the terminal at bottom clears only observed completion');
 await send('scroll'); await sleep(300);
 await page.locator('.terminal-surface:visible').hover(); await page.mouse.wheel(0,-5000); await sleep(200);
 await send('work'); await send('done'); await phase('Needs review');
 await page.locator('.terminal-surface:visible').click(); await sleep(100);
 check('scrollback view cannot acknowledge unseen output at bottom', (await agents())[0].reviewRevision !== null);
 for (let i=0;i<5;i++) { await page.mouse.wheel(0,10000); await sleep(100); }
 await page.locator('.terminal-surface:visible').click(); await phase('Idle');
 await send('work'); await send('fail'); await phase('Failed'); check('failure is not successful completion');
 await send('work'); await send('abort'); await phase('Interrupted'); check('abort is not successful completion');
 await page.getByRole('button',{name:'New terminal',exact:true}).first().click();
 const second = (await page.evaluate(()=>window.stingray.terminals()))[1];
 await send('pi',second.id); await page.waitForFunction(()=>window.stingray.activity().then(s=>s.agents.length===2));
 await page.getByRole('button',{name:'Split terminals',exact:true}).click();
 await send('work'); await send('done'); await phase('Needs review');
 await page.locator('.terminal-surface:visible').nth(1).click(); await sleep(100);
 check('split-pane interaction cannot clear the other pane review', (await agents()).find(a=>a.terminalId===terminal.id).reviewRevision !== null);
 await page.locator('.terminal-surface:visible').nth(0).click(); await phase('Idle');
 await page.getByRole('button',{name:'Split terminals',exact:true}).click();
 await send('work'); await send('done'); await phase('Needs review');
 await page.locator('.terminal-surface:visible').click(); await sleep(100);
 check('another terminal cannot acknowledge hidden session', (await agents()).find(a=>a.terminalId===terminal.id).reviewRevision !== null);
 await app.evaluate(({ BrowserWindow })=>BrowserWindow.getAllWindows()[0].hide());
 await page.reload(); await phase('Needs review');
 check('renderer reload while hidden retains review and both sessions', (await agents()).length===2 && (await agents()).some(a=>a.reviewRevision!==null));
 await app.evaluate(({ BrowserWindow })=>{ const w=BrowserWindow.getAllWindows()[0];w.show();w.focus(); });
 await page.getByRole('button',{name:terminal.title,exact:true}).click();
 await page.locator('.terminal-surface:visible').click(); await phase('Idle');
 await page.getByRole('button',{name:'New worktree',exact:true}).click();
 await page.getByLabel('New branch name',{exact:true}).fill('feature/agent');
 await page.getByRole('button',{name:'Create worktree',exact:true}).click();
 await page.getByRole('heading',{name:'feature/agent',exact:true}).waitFor();
 await send('work'); await phase('Working'); await send('done'); await phase('Needs review');
 check('background workspace completion is retained', (await agents()).find(a=>a.terminalId===terminal.id).reviewRevision !== null);
 await page.getByRole('button',{name:'main',exact:true}).click(); await phase('Idle');
 check('selecting background workspace acknowledges its visible bottom terminal');
 await app.evaluate(({ BrowserWindow })=>BrowserWindow.getAllWindows()[0].setSize(760,540));
 await page.screenshot({path:path.join(evidence,'compact.png')});
 check('compact activity fits sidebar', await page.locator('.workspace-activity').evaluate(el=> { const r=el.getBoundingClientRect(), p=el.closest('.workspace-entry').getBoundingClientRect();return r.left>=p.left&&r.right<=p.right; }));
 await send('quit'); await phase('Disconnected'); check('process shutdown is disconnected, not idle or completion');
 await page.evaluate(async()=>{ for(const t of await window.stingray.terminals()) await window.stingray.closeTerminal(t.id); });
 check('closing terminals revokes and removes their activity', (await agents()).length===0);
 check('no renderer errors', errors.length===0);
 await writeFile(path.join(evidence,'results.json'),JSON.stringify({checks,errors,executablePath:executablePath || null,scope:`${executablePath ? 'Packaged' : 'Source'} Electron + real PTY/socket; synthetic Pi event fixture, not provider lifecycle evidence.`},null,2));
} catch(error) {
 await writeFile(path.join(evidence,'failure.json'),JSON.stringify({checks,errors,error:String(error)},null,2));
 if(page) await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
 throw error;
} finally {
 if(app) { await page?.evaluate(async()=>{ for(const t of await window.stingray.terminals()) await window.stingray.closeTerminal(t.id); }).catch(()=>{}); await app.close().catch(()=>{}); }
 await rm(root,{recursive:true,force:true});
}
