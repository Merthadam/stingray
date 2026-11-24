import test from 'node:test';
import assert from 'node:assert/strict';
import type { SequenceData, SequenceMessage, SequenceParticipant } from '../../shared/contracts/views';
import { SEQ, collapseParticipants, collapsible, sequenceLayout, wrapLines } from '../../src/features/views/views-ui/sequence-layout';
import { sequenceEvents } from '../../shared/views/sequence-events';
import { formatText, type TextDiagramInput } from '../../shared/views/views-text';

const p = (id: string, label: string, column: number, kind: SequenceParticipant['kind'] = 'participant'): SequenceParticipant =>
  ({ id, label, kind, subtitle: null, column, source: null, symbol: null });
let row = 0;
const m = (from: string, to: string, kind: SequenceMessage['kind'], label: string, level: number, extra: Partial<SequenceMessage> = {}): SequenceMessage =>
  ({ id: `m${row++}`, from, to, kind, label, detail: null, level, certain: true, link: null, source: null, symbol: null, ...extra });

// The spec's login example (docs/sequence-view-spec.md, "CLI text").
function login(): SequenceData {
  row = 0;
  return {
    participants: [p('actor', 'User', 0, 'actor'), p('web', 'web', 1), p('auth', 'auth', 2), p('cog', 'Cognito', 3, 'external')],
    messages: [
      m('actor', 'web', 'call', 'click Sign in', 0), m('web', 'web', 'self', 'submit', 0), m('web', 'auth', 'http', 'POST /auth/login', 0, { link: 'http' }),
      m('auth', 'auth', 'link', 'get_current_user', 1, { link: 'auth' }), m('auth', 'cog', 'call', 'initiate auth', 1, { certain: false }),
      m('cog', 'auth', 'return', 'tokens', 1), m('auth', 'web', 'return', 'response', 0),
    ],
    fragments: [{ id: 'f0', kind: 'alt', label: 'user active?', first: 4, last: 5, branches: [{ label: 'else', first: 6 }], parent: null, source: null }],
    notes: [{ id: 'n0', participant: 'auth', after: 5, text: 'error: HTTPException', kind: 'error', source: null, fragment: 'f0', arm: 1 }],
  };
}

test('formatText sequence (CLI and Views tab text) prints the spec format: arrows, call-level indent, a notes-only else arm', () => {
  const result: TextDiagramInput = { kind: 'sequence', groups: [], nodes: [], edges: [], truncated: false, sequence: login() };
  assert.equal(formatText(result), [
    'sequence: 4 participants, 7 messages',
    'participants: User (actor), web, auth, Cognito (external)',
    'User -> web: click Sign in',
    'web -> web: submit',
    'web -> auth: POST /auth/login',
    '  auth -> auth: get_current_user  [link auth]',
    '  alt user active?',
    '    auth -> Cognito: initiate auth  (uncertain)',
    '    Cognito --> auth: tokens',
    '  else',
    '    note auth: error: HTTPException',
    '  end',
    'auth --> web: response',
  ].join('\n'));
  const twice = { ...login(), participants: [p('a', 'api', 0), p('b', 'api', 1)], messages: [], fragments: [], notes: [] };
  assert.equal(formatText({ ...result, sequence: twice }).split('\n')[1], 'participants: api (a), api (b)');
});

test('sequenceEvents nests fragments outer first, branches before their row, closes inner first', () => {
  row = 0;
  const data: SequenceData = { participants: [p('a', 'a', 0), p('b', 'b', 1)],
    messages: [m('a', 'b', 'call', 'one', 0), m('a', 'b', 'call', 'two', 0), m('a', 'b', 'call', 'three', 0)],
    fragments: [{ id: 'inner', kind: 'loop', label: 'x', first: 0, last: 0, branches: [], parent: 'outer', source: null },
      { id: 'outer', kind: 'try', label: 'try', first: 0, last: 2, branches: [{ label: 'except E', first: 2 }], parent: null, source: null }],
    notes: [{ id: 'n', participant: 'b', after: -1, text: 'start', kind: 'info', source: null }] };
  const trace = sequenceEvents(data).map(e => e.type === 'message' ? `${e.message.label}@${e.depth}` : e.type === 'note' ? 'note'
    : `${e.type}:${e.type === 'branch' ? e.label : e.fragment.id}@${e.depth}`);
  assert.deepEqual(trace, ['note', 'open:outer@0', 'open:inner@1', 'one@2', 'close:inner@1', 'two@1', 'branch:except E@0', 'three@1', 'close:outer@0']);
});

