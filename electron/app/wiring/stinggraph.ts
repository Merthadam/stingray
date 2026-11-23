// Stinggraph worker adapters with their driven dependencies (git runner, fs file provider, tree-sitter grammars),
// under the names the app, the worker entry and the existing tests use.
import { runGit } from '../../adapters/driven/git/runner';
import { excludeCodeGraphCache } from '../../adapters/driven/git/git-exclude';
import { createFileProvider } from '../../adapters/driven/fs/files';
import { codegraphGrammarDir } from '../../adapters/driven/tree-sitter/grammars';
import { createCodeGraphHost as createHost, serveCodeGraph as serve, type CodeGraphHostOptions } from '../../adapters/driven/stinggraph-worker/stinggraph';
import { createCodeGraphProcessHost as createProcessHost, type CodeGraphProcessHostOptions, type WorkerEvent } from '../../adapters/driven/stinggraph-worker/stinggraph-process';

const workerDeps: Required<Pick<CodeGraphHostOptions, 'grammarDir' | 'files' | 'gitOut'>> = {
  grammarDir: codegraphGrammarDir,
  files: createFileProvider,
  gitOut: (cwd, args, env = {}) => runGit(cwd, args, { timeout: 0, maxBuffer: 1 << 28, env }),
};
export const createCodeGraphHost = (options: CodeGraphHostOptions = {}) => createHost({ ...workerDeps, ...options });
export const serveCodeGraph = (send: (event: WorkerEvent) => void, exit: () => void, options: CodeGraphHostOptions = {}) => serve(send, exit, { ...workerDeps, ...options });
export const createCodeGraphProcessHost = (options: Partial<CodeGraphProcessHostOptions> = {}) => createProcessHost({ exclude: excludeCodeGraphCache, ...options });
export { removeOverlay, baseRoot, overlayPath } from '../../adapters/driven/stinggraph-worker/stinggraph-overlay';
export type { WorkerEvent, WorkerRequest } from '../../adapters/driven/stinggraph-worker/stinggraph-process';
