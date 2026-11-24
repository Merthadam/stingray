import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { codegraphGrammarDir } from '../../electron/app/wiring/views';

// Stingray installs the stinggraph CodeGraph fork from its GitHub release tarballs (1.6.2-sting.N); a fork-only
// marker catches a stray registry install, and the platform bundle must be there (it is an optional dependency).
test('the installed CodeGraph is the stinggraph fork', () => {
  const require = createRequire(import.meta.url);
  assert.match(require('@colbymchenry/codegraph/package.json').version, /-sting\.\d+$/);
  assert.match(require(`@colbymchenry/codegraph-${process.platform}-${process.arch}/package.json`).version, /-sting\.\d+$/);
  const { CodeGraph } = require('@colbymchenry/codegraph') as typeof import('@colbymchenry/codegraph');
  assert.equal(typeof (CodeGraph.prototype as unknown as Record<string, unknown>).getLayers, 'function');
  assert.ok(existsSync(path.join(codegraphGrammarDir(), '../../resolution/mcp-tool-synthesizer.js')));
});
