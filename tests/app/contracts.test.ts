import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineContract, returns, event, channel, rendererName } from '../../shared/contracts/define';

test('defineContract keeps feature, routes and events; channel and renderer names', () => {
  const c = defineContract('demo-feature', {
    invoke: { load: [z.tuple([z.string()]), returns<number>()], settings: [z.tuple([]), returns<boolean>(), { renderer: 'demoSettings' }] },
    events: { onThing: event<string>() },
  });
  assert.equal(c.feature, 'demo-feature');
  assert.deepEqual(Object.keys(c.invoke), ['load', 'settings']);
  assert.deepEqual(Object.keys(c.events), ['onThing']);
  assert.equal(channel(c.feature, 'load'), 'demo-feature.load');
  assert.equal(rendererName('load', c.invoke.load), 'load');
  assert.equal(rendererName('settings', c.invoke.settings), 'demoSettings');
});

import { contracts } from '../../shared/contracts';

test('every contract route is a ZodTuple; channels are well-formed and unique; flat names are unique', () => {
  const channels = new Set<string>(), flat = new Set<string>(['mode']);
  let routes = 0;
  for (const c of contracts) {
    for (const [member, entry] of Object.entries(c.invoke)) {
      routes++;
      assert.ok(entry[0] instanceof z.ZodTuple, `${c.feature}.${member} schema`);
      const name = channel(c.feature, member);
      assert.match(name, /^[a-z-]+\.[a-zA-Z]+$/);
      assert.ok(!channels.has(name), `duplicate channel ${name}`); channels.add(name);
      const renderer = rendererName(member, entry);
      assert.ok(!flat.has(renderer), `duplicate flat name ${renderer}`); flat.add(renderer);
    }
    for (const member of Object.keys(c.events)) {
      const name = channel(c.feature, member);
      assert.match(name, /^[a-z-]+\.on[A-Z][a-zA-Z]+$/);
      assert.ok(!channels.has(name)); channels.add(name);
      assert.ok(!flat.has(member)); flat.add(member);
    }
  }
  assert.equal(routes, 46, 'every route of main.ts except the removed db-schema');
});

import { handle, registerContract, type IpcContext } from '../../electron/app/ipc';

function fakeIpc(url = 'file:///app/dist/index.html') {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  const mainFrame = { url };
  const webContents = { mainFrame };
  const logged: string[] = [];
  const ctx: IpcContext = {
    ipcMain: { handle: (name: string, fn: any) => { handlers.set(name, fn); } } as IpcContext['ipcMain'],
    window: () => ({ webContents }) as any,
    rendererUrl: url,
    log: message => { logged.push(message); },
  };
  return { ctx, handlers, trusted: { sender: webContents, senderFrame: mainFrame }, logged };
}

test('handle(): untrusted sender or subframe throws and never calls the action; bad args throw a ZodError', async () => {
  const { ctx, handlers, trusted } = fakeIpc();
  let calls = 0;
  handle(ctx, 'x.y', z.tuple([z.string()]), () => { calls++; });
  const h = handlers.get('x.y')!;
  for (const event of [{ sender: {}, senderFrame: trusted.senderFrame }, { sender: trusted.sender, senderFrame: {} },
    { sender: trusted.sender, senderFrame: { url: 'https://evil.example/' } }]) {
    await assert.rejects(h(event, 'a'), /Untrusted IPC sender\./);
  }
  await assert.rejects(h(trusted, 42), (e: Error) => e.name === 'ZodError');
  assert.equal(calls, 0);
  assert.deepEqual(await h(trusted, 'a'), { ok: true, value: undefined });
  assert.equal(calls, 1);
});

test('failure isolation rule 1: a throwing handler returns { ok: false } and is logged; the other still answers', async () => {
  const { ctx, handlers, trusted, logged } = fakeIpc();
  const c = defineContract('iso', { invoke: { bad: [z.tuple([]), returns<number>()], good: [z.tuple([]), returns<number>()] }, events: {} });
  registerContract(ctx, c, { bad: () => { throw new Error('boom'); }, good: async () => 7 });
  assert.deepEqual(await handlers.get('iso.bad')!(trusted), { ok: false, error: { message: 'boom' } });
  assert.deepEqual(await handlers.get('iso.good')!(trusted), { ok: true, value: 7 });
  assert.ok(logged.some(m => m.includes('iso.bad')));
});

