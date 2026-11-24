import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalLinkOpener } from '../../electron/core/terminals';
import { fakeLinkTargets } from '../fakes/terminals';

const terminal = { id: 't1', workspaceId: 'w1', title: 'Terminal 1', exited: false, sequence: 0 };
function opener(confirm: () => Promise<boolean>) {
  const opened: string[] = [];
  const o = new TerminalLinkOpener({ terminals: { list: () => [terminal] }, workspacePath: async () => '/ws', confirm,
    actions: { openExternal: async u => { opened.push(u); }, openPath: async p => { opened.push(p); return ''; }, showItemInFolder: p => { opened.push(p); } },
    targets: fakeLinkTargets({}) });
  return { o, opened };
}

test('a second link during a pending confirmation is refused; unknown terminals are refused', async () => {
  let answer!: (v: boolean) => void;
  const { o, opened } = opener(() => new Promise<boolean>(r => { answer = r; }));
  const first = o.open('t1', 'https://example.com/');
  await new Promise(r => setTimeout(r, 0));
  await assert.rejects(o.open('t1', 'https://example.com/'), /^Error: Finish the current link confirmation first\.$/);
  answer(true); await first;
  assert.deepEqual(opened, ['https://example.com/']);
  await assert.rejects(o.open('nope', 'https://example.com/'), /^Error: Terminal not found\.$/);
});

test('the lock is released after the confirmation rejects', async () => {
  let calls = 0;
  const { o } = opener(async () => { if (++calls === 1) throw new Error('dialog failed'); return false; });
  await assert.rejects(o.open('t1', 'https://example.com/'), /dialog failed/);
  await o.open('t1', 'https://example.com/');
});
