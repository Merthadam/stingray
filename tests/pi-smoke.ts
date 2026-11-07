// Explicit opt-in no-provider real Pi TUI smoke; not part of npm test.
// PI_TEST_CLI must name an already-installed dist/cli.js. Never installs Pi.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as pty from 'node-pty';
import { ActivityService } from '../electron/activity';
import { ActivityShell, shellQuote } from '../electron/activity-shell';

const cli = process.env.PI_TEST_CLI;
assert.ok(cli && path.isAbsolute(cli), 'Set PI_TEST_CLI to an installed Pi dist/cli.js');
assert.equal(process.platform, 'darwin', 'This smoke requires macOS sandbox-exec');
const evidence = path.resolve(process.env.STINGRAY_TEST_EVIDENCE || 'artifacts/testing/agent-activity/pi-implementation/real-pi');
await mkdir(evidence, { recursive: true });
const root = await mkdtemp('/tmp/stingray-pi-smoke-');
const home = path.join(root,'home'), config = path.join(root,'config'), bin = path.join(root,'bin'), cwd = path.join(root,'work');
await Promise.all([mkdir(home),mkdir(config),mkdir(bin),mkdir(cwd)]);
const eventsFile = path.join(root,'events.jsonl');
await writeFile(eventsFile,'');
const fixture = path.join(root,'fixture.ts');
await writeFile(fixture, `import { appendFileSync } from 'node:fs';
export default function(pi) {
 for (const name of ['session_start','session_shutdown']) pi.on(name, e => { appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ event:name, reason:e.reason })+'\\n'); });
 pi.registerCommand('stingray-wait', { handler: async (_args,ctx) => { await ctx.ui.confirm('Isolated smoke confirmation', 'No provider or tool call.'); } });
 pi.registerCommand('stingray-exit', { handler: async (_args,ctx) => { ctx.shutdown(); } });
}
`);
// No settings, credentials, resource packages or user startup files are inherited.
await writeFile(path.join(bin,'pi'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli!)} --offline --no-session --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes --no-context-files --no-tools --extension ${shellQuote(fixture)} "$@"\n`, { mode: 0o700 });
const snapshots: object[] = [];
const service = new ActivityService(s => { snapshots.push(s); }); await service.start();
const shell = new ActivityShell(); await shell.prepare(service.directory,path.resolve('dist-electron/pi-extension.js'));
const env = { HOME:home, PATH:`${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, TERM:'xterm-256color', LANG:'en_US.UTF-8',
 PI_CODING_AGENT_DIR:config, PI_OFFLINE:'1', PI_SKIP_VERSION_CHECK:'1', PI_TELEMETRY:'0', PI_IMAGE_PROTOCOL:'none' };
await writeFile(path.join(home,'.zshrc'),`export PATH=${shellQuote(env.PATH)}\nPROMPT='isolated % '\n`);
const endpoint = await realpath(service.endpoint);
const sandbox = `(version 1)(allow default)(deny network*)(allow network-outbound (remote unix-socket (path-literal ${JSON.stringify(endpoint)})))`;
const checks: string[] = [];
const check = (name: string, condition = true) => { assert.ok(condition,name); checks.push(name); console.log('PASS',name); };
let child: pty.IPty | undefined, exited = false, output = '';
const sleep = (ms: number) => new Promise(r=>setTimeout(r,ms));
async function until(fn: () => unknown | Promise<unknown>, label: string) { for(let i=0;i<200;i++){if(await fn())return;await sleep(50);}throw new Error('Timed out: '+label); }
const events = async () => (await readFile(eventsFile,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
try {
 child = pty.spawn('/usr/bin/sandbox-exec',['-p',sandbox,'/bin/zsh','-l'],{cwd,env:{...env,...shell.environment('/bin/zsh',env),...service.bind(randomUUID(),randomUUID())},cols:100,rows:30});
 child.onData(data=>{output=(output+data).slice(-256*1024);}); child.onExit(()=>{exited=true;});
 child.write('pi\r');
 await until(()=>service.snapshot().agents[0]?.phase==='idle','real Pi session_start');
 check('typed Pi loads the bundled extension and host VERSION resolves');
 check('new real Pi session is idle without any provider request',service.snapshot().agents[0].reviewRevision===null);
 // Wait for interactive mode to finish opening its editor after session_start.
 await sleep(1000); child.write('/stingray-wait\r');
 await until(()=>service.snapshot().agents[0]?.phase==='waiting','real blocking UI');
 check('real ctx.ui.confirm emits waiting');
 child.write('\x1b'); await until(()=>service.snapshot().agents[0]?.phase==='idle','real UI end');
 check('dismissing real UI restores idle without completion');
 await sleep(200); child.write('/reload\r');
 await until(async()=> (await events()).some(e=>e.event==='session_start'&&e.reason==='reload'),'reload session_start');
 await until(()=>service.snapshot().agents[0]?.connection==='connected'&&service.snapshot().agents[0]?.phase==='idle','reload bridge');
 check('real /reload replaces runtime without duplicate sessions',service.snapshot().agents.length===1);
 await sleep(300); child.write('/new\r');
 await until(async()=> (await events()).some(e=>e.event==='session_start'&&e.reason==='new'),'new session_start');
 check('real /new lifecycle preserves one process identity',service.snapshot().agents.length===1);
 await sleep(300); child.write('/stingray-exit\r');
 await until(()=>service.snapshot().agents[0]?.connection==='disconnected','real shutdown');
 check('real shutdown disconnects without false completion',service.snapshot().agents[0].reviewRevision===null);
 check('no extension load errors',!output.includes('Failed to load extension')&&!output.includes('Extension error'));
 await writeFile(path.join(evidence,'results.json'),JSON.stringify({checks,events:await events(),snapshots,scope:'Real installed Pi 1.5.0 TUI; network denied except private activity socket; empty HOME/config, no trust override, no model prompt/provider call. Turn/retry/final outcome tests are synthetic, not real-provider coverage.'},null,2));
} catch(error) {
 await writeFile(path.join(evidence,'failure.json'),JSON.stringify({checks,error:String(error),events:await events(),snapshots},null,2));
 await writeFile(path.join(evidence,'fixture-terminal.txt'),output);
 throw error;
} finally {
 if(child&&!exited) { child.write('exit\r'); await sleep(200); if(!exited) child.kill(); }
 await service.close(); await rm(root,{recursive:true,force:true});
}
