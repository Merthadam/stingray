// Views core + real adapters under the names and signatures the app and the existing tests use.
import './core-ports';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SaveViewInput } from '../../../shared/contracts/views';
import { createFileProvider } from '../../adapters/driven/fs/files';
import { nodeViewFiles } from '../../adapters/driven/fs/view-files';
import { runGit } from '../../adapters/driven/git/runner';
import { SqliteViewStateStore } from '../../adapters/driven/sqlite/view-state-repository';
import { runCli as runCliCore, type CliDeps as DrivingCliDeps } from '../../adapters/driving/cli/views-cli';
import * as core from '../../core/views';
import { extractDbSchema, extractSqlSchema } from './db-schema';

export class ViewService extends core.ViewService {
  constructor(options: { host: core.GraphHost; grammarPath: string; emit: core.ViewsPublisher; debounceMs?: number; dbSchema?: core.DbSchemaSource }) {
    super({ ...options, viewFiles: nodeViewFiles, fileProvider: createFileProvider,
      dbSchema: options.dbSchema ?? { dbSchema: (id, root) => extractDbSchema(id, root, options.grammarPath), sqlSchema: (id, root) => extractSqlSchema(id, root) } });
  }
}
export { SqliteViewStateStore as ViewStateStore };
/** Worktree of `dir`: git toplevel, else the nearest ancestor containing .stingray; null when neither. */
export async function worktreeRoot(dir: string): Promise<string | null> {
  try { return await realpath((await runGit(dir, ['rev-parse', '--show-toplevel'], { timeout: 10_000 })).trim()); }
  catch { /* not a git worktree (or no git) */ }
  for (let d = await realpath(dir); ; d = path.dirname(d)) {
    if (await stat(path.join(d, '.stingray')).then(s => s.isDirectory(), () => false)) return d;
    if (path.dirname(d) === d) return null;
  }
}
export const listViewFiles = (root: string, sets?: core.BuiltinSets) => core.listViewFiles(nodeViewFiles, root, sets);
export const readViewFile = (root: string, slug: string, sets?: core.BuiltinSets) => core.readViewFile(nodeViewFiles, root, slug, sets);
export const loadViewPath = (root: string, relFile: string, sets?: core.BuiltinSets) => core.loadViewPath(nodeViewFiles, root, relFile, sets);
export const saveViewAs = (root: string, input: SaveViewInput) => core.saveViewAs(nodeViewFiles, root, input);
export type CliDeps = Omit<DrivingCliDeps, 'worktreeRoot'> & Partial<Pick<DrivingCliDeps, 'worktreeRoot'>>;
export const runCli = (argv: string[], deps: CliDeps) => runCliCore(argv, { worktreeRoot, ...deps });
export { createFileProvider, MAX_FILES, MAX_SOURCE_BYTES } from '../../adapters/driven/fs/files';
export { codegraphGrammarDir, initTreeSitter, GRAMMAR_FILES } from '../../adapters/driven/tree-sitter/grammars';
export {
  MAX_VIEW_STATES, computeView, databaseView, applyExplain, bodyFingerprint, collectPieces, compareFingerprint, describeChanges, drawnFingerprint,
  explainTargets, MAX_EXPLANATION, docstringSummary, explanationOf, MAX_FLOWCHART_NODES, callLabel, caseLabel, decisionLabel, endLabel,
  errorLabel, loopLabel, splitWords, words, withInfraServices, calleesOf, LIMITS, createEvaluate, evaluate, MAX_GRAPH_NODES, runGraphStep,
  runLayers, YamlError, parseRuleFileYaml, parseViewYaml, renderTemplate, templateCaptures, LINK_SETS, viewSlug, SEQUENCE_LIMITS,
  BUILTIN_SETS, TS_EXTRACTORS, EXTRACTOR_DESCRIPTIONS, MAX_VIEW_FILES, inScope, tablesView, fileImports, externalCall,
} from '../../core/views';
