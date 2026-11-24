// CodeGraph's tree-sitter grammars (the wasm files it vendors in its platform bundle), shared by the rule engine.
import { createRequire } from 'node:module';
import path from 'node:path';
import { Parser } from 'web-tree-sitter';

export { GRAMMAR_FILES, LANGUAGES } from '../../../core/shared/grammar-files';

let grammarDir: string | undefined;
/** `<@colbymchenry/codegraph-<platform>-<arch>>/lib/dist/extraction/wasm`, resolved from the main CodeGraph package. */
export function codegraphGrammarDir(): string {
  if (grammarDir) return grammarDir;
  // `require` exists in the esbuild CJS bundle (CodeGraph stays external there); tsx/ESM gets one from import.meta.url.
  const req = typeof require === 'function' ? require : createRequire(import.meta.url);
  const main = req.resolve('@colbymchenry/codegraph/package.json');
  const platform = createRequire(main).resolve(`@colbymchenry/codegraph-${process.platform}-${process.arch}/package.json`);
  return grammarDir = path.join(path.dirname(platform), 'lib/dist/extraction/wasm');
}

let init: Promise<void> | undefined;
/** Parser.init replaces web-tree-sitter's wasm module and breaks languages loaded before it: init once per process. */
export const initTreeSitter = () => init ??= Parser.init();