import { buildPreloadApi } from '../../electron/adapters/driving/ipc/build-api';

test('buildPreloadApi: one function per route/event, right channel, trailing undefined dropped, envelope unwrapped', async () => {
  const invoked: unknown[][] = [];
  const listeners = new Map<string, Function>();
  const replies: Record<string, unknown> = { 'views.view': { ok: true, value: 'v' }, 'git.gitState': { ok: false, error: { message: 'Workspace not found.' } } };
  const api = buildPreloadApi([...contracts], {
    invoke: async (name: string, ...args: unknown[]) => { invoked.push([name, ...args]); return replies[name] ?? { ok: true, value: null }; },
    on: (name: string, fn: Function) => { listeners.set(name, fn); return undefined as any; },
    removeListener: (name: string) => { listeners.delete(name); return undefined as any; },
  } as any) as Record<string, any>;
  const routes = contracts.reduce((n, c) => n + Object.keys(c.invoke).length + Object.keys(c.events).length, 0);
  assert.equal(Object.keys(api).length, routes + 1); // + mode
  assert.equal(api.mode, 'desktop');
  assert.equal(await api.view('id', 'database', undefined), 'v');
  assert.deepEqual(invoked.at(-1), ['views.view', 'id', 'database']);
  await api.codegraphSettings();
  assert.deepEqual(invoked.at(-1), ['stinggraph.settings']);
  await assert.rejects(api.gitState('id'), /^Error: Workspace not found\.$/);
  const got: unknown[] = [];
  const off = api.onTerminal((p: unknown) => got.push(p));
  listeners.get('terminals.onTerminal')!({}, { id: 't' });
  assert.deepEqual(got, [{ id: 't' }]);
  off();
  assert.equal(listeners.has('terminals.onTerminal'), false);
});

test('demoAPI has exactly the keys of DesktopAPI', async () => {
  const { demoAPI } = await import('../../src/app/demo');
  const expected = new Set(['mode']);
  for (const c of contracts) {
    for (const [member, entry] of Object.entries(c.invoke)) expected.add(rendererName(member, entry));
    for (const member of Object.keys(c.events)) expected.add(member);
  }
  assert.deepEqual(Object.keys(demoAPI).sort(), [...expected].sort());
});

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { BridgeMissingError, pickApi } from '../../src/app/pick-api';
import { DemoBadge } from '../../src/app/DemoBadge';

test('pickApi: plain browser always demo; ?demo only in dev Electron; otherwise bridge or BridgeMissingError', async () => {
  const bridge = { mode: 'desktop' } as any, demo = { mode: 'demo' } as any;
  const pick = (o: { electron: boolean; dev: boolean; search: string; bridge?: unknown }) =>
    pickApi({ bridge: o.bridge as any, userAgent: o.electron ? 'Mozilla/5.0 Electron/45.2.3' : 'Mozilla/5.0 Chrome/140', search: o.search, dev: o.dev, loadDemo: async () => demo });
  assert.equal(await pick({ electron: false, dev: false, search: '' }), demo);
  assert.equal(await pick({ electron: false, dev: false, search: '?demo' }), demo);
  assert.equal(await pick({ electron: true, dev: true, search: '?demo', bridge }), demo);
  assert.equal(await pick({ electron: true, dev: true, search: '?demo' }), demo);
  assert.equal(await pick({ electron: true, dev: false, search: '?demo', bridge }), bridge);
  assert.throws(() => pick({ electron: true, dev: false, search: '?demo' }), BridgeMissingError);
  assert.equal(await pick({ electron: true, dev: false, search: '', bridge }), bridge);
  assert.throws(() => pick({ electron: true, dev: true, search: '' }), BridgeMissingError);
});

test('DemoBadge renders DEMO only in demo mode', () => {
  const demo = renderToStaticMarkup(createElement(DemoBadge, { mode: 'demo' }));
  assert.match(demo, /DEMO/);
  assert.match(demo, /role="status"/);
  assert.match(demo, /aria-label="Demo data"/);
  assert.equal(renderToStaticMarkup(createElement(DemoBadge, { mode: 'desktop' })), '');
});

import { existsSync, readFileSync } from 'node:fs';
test('built preload bundles zod and the contracts: no require() other than electron', { skip: !existsSync('dist-electron/preload.cjs') }, () => {
  const requires = [...readFileSync('dist-electron/preload.cjs', 'utf8').matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(requires)], ['electron']);
});
