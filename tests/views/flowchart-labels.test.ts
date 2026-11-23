import test from 'node:test';
import assert from 'node:assert/strict';
import { callLabel, caseLabel, decisionLabel, endLabel, errorLabel, loopLabel, splitWords, words } from '../../electron/core/views/flowchart/labels';

test('splitWords splits snake_case, camelCase and acronyms', () => {
  assert.equal(splitWords('send_reset_email'), 'send reset email');
  assert.equal(splitWords('sendResetEmail'), 'send reset email');
  assert.equal(splitWords('parseHTTPRequest'), 'parse http request');
  assert.equal(splitWords('__init__'), 'init');
  assert.equal(splitWords('MAX_RETRIES'), 'max retries');
});

test('words drops self/this/await and spells out operators, strings stay', () => {
  assert.equal(words('self.user.isActive && await this.canLogin()'), 'user is active and can login');
  assert.equal(words("role === 'admin' || x != 3"), "role is 'admin' or x is not 3");
  assert.equal(words('keys.some(id => !ids.includes(id))'), 'keys some id not ids includes id');
});

test('decisionLabel: negation flips the branch, null checks become "has x?", length checks "x empty?"', () => {
  assert.deepEqual(decisionLabel('(!project.exists)'), { label: 'project exists?', negated: true });
  assert.deepEqual(decisionLabel('not project.exists'), { label: 'project exists?', negated: true });
  assert.deepEqual(decisionLabel('not not ok'), { label: 'ok?', negated: false });
  assert.deepEqual(decisionLabel('user is None'), { label: 'has user?', negated: true });
  assert.deepEqual(decisionLabel('user is not None'), { label: 'has user?', negated: false });
  assert.deepEqual(decisionLabel('(this.session === null)'), { label: 'has session?', negated: true });
  assert.deepEqual(decisionLabel('session !== undefined'), { label: 'has session?', negated: false });
  assert.deepEqual(decisionLabel('not user is None'), { label: 'has user?', negated: false });
  assert.deepEqual(decisionLabel('len(items) == 0'), { label: 'items empty?', negated: false });
  assert.deepEqual(decisionLabel('(items.length === 0)'), { label: 'items empty?', negated: false });
  assert.deepEqual(decisionLabel('(!items.length)'), { label: 'items empty?', negated: false });
  assert.deepEqual(decisionLabel('items.length > 0'), { label: 'items empty?', negated: true });
  assert.deepEqual(decisionLabel('len(self.queue)'), { label: 'queue empty?', negated: true });
  assert.deepEqual(decisionLabel('(a && b) || c'), { label: 'a and b or c?', negated: false });
  assert.deepEqual(decisionLabel('await isAllowed(user)'), { label: 'is allowed user?', negated: false });
  // `!==` is not a negation
  assert.deepEqual(decisionLabel('a !== b'), { label: 'a is not b?', negated: false });
});

test('decisionLabel: a leading not/! on one operand of and/or/comparison does not flip; len()/length patterns need one operand', () => {
  assert.deepEqual(decisionLabel("not snapshot or snapshot.get('kind') != 'session'"), { label: "not snapshot or snapshot get 'kind' is…", negated: false });
  assert.deepEqual(decisionLabel('!a && b'), { label: 'not a and b?', negated: false });
  assert.deepEqual(decisionLabel('!a === b'), { label: 'not a is b?', negated: false });
  assert.deepEqual(decisionLabel('!latest.readiness?.eligible'), { label: 'latest readiness eligible?', negated: true });
  assert.deepEqual(decisionLabel('!(a || b)'), { label: 'a or b?', negated: true });
  assert.deepEqual(decisionLabel('provider is None or verifier is None'), { label: 'provider is none or verifier is none?', negated: false });
  assert.deepEqual(decisionLabel('len(selections) != len(self.snapshots)'), { label: 'len selections is not len snapshots?', negated: false });
  assert.deepEqual(decisionLabel('a.length !== b.length'), { label: 'a length is not b length?', negated: false });
});

test('decisionLabel truncates to 40 characters', () => {
  const { label } = decisionLabel('user.has_verified_email_address and user.accepted_terms_of_service');
  assert.equal(label.length, 40);
  assert.ok(label.endsWith('…'));
});

test('callLabel, endLabel, errorLabel, loopLabel, caseLabel', () => {
  assert.equal(callLabel('send_reset_email'), 'send reset email');
  assert.equal(endLabel(null), 'done');
  assert.equal(endLabel('None'), 'done');
  assert.equal(endLabel('undefined;'), 'done');
  assert.equal(endLabel('self.user'), 'user');
  assert.equal(errorLabel('ValueError("no name")'), 'ValueError: no name');
  assert.equal(errorLabel("new Error('empty list')"), 'Error: empty list');
  assert.equal(errorLabel('errors.NotFound(f"user {id}")'), 'NotFound: user {id}');
  assert.equal(errorLabel('PermissionError(code)'), 'PermissionError');
  assert.equal(errorLabel(null), 're-raise');
  assert.equal(errorLabel('e'), 'e');
  assert.deepEqual(loopLabel({ over: 'self.pendingUsers', cond: null }), { label: 'more pending users?', negated: false });
  assert.deepEqual(loopLabel({ over: 'range(3)', cond: null }), { label: 'more items?', negated: false });
  assert.deepEqual(loopLabel({ over: null, cond: 'not done' }), { label: 'done?', negated: true });
  assert.deepEqual(loopLabel({ over: null, cond: null }), { label: 'repeat?', negated: false });
  assert.equal(caseLabel('_'), 'other');
  assert.equal(caseLabel(null), 'other');
  assert.equal(caseLabel("'admin' | 'owner'"), "'admin' | 'owner'");
});