test('sequenceEvents puts notes into the fragment arm they name, also arms holding only notes (first and last arms)', () => {
  row = 0;
  const note = (id: string, after: number, fragment?: string, arm?: number) => ({ id, participant: 'a', after, text: id, kind: 'error' as const, source: null, fragment, arm });
  const data: SequenceData = { participants: [p('a', 'a', 0), p('b', 'b', 1)],
    messages: [m('a', 'b', 'call', 'one', 0), m('a', 'b', 'call', 'two', 0), m('a', 'b', 'call', 'three', 0)],
    // Engine shape: arms 0 and 1 hold only notes (first = the next arm's), arm 3 too (first = last + 1).
    fragments: [{ id: 'f0', kind: 'alt', label: 'none', first: 1, last: 1, branches: [{ label: 'bad', first: 1 }, { label: 'else', first: 1 }, { label: 'other', first: 2 }], parent: null, source: null }],
    notes: [note('n0', 0, 'f0', 0), note('n1', 0, 'f0', 1), note('n3', 1, 'f0', 3), note('top', 1), note('first', 0)] };
  const trace = sequenceEvents(data).map(e => e.type === 'message' ? `${e.message.label}@${e.depth}` : e.type === 'note' ? `${e.note.id}@${e.depth}`
    : `${e.type}:${e.type === 'branch' ? e.label : e.fragment.id}`);
  assert.deepEqual(trace, ['one@0', 'first@0', 'open:f0', 'n0@1', 'branch:bad', 'n1@1', 'branch:else', 'two@1', 'branch:other', 'n3@1', 'close:f0', 'top@0', 'three@0']);
  const layout = sequenceLayout(data), [frame] = layout.fragments;
  const inside = (id: string) => { const n = layout.notes.find(x => x.note.id === id)!; return n.y > frame.y && n.y + n.height < frame.y + frame.height; };
  assert.deepEqual(['n0', 'n1', 'n3', 'top', 'first'].map(inside), [true, true, true, false, false]);
  assert.deepEqual(frame.branches.map(b => b.label), ['bad', 'else', 'other']);
});

test('sequenceLayout places lifelines left to right, wide enough for the labels between them', () => {
  const data = login(), layout = sequenceLayout(data);
  const xs = layout.participants.map(q => q.x);
  assert.deepEqual(layout.participants.map(q => q.participant.id), ['actor', 'web', 'auth', 'cog']);
  assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]), 'columns increase');
  for (const lm of layout.messages) {
    const span = Math.abs(lm.x2 - lm.x1);
    if (lm.x1 !== lm.x2 && lm.message.kind !== 'self' && lm.message.from !== lm.message.to) assert.ok(span >= lm.lines[0].length * SEQ.charWidth, `${lm.lines[0]} fits its arrow`);
  }
  // A long label between web and auth pushes auth (and everything right of it) further out.
  const long = login();
  long.messages[2] = { ...long.messages[2], label: 'POST /auth/login/with/a/really/long/path' };
  const wide = sequenceLayout(long);
  assert.ok(wide.participants[2].x - wide.participants[1].x > layout.participants[2].x - layout.participants[1].x);
  assert.ok(wide.width > layout.width);
});

