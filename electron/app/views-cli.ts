// Process entry of `stingray-views` (bundled to dist-electron/views-cli.cjs; see adapters/driving/cli/views-cli.ts).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCliSafely, short, type CliDeps, type OpenedGraph } from '../adapters/driving/cli/views-cli';
import { createGraphApi } from '../adapters/driven/stinggraph-worker/stinggraph-api';
import { listViewFiles, loadViewPath, worktreeRoot } from './wiring/views';

async function openGraph(root: string): Promise<OpenedGraph> {
  type Library = typeof import('@colbymchenry/codegraph');
  try {
    const m = await import('@colbymchenry/codegraph');
    const lib = 'CodeGraph' in m ? m : (m as unknown as { default: Library }).default;
    if (!lib.CodeGraph.isInitialized(root)) return { api: null, status: { state: 'unavailable', message: 'no .codegraph index in this worktree (Stingray builds it when the worktree is open)' } };
    const cg = await lib.CodeGraph.open(root, { readOnly: true });
    try {
      return { api: createGraphApi(cg), status: { state: 'read-only', message: null }, close: () => cg.close(),
        indexedMtime: file => { try { return cg.getFile(file)?.modifiedAt ?? null; } catch { return null; } } };
    } catch (error) { cg.close(); throw error; }
  } catch (error) { return { api: null, status: { state: 'unavailable', message: `could not open the code graph: ${short(error)}` } }; }
}

async function main() {
  // Before CodeGraph is loaded (it reads these at import/open); the launcher sets them too.
  process.env.CODEGRAPH_TELEMETRY = '0'; process.env.CODEGRAPH_NO_UPDATE_CHECK = '1';
  const [{ evaluate }, { codegraphGrammarDir }, { createFileProvider }, { extractDbSchema, extractSqlSchema }] = await Promise.all([
    import('../core/views'), import('../adapters/driven/tree-sitter/grammars'), import('../adapters/driven/fs/files'), import('./wiring/db-schema')]);
  // __dirname is dist-electron in the bundle: package.json, the Python grammar and the skills sit relative to it.
  let version = '';
  try { version = JSON.parse(await readFile(path.join(__dirname, '../package.json'), 'utf8')).version; } catch { /* unknown */ }
  const deps: CliDeps = {
    cwd: process.cwd(), out: text => process.stdout.write(text + '\n'), err: text => process.stderr.write(text + '\n'),
    loadViewPath, listViews: listViewFiles, evaluate, createFileProvider, openGraph, grammarDir: codegraphGrammarDir,
    dbSchema: root => extractDbSchema('cli', root, path.join(__dirname, 'tree-sitter-python.wasm')),
    sqlSchema: root => extractSqlSchema('cli', root),
    skillFile: path.join(__dirname, 'skills/stingray-views/SKILL.md'), version, worktreeRoot,
  };
  const code = await runCliSafely(process.argv.slice(2), deps);
  // Exit once output is flushed: an open CodeGraph or tree-sitter handle must not keep the CLI alive.
  process.stdout.write('', () => process.exit(code));
}

if (typeof require !== 'undefined' && require.main === module) void main();
