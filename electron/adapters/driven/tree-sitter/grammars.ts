// CodeGraph's tree-sitter grammars (the wasm files it vendors in its platform bundle), shared by the rule engine.
import { createRequire } from 'node:module';
import path from 'node:path';
import { Parser } from 'web-tree-sitter';

/** Rule `language` -> grammar file in codegraphGrammarDir(). Only grammars CodeGraph vendors in that directory. */
export const GRAMMAR_FILES: Record<string, string> = {
  arkts: 'tree-sitter-arkts.wasm', c: 'tree-sitter-c.wasm', cfml: 'tree-sitter-cfml.wasm', cfquery: 'tree-sitter-cfquery.wasm',
  cfscript: 'tree-sitter-cfscript.wasm', cobol: 'tree-sitter-cobol.wasm', cpp: 'tree-sitter-cpp.wasm', csharp: 'tree-sitter-c_sharp.wasm',
  dart: 'tree-sitter-dart.wasm', erlang: 'tree-sitter-erlang.wasm', go: 'tree-sitter-go.wasm', java: 'tree-sitter-java.wasm',
  javascript: 'tree-sitter-javascript.wasm', jsx: 'tree-sitter-javascript.wasm', kotlin: 'tree-sitter-kotlin.wasm', lua: 'tree-sitter-lua.wasm',
  luau: 'tree-sitter-luau.wasm', nix: 'tree-sitter-nix.wasm', pascal: 'tree-sitter-pascal.wasm', php: 'tree-sitter-php.wasm',
  python: 'tree-sitter-python.wasm', r: 'tree-sitter-r.wasm', ruby: 'tree-sitter-ruby.wasm', rust: 'tree-sitter-rust.wasm',
  scala: 'tree-sitter-scala.wasm', swift: 'tree-sitter-swift.wasm', terraform: 'tree-sitter-terraform.wasm', tsx: 'tree-sitter-tsx.wasm',
  typescript: 'tree-sitter-typescript.wasm', vbnet: 'tree-sitter-vbnet.wasm',
};
export const LANGUAGES = Object.keys(GRAMMAR_FILES);

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