test('sequenceLayout gives each message its own row, arrows point toward the callee, returns back', () => {
  const layout = sequenceLayout(login());
  const ys = layout.messages.map(lm => lm.y);
  assert.ok(ys.every((y, i) => i === 0 || y > ys[i - 1]), 'rows go down');
  const [click, submit, post, , call, ret] = layout.messages;
  assert.ok(click.x2 > click.x1 && post.x2 > post.x1 && call.x2 > call.x1, 'calls point right here');
  assert.ok(ret.x2 < ret.x1, 'return points back');
  assert.deepEqual(submit.lines, ['submit']);
  assert.ok(submit.labelX > submit.x1 + SEQ.selfWidth, 'self message label sits right of its loop');
  assert.ok(submit.bottom - submit.top === SEQ.selfRow && click.bottom - click.top === SEQ.row);
});

test('sequenceLayout draws activation bars for callees, nested bars for re-entry, ending at the return', () => {
  const layout = sequenceLayout(login());
  const bars = (id: string) => layout.activations.filter(a => a.participant === id);
  const auth = layout.participants.find(q => q.participant.id === 'auth')!;
  const call = layout.messages[4], ret = layout.messages[5], response = layout.messages[6];
  const cognito = bars('cog');
  assert.equal(cognito.length, 1);
  assert.ok(cognito[0].y <= call.y && cognito[0].y + cognito[0].height >= ret.y, 'Cognito is active from the call to its return');
  const outer = bars('auth').find(a => a.x < auth.x)!;
  assert.ok(outer && outer.y <= layout.messages[2].y && outer.y + outer.height >= response.y, 'auth is active from POST to its response');
  const nested = bars('auth').find(a => a.x > outer.x)!;
  assert.ok(nested && nested.y + nested.height < call.y, 'the self link nests a second bar that ends before the next call');
  assert.equal(bars('web').length, 2, 'web: the trigger activation plus the nested self call');
  const web = bars('web').find(a => a.y <= layout.messages[0].y)!;
  assert.ok(web.y + web.height >= response.y, 'the entry stays active from the trigger to its last call');
});

test('sequenceLayout frames fragments over the lifelines they touch, with branch separators and notes inside', () => {
  const layout = sequenceLayout(login());
  const [frame] = layout.fragments, [note] = layout.notes;
  const x = (id: string) => layout.participants.find(q => q.participant.id === id)!.x;
  assert.ok(frame.x < x('auth') && frame.x > x('web') && frame.x + frame.width > x('cog'), 'alt spans auth..Cognito only');
  assert.ok(frame.y < layout.messages[4].top && frame.y + frame.height > layout.messages[5].bottom);
  assert.equal(frame.branches.length, 1);
  assert.ok(frame.branches[0].y > layout.messages[5].y && frame.branches[0].y < note.y, 'else separator between the call and the note');
  assert.ok(note.y + note.height < frame.y + frame.height && note.x + note.width / 2 === x('auth'), 'note centered on auth, inside the frame');
  assert.ok(layout.messages[6].top > frame.y + frame.height, 'the response comes after the frame');
});

test('sequenceLayout pads nested fragments inside their parent and widens the frame for its label', () => {
  row = 0;
  const data: SequenceData = { participants: [p('a', 'a', 0), p('b', 'b', 1)],
    messages: [m('a', 'b', 'call', 'x', 0), m('b', 'a', 'return', '', 0)],
    fragments: [{ id: 'outer', kind: 'opt', label: 'a really long condition that is wider than both lifelines together', first: 0, last: 1, branches: [], parent: null, source: null },
      { id: 'inner', kind: 'loop', label: 'i', first: 0, last: 0, branches: [], parent: 'outer', source: null }],
    notes: [] };
  const layout = sequenceLayout(data);
  const outer = layout.fragments.find(f => f.fragment.id === 'outer')!, inner = layout.fragments.find(f => f.fragment.id === 'inner')!;
  assert.ok(outer.x < inner.x && outer.y < inner.y && outer.y + outer.height > inner.y + inner.height, 'inner inside outer');
  assert.equal(inner.depth, 1);
  assert.equal(outer.lines.length, 2, 'a long condition wraps to two lines');
  assert.ok(outer.width >= Math.max(...outer.lines.map(l => l.length)) * SEQ.charWidth, 'label fits');
  assert.ok(layout.width >= outer.x + outer.width && outer.x >= 0);
});

