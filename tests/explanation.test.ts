import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EXPLANATION, docstringSummary, explanationOf } from '../electron/views/explanation';

test('docstringSummary: first paragraph of a Python triple-quoted docstring, whitespace collapsed', () => {
  assert.equal(docstringSummary('"""Accept a Cognito access token\n    only if it is genuine.\n\n    Raises:\n        401 otherwise.\n    """'),
    'Accept a Cognito access token only if it is genuine.');
  assert.equal(docstringSummary("r'''Raw docstring.'''"), 'Raw docstring.');
  // CodeGraph already strips the quotes: only the paragraph is cut
  assert.equal(docstringSummary('Accept a token.\n\nMore text.'), 'Accept a token.');
  assert.equal(docstringSummary('Returns "x"'), 'Returns "x"');
  // text that merely starts with a quote keeps it
  assert.equal(docstringSummary('"a" or "b" are accepted'), '"a" or "b" are accepted');
  assert.equal(docstringSummary("'x' is the key"), "'x' is the key");
  assert.equal(docstringSummary('"a" or "b"'), '"a" or "b"');
});

test('docstringSummary: JSDoc and line comments lose their markers; @tags end the summary', () => {
  assert.equal(docstringSummary('/**\n * Reconcile the email\n * with the profile.\n * @param x the x\n */'), 'Reconcile the email with the profile.');
  assert.equal(docstringSummary('Reconcile the email.\nSecond line.\n@param x the x'), 'Reconcile the email.');
  assert.equal(docstringSummary('/** One liner. */'), 'One liner.');
  assert.equal(docstringSummary('// first\n// second'), 'first second');
  assert.equal(docstringSummary('# Ruby or shell\n# comment'), 'Ruby or shell comment');
});

test('docstringSummary: without blank lines (CodeGraph strips them from JSDoc) the first sentence-ending line ends the summary', () => {
  // CodeGraph's text for "/** Probe: first paragraph only.\n *\n * Second paragraph.\n * @param x */"
  assert.equal(docstringSummary('Probe: first paragraph only.\nSecond paragraph must not show.\n@param {string} x a value'), 'Probe: first paragraph only.');
  assert.equal(docstringSummary('Read the current session, refreshing\nthe token once when asked.\nMore detail.'), 'Read the current session, refreshing the token once when asked.');
  assert.equal(docstringSummary('Ends with a quote "x."\nNext.'), 'Ends with a quote "x."');
  assert.equal(docstringSummary('Is it done?\nNext.'), 'Is it done?');
  // a Python docstring with a blank line keeps its whole first paragraph, even across sentences
  assert.equal(docstringSummary('Accept a token.\nVerify its claims.\n\nRaises: 401.'), 'Accept a token. Verify its claims.');
  assert.equal(docstringSummary('"""Accept a token.\n    Verify its claims.\n    """'), 'Accept a token.');
});

test('docstringSummary: empty is null; long text is capped with an ellipsis', () => {
  for (const raw of [undefined, null, '', '   ', '""""""', '/** */', '/**\n * @param x\n */', '\n\n']) assert.equal(docstringSummary(raw), null, String(raw));
  const long = docstringSummary('word '.repeat(200))!;
  assert.equal(long.length, MAX_EXPLANATION);
  assert.ok(long.endsWith('…'));
  assert.equal(docstringSummary('x'.repeat(MAX_EXPLANATION)), 'x'.repeat(MAX_EXPLANATION));
});

test('explanationOf spreads nothing for symbols without a docstring', () => {
  const s = { id: '1', name: 'f', kind: 'function', file: 'a.py', line: 1 };
  assert.deepEqual(explanationOf(s), {});
  assert.deepEqual(explanationOf(null), {});
  assert.deepEqual(explanationOf({ ...s, docstring: 'Do f.' }), { explanation: 'Do f.' });
});
