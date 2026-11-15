import { test } from 'node:test';
import assert from 'node:assert/strict';
import Prism from 'prismjs/components/prism-core.js';
import { highlightLines, splitTokenLines } from '../src/highlight';

const text = (lines: ReturnType<typeof highlightLines>) => lines.map(line => line.map(token => token.text).join('')).join('\n');

test('splitTokenLines preserves multiline comment styles and emits only text, never markup', () => {
  const source = '/* first\n<script>alert("x")</script>\nlast */\nconst n = 1;\n';
  const lines = splitTokenLines(Prism.tokenize(source, Prism.languages.typescript));
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.slice(0, 3), [
    [{ text: '/* first', type: 'comment' }],
    [{ text: '<script>alert("x")</script>', type: 'comment' }],
    [{ text: 'last */', type: 'comment' }],
  ]);
  assert.equal(text(lines), source);
  for (const line of lines) for (const token of line) {
    assert.deepEqual(Object.keys(token), ['text', 'type']);
    assert.equal(typeof token.text, 'string'); assert.equal(typeof token.type, 'string');
  }
});

test('highlightLines handles nested tokens, diff prefixes and plain text limits without changing source', () => {
  const source = '<div title="hello">{value}</div>\n';
  assert.equal(text(highlightLines(source, 'file.tsx')), source);
  const diff = '--- old.ts\n+++ new.ts\n@@ -1 +1 @@\n-const n = 1;\n+const n = 2;\n const n = 3;';
  const lines = highlightLines(diff, 'file.ts', true);
  assert.equal(text(lines), diff);
  assert.deepEqual(lines[4][0], { text: '+', type: '' });
  assert.ok(lines[4].some(token => token.type === 'keyword' && token.text === 'const'));
  for (const [source, path] of [['const n = 1;', 'unknown'], ['// hi\n'.repeat(40000), 'big.ts']]) {
    const lines = highlightLines(source, path);
    assert.equal(text(lines), source); assert.ok(lines.flat().every(token => token.type === ''));
  }
});