test('wrapLines wraps words at a width, breaks long words and ends a cut last line in …', () => {
  assert.deepEqual(wrapLines('', 10), []);
  assert.deepEqual(wrapLines('get user', 10), ['get user']);
  assert.deepEqual(wrapLines('verify the password of the user', 12), ['verify the', 'password of…']);
  assert.deepEqual(wrapLines('abcdefghijklmno', 6, 3), ['abcdef', 'ghijkl', 'mno']);
});

test('sequenceLayout wraps long labels instead of cutting them: rows, notes and the header grow', () => {
  row = 0;
  const long = 'check whether the account may sign in from this device and region right now';
  const data: SequenceData = { participants: [{ ...p('a', 'a', 0), explanation: 'Routes the sign-in request to the service.' }, p('b', 'b', 1)],
    messages: [m('a', 'b', 'call', 'x', 0), m('a', 'b', 'call', long, 0)], fragments: [],
    notes: [{ id: 'n0', participant: 'b', after: 1, text: `can fail: ${long}`, kind: 'error', source: null }] };
  const layout = sequenceLayout(data);
  const [short, wrapped] = layout.messages, [note] = layout.notes;
  assert.equal(wrapped.lines.length, 2);
  assert.equal(wrapped.lines.join(' '), long, 'nothing is cut');
  assert.equal(wrapped.bottom - wrapped.top, short.bottom - short.top + SEQ.line, 'the row grows by a line');
  assert.equal(note.lines.length, 2);
  assert.equal(note.height, SEQ.noteHeight + SEQ.line);
  assert.equal(layout.headerHeight, SEQ.headerHeight + SEQ.explanationHeight);
  assert.ok(layout.participants[0].explanation.length > 0 && layout.participants[1].explanation.length === 0);
  assert.equal(sequenceLayout({ ...data, participants: [p('a', 'a', 0), p('b', 'b', 1)] }).headerHeight, SEQ.headerHeight, 'no explanations: no room');
});

test('sequenceLayout copes with no messages and unknown participants', () => {
  const empty = sequenceLayout({ participants: [p('a', 'a', 0)], messages: [], fragments: [], notes: [] });
  assert.equal(empty.messages.length, 0);
  assert.ok(empty.width > 0 && empty.height > 0);
  row = 0;
  const odd = sequenceLayout({ participants: [p('a', 'a', 0)], messages: [m('a', 'gone', 'call', 'x', 0)], fragments: [], notes: [] });
  assert.equal(odd.messages.length, 1);
});

test('collapseParticipants folds a participant into its callers: its calls start there, calls into it and back vanish', () => {
  const data = login();
  assert.deepEqual(['actor', 'web', 'auth', 'cog'].map(id => collapsible(data, id)), [false, false, true, true], 'only the actor calls web');
  const arrows = (d: SequenceData) => d.messages.map(x => `${x.from}${x.kind === 'return' ? '-->' : '->'}${x.to}:${x.label}`);
  const auth = collapseParticipants(data, new Set(['auth', 'web']));
  assert.deepEqual(auth.participants.map(q => q.id), ['actor', 'web', 'cog']);
  assert.deepEqual(arrows(auth), ['actor->web:click Sign in', 'web->web:submit', 'web->cog:initiate auth', 'cog-->web:tokens']);
  assert.deepEqual(auth.fragments.map(f => [f.first, f.last, f.branches.map(b => b.first)]), [[2, 3, [4]]], 'the alt keeps its rows and the notes-only else');
  assert.deepEqual(auth.notes.map(n => [n.participant, n.after, n.fragment, n.arm]), [['web', 3, 'f0', 1]]);
  const cognito = collapseParticipants(data, new Set(['cog']));
  assert.deepEqual(arrows(cognito).slice(3), ['auth->auth:get_current_user', 'auth-->web:response']);
  assert.deepEqual(cognito.fragments, [], 'the alt lost its only messages');
  assert.deepEqual(cognito.notes.map(n => [n.participant, n.after, n.fragment, n.arm]), [['auth', 3, null, undefined]]);
  assert.equal(collapseParticipants(data, new Set(['web'])), data, 'nothing to fold');
});
