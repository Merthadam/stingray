import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { codegraphGrammarDir } from '../electron/views/rules/grammars';

// Stingray installs the stinggraph CodeGraph fork from local tarballs at the same version (1.6.2) as the npm release,
// so a stray registry install would go unnoticed without a fork-only marker.
test('the installed CodeGraph is the stinggraph fork', () => {
  const { CodeGraph } = createRequire(import.meta.url)('@colbymchenry/codegraph') as typeof import('@colbymchenry/codegraph');
  assert.equal(typeof (CodeGraph.prototype as unknown as Record<string, unknown>).getLayers, 'function');
  assert.ok(existsSync(path.join(codegraphGrammarDir(), '../../resolution/mcp-tool-synthesizer.js')));
});
