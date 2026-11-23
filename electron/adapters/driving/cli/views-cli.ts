// `stingray-views`: checks repo view files for agents in Stingray terminals (see .superpowers/sdd/views-platform/m3-design.md).
// Bundled to dist-electron/views-cli.cjs and run by the launcher (electron/adapters/driven/fs/launcher.ts) with ELECTRON_RUN_AS_NODE=1
// and --liftoff-only. Runs the rule engine in-process; opens an existing .codegraph index read-only, never indexes or writes.
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isMap, parseDocument } from 'yaml';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DbSchemaResult } from '../../../../shared/contracts/db-schema';
import type { ExplainDiagnostic, GraphStatus, ViewSummary, ViewWarning } from '../../../../shared/contracts/views';
import type { Evaluate, FileProvider, GraphApi } from '../../../core/views/rules/types';
import { computeView } from '../../../core/views/compute';
import { calleesOf } from '../../../core/views/rules/callees';
import { formatText } from '../../../../shared/views/views-text';
import { BUILTIN_SETS, EXTRACTOR_DESCRIPTIONS, TS_EXTRACTORS } from '../../../core/views/sets';
import { listViewFiles, loadViewPath } from '../../../core/views/view-file';
import { explainPair } from '../../../core/views/rules/schema';
import { runGit } from '../../driven/git/runner';

type LoadedView = Awaited<ReturnType<typeof loadViewPath>>;
export interface OpenedGraph {
  api: GraphApi | null; status: GraphStatus; close?: () => void;
  indexedMtime?: (file: string) => number | null; // a file's mtime when the index last read it; null = not indexed
}
export interface CliDeps {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  loadViewPath: (root: string, relFile: string) => Promise<LoadedView>;
  listViews: (root: string) => Promise<{ summary: ViewSummary }[]>;
  evaluate: Evaluate;
  createFileProvider: (root: string) => FileProvider;
  openGraph: (root: string) => Promise<OpenedGraph>;
  grammarDir: () => string;
  dbSchema: (root: string) => Promise<DbSchemaResult>; // the `sqlalchemy` extractor
  sqlSchema: (root: string) => Promise<DbSchemaResult>;
  skillFile: string;
  version: string;
}

export const USAGE = `Usage:
  stingray-views check <file.yaml> [--json] [--depth N] [--restamp | --strict]
                                              validate a view and print diagnostics + a text diagram
                                              (--depth 0-4: flowchart call levels, overrides flowchart.depth;
                                               1-4: layers level, overrides layers.depth;
                                               0-6: sequence call levels, overrides sequence.depth;
                                               --restamp: after reviewing explain: texts, write the current
                                               fingerprints into the file;
                                               --strict: exit 1 when an explain: entry is outdated,
                                               unstamped or has an old fingerprint, for CI)
  stingray-views list                         views of this worktree
  stingray-views sets                         builtin rule sets for \`use:\`
  stingray-views help                         the full guide (view format, rules, workflow)
  stingray-views --version`;

const isInside = (root: string, file: string) => { const rel = path.relative(root, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const where = (w: ViewWarning, fallback: string | null = null) => {
  const file = w.file ?? fallback;
  return file ? `${file}${w.line !== null ? `:${w.line}` : ''}: ${w.message}` : w.message;
};

/** Worktree of `dir`: git toplevel, else the nearest ancestor containing .stingray; null when neither. */
export async function worktreeRoot(dir: string): Promise<string | null> {
  try { return await realpath((await runGit(dir, ['rev-parse', '--show-toplevel'], { timeout: 10_000 })).trim()); }
  catch { /* not a git worktree (or no git) */ }
  for (let d = await realpath(dir); ; d = path.dirname(d)) {
    if (await stat(path.join(d, '.stingray')).then(s => s.isDirectory(), () => false)) return d;
    if (path.dirname(d) === d) return null;
  }
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  const usage = () => { deps.err(USAGE); return 2; };
  switch (command) {
    case 'check': {
      const json = rest.includes('--json'), restamp = rest.includes('--restamp'), strict = rest.includes('--strict');
      const args = rest.filter(a => a !== '--json' && a !== '--restamp' && a !== '--strict');
      if (json && restamp) { deps.err('--restamp cannot be combined with --json'); return 2; }
      if (strict && restamp) { deps.err('--restamp cannot be combined with --strict'); return 2; }
      let depth: number | null = null;
      const at = args.indexOf('--depth');
      if (at >= 0) {
        if (!/^[0-6]$/.test(args[at + 1] ?? '')) { deps.err('--depth needs a number from 0 to 6'); return 2; }
        depth = Number(args.splice(at, 2)[1]);
      }
      if (args.length !== 1 || args[0].startsWith('-')) return usage();
      return check(path.resolve(deps.cwd, args[0]), json, deps, depth, restamp, strict);
    }
    case 'list': return rest.length ? usage() : list(deps);
    case 'sets': {
      if (rest.length) return usage();
      for (const name of TS_EXTRACTORS) deps.out(`${name}  ${EXTRACTOR_DESCRIPTIONS[name]}`);
      for (const [name, set] of Object.entries(BUILTIN_SETS).sort(([a], [b]) => a.localeCompare(b))) deps.out(`${name}${set.preview ? '  (preview)' : ''}  ${set.description}`);
      return 0;
    }
    case 'help': if (rest.length) return usage(); deps.out(await readFile(deps.skillFile, 'utf8')); return 0;
    case '--version': case '-v': deps.out(`stingray-views ${deps.version}`); return 0;
    case '--help': case '-h': deps.out(USAGE); return 0;
    default: return usage();
  }
}

async function list(deps: CliDeps): Promise<number> {
  const root = await worktreeRoot(deps.cwd);
  if (!root) { deps.err('Not inside a git worktree or a folder with .stingray.'); return 1; }
  const views = await deps.listViews(root);
  if (!views.length) deps.out('No views yet. Create .stingray/views/<slug>.yaml (see `stingray-views help`).');
  for (const { summary: s } of views) {
    deps.out(`${s.id}  ${s.kind}  ${s.name}  ${s.file ?? ''}`);
    if (s.error) deps.out(`  error: ${s.error}`);
  }
  return views.some(v => v.summary.error) ? 1 : 0;
}

async function check(input: string, json: boolean, deps: CliDeps, depth: number | null = null, restamp = false, strict = false): Promise<number> {
  let file: string;
  try { file = await realpath(input); } catch { deps.err(`File not found: ${input}`); return 1; }
  const root = await worktreeRoot(path.dirname(file));
  if (!root || !isInside(root, file)) { deps.err(`${input} is not inside a git worktree (or a folder with .stingray).`); return 1; }
  const relFile = path.relative(root, file).split(path.sep).join('/');

  const loaded = await deps.loadViewPath(root, relFile);
  const errors = loaded.errors.length ? loaded.errors : loaded.summary.error ? [{ file: relFile, line: null, message: loaded.summary.error }] : [];
  if (!loaded.view || errors.length) {
    if (json) deps.out(JSON.stringify({ summary: loaded.summary, errors, result: null }, null, 2));
    else for (const e of errors.length ? errors : [{ file: relFile, line: null, message: 'View could not be loaded' }]) deps.out(where(e));
    return 1;
  }

  if (depth !== null) {
    if (loaded.view.layers) {
      if (depth < 1 || depth > 4) { deps.err('--depth of a layers view is 1 to 4'); return 2; }
      loaded.view = { ...loaded.view, layers: { ...loaded.view.layers, depth } };
    } else if (loaded.view.flowchart) {
      if (depth > 4) { deps.err('--depth of a flowchart view is 0 to 4'); return 2; }
      loaded.view = { ...loaded.view, flowchart: { ...loaded.view.flowchart, depth } };
    } else if (loaded.view.sequence) loaded.view = { ...loaded.view, sequence: { ...loaded.view.sequence, depth } };
    else { deps.err('--depth only applies to kind: flowchart and kind: sequence views and views with layers:'); return 2; }
  }
  const graph = await deps.openGraph(root), api = graph.api;
  let result, lagging = new Set<string>();
  try {
    result = await computeView({ ...loaded, view: loaded.view }, {
      graph: graph.status, readSource: deps.createFileProvider(root).read, sqlalchemy: () => deps.dbSchema(root), sql: () => deps.sqlSchema(root),
      evaluate: view => deps.evaluate({ view, files: deps.createFileProvider(root), graph: api, graphStatus: graph.status, grammarDir: deps.grammarDir() }),
      findSymbols: async queries => queries.map(q => {
        const s = api?.findSymbols(q.name, q.file).find(s => !q.kinds || q.kinds.includes(s.kind));
        return s ?? null;
      }),
      callees: async ids => (api ? calleesOf(api, ids) : null),
      fileSymbols: async f => api?.fileSymbols(f) ?? null,
    });
    if (restamp && graph.indexedMtime) lagging = await laggingFiles(root, result.diagnostics?.explain ?? [], graph.indexedMtime);
  } finally { graph.close?.(); }

  const d = result.diagnostics!;
  // A missing/unreadable code graph is the environment, not the view; graph-step errors with a graph are the view's.
  const failed = d.rules.some(r => r.errors.length) || (graph.api !== null && (!!d.graph?.error || !!d.flowchart?.error || !!d.layers?.error || !!d.sequence?.error));
  // --strict: after the normal output; to stderr so --json stdout stays valid JSON. The higher exit code wins.
  const review = (code: number) => {
    const n = strict ? (d.explain ?? []).filter(e => e.status === 'stale' || e.status === 'unstamped' || e.status === 'legacy').length : 0;
    if (n) deps.err(`strict: ${n} explanation${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} review`);
    return Math.max(code, n ? 1 : 0);
  };
  if (json) { deps.out(JSON.stringify({ summary: loaded.summary, result }, null, 2)); return review(failed ? 1 : 0); }

  deps.out(`${result.name} (${result.kind}) — ${relFile}`);
  deps.out(`code graph: ${graph.status.state}${graph.status.message ? ` — ${graph.status.message}` : ''}`);
  deps.out('rules:');
  if (!d.rules.length) deps.out('  (none)');
  for (const r of d.rules) {
    deps.out(`  ${r.rule} [${r.language}]  files ${r.filesScanned}  matches ${r.matches}  emitted ${r.emitted}  skipped ${r.skipped}  ${r.ms}ms`);
    for (const e of r.errors) deps.out(`    error: ${where(e)}`);
    for (const w of r.warnings) deps.out(`    warning: ${where(w)}`);
  }
  if (d.graph) {
    const g = d.graph;
    deps.out(`graph step: started ${g.started}  reached ${g.reached}  helpers ${g.helpers}${g.truncated ? '  (truncated)' : ''}${g.error ? `\n  ${graph.api ? 'error' : 'skipped'}: ${g.error}` : ''}`);
  }
  if (d.flowchart) {
    const f = d.flowchart;
    deps.out(`flowchart: start ${f.start ?? '-'}  depth ${f.depth}  functions ${f.functions}  nodes ${f.nodes}${f.truncated ? '  (truncated)' : ''}${f.error ? `\n  ${graph.api ? 'error' : 'skipped'}: ${f.error}` : ''}`);
  }
  if (d.sequence) {
    const q = d.sequence, links = Object.entries(q.links).map(([k, n]) => `${k} ${n}`).join(', ');
    deps.out(`sequence: start ${q.start ?? '-'}  depth ${q.depth}  participants ${q.participants}  functions ${q.functions}  messages ${q.messages}${links ? `  links ${links}` : ''}${q.truncated ? '  (truncated)' : ''}${q.error ? `\n  ${graph.api ? 'error' : 'skipped'}: ${q.error}` : ''}`);
  }
  if (d.layers) {
    const l = d.layers;
    deps.out(`layers: ${l.config ?? 'inferred (no .stinggraph/layers.yaml)'}  depth ${l.depth}  services ${l.services}  files ${l.files}  nodes ${l.nodes}${l.error ? `\n  ${graph.api ? 'error' : 'skipped'}: ${l.error}` : ''}`);
  }
  if (d.unresolved.length) {
    deps.out('unresolved links (edge ends matching no node id or alias; explain: keys matching no node, group, alias or symbol):');
    for (const u of d.unresolved) deps.out(`  ${u.rule}: "${u.value}" at ${u.file}:${u.line}`);
  }
  if (result.warnings.length) {
    deps.out('warnings:');
    for (const w of result.warnings.slice(0, 50)) deps.out(`  ${where(w)}`);
    if (result.warnings.length > 50) deps.out(`  … ${result.warnings.length - 50} more`);
  }
  deps.out(`scanned ${d.limits.filesScanned} files, ${d.limits.matches} matches${d.limits.truncated ? ' (truncated: a limit was hit)' : ''}`);
  deps.out('');
  deps.out(formatText(result));
  deps.out('');
  deps.out(failed ? 'FAILED: fix the errors above and run check again.' : 'OK: no errors. Check that the diagram above matches the code.');
  if (restamp && failed) { deps.err('restamp: fix the errors first; nothing was written.'); return 1; }
  if (restamp && !(await restampFile(file, relFile, d.explain ?? [], graph.api !== null, lagging, deps))) return 1;
  return review(failed ? 1 : 0);
}

/** Files of `explain:` entries changed on disk since the code graph indexed them: their line ranges may be off. */
async function laggingFiles(root: string, entries: ExplainDiagnostic[], indexedMtime: (file: string) => number | null): Promise<Set<string>> {
  const files = [...new Set(entries.flatMap(e => e.files))];
  const mtimes = await Promise.all(files.map(f => stat(path.join(root, f)).then(s => s.mtimeMs, () => null)));
  return new Set(files.filter((f, i) => mtimes[i] !== indexedMtime(f)));
}

/** `--restamp`: write the current fingerprint maps (piece key → hash) of resolved `explain:` entries into the view file,
 * replacing old string stamps and keeping comments and formatting. Needs the code graph: without it symbol-backed entries
 * cannot be fingerprinted. */
async function restampFile(file: string, relFile: string, entries: ExplainDiagnostic[], graphOpen: boolean, lagging: Set<string>, deps: CliDeps): Promise<boolean> {
  deps.out('');
  if (!entries.length) { deps.out('restamp: the view has no explain: entries.'); return true; }
  if (!graphOpen) { deps.err('restamp: needs the code graph (open the worktree in Stingray to index it); nothing was written.'); return false; }
  const doc = parseDocument(await readFile(file, 'utf8'));
  const stamped: string[] = [];
  let count = 0;
  for (const e of entries) {
    const pair = explainPair(doc, e.key);
    const changed = e.files.filter(f => lagging.has(f));
    const skip = !e.matches ? 'matches nothing in the view' : !isMap(pair?.value) ? 'entry is not a plain mapping; stamp it by hand'
      : changed.length ? `${changed.join(', ')} changed since the code graph indexed it; restamp after Stingray re-indexes`
      : e.pieces === null ? 'could not fingerprint its code' : null;
    if (skip || !isMap(pair?.value) || !e.pieces) { deps.out(`restamp: skipped "${e.key}" (${skip})`); continue; }
    const stored = pair.value.get('fingerprint');
    if (isMap(stored) && isDeepStrictEqual(stored.toJSON(), e.pieces)) continue;
    pair.value.set('fingerprint', doc.createNode(e.pieces));
    const n = Object.keys(e.pieces).length;
    count++;
    stamped.push(`restamp: stamped "${e.key}" (${n} piece${n === 1 ? '' : 's'})${e.line !== null ? ` (${relFile}:${e.line})` : ''}`,
      ...e.skipped.map(k => `restamp: "${e.key}": could not fingerprint callee ${k} (left out)`));
  }
  if (count) await writeFile(file, doc.toString({ lineWidth: 0 }));
  for (const line of stamped) deps.out(line);
  deps.out(count ? `restamp: wrote ${count} fingerprint${count === 1 ? '' : 's'} to ${relFile}` : 'restamp: all fingerprints are current.');
  return true;
}

// ---- Entry (bundled CommonJS only; tests import runCli) ----

const short = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300);

async function openGraph(root: string): Promise<OpenedGraph> {
  type Library = typeof import('@colbymchenry/codegraph');
  try {
    const m = await import('@colbymchenry/codegraph');
    const lib = 'CodeGraph' in m ? m : (m as unknown as { default: Library }).default;
    if (!lib.CodeGraph.isInitialized(root)) return { api: null, status: { state: 'unavailable', message: 'no .codegraph index in this worktree (Stingray builds it when the worktree is open)' } };
    const cg = await lib.CodeGraph.open(root, { readOnly: true });
    try {
      const { createGraphApi } = await import('../../driven/stinggraph-worker/stinggraph-api');
      return { api: createGraphApi(cg), status: { state: 'read-only', message: null }, close: () => cg.close(),
        indexedMtime: file => { try { return cg.getFile(file)?.modifiedAt ?? null; } catch { return null; } } };
    } catch (error) { cg.close(); throw error; }
  } catch (error) { return { api: null, status: { state: 'unavailable', message: `could not open the code graph: ${short(error)}` } }; }
}

async function main() {
  // Before CodeGraph is loaded (it reads these at import/open); the launcher sets them too.
  process.env.CODEGRAPH_TELEMETRY = '0'; process.env.CODEGRAPH_NO_UPDATE_CHECK = '1';
  const [{ evaluate }, { codegraphGrammarDir }, { createFileProvider }, { extractDbSchema }] = await Promise.all([
    import('../../../core/views/rules/engine'), import('../../driven/tree-sitter/grammars'), import('../../driven/fs/files'), import('../../../core/db-schema/db-schema')]);
  const { extractSqlSchema } = await import('../../../core/db-schema/sql-schema');
  let version = '';
  try { version = JSON.parse(await readFile(path.join(__dirname, '../package.json'), 'utf8')).version; } catch { /* unknown */ }
  const deps: CliDeps = {
    cwd: process.cwd(), out: text => process.stdout.write(text + '\n'), err: text => process.stderr.write(text + '\n'),
    loadViewPath, listViews: listViewFiles, evaluate, createFileProvider, openGraph, grammarDir: codegraphGrammarDir,
    dbSchema: root => extractDbSchema('cli', root, path.join(__dirname, 'tree-sitter-python.wasm')),
    sqlSchema: root => extractSqlSchema('cli', root),
    skillFile: path.join(__dirname, 'skills/stingray-views/SKILL.md'), version,
  };
  let code: number;
  try { code = await runCli(process.argv.slice(2), deps); } catch (error) { deps.err(`stingray-views: ${short(error)}`); code = 1; }
  // Exit once output is flushed: an open CodeGraph or tree-sitter handle must not keep the CLI alive.
  process.stdout.write('', () => process.exit(code));
}

if (typeof require !== 'undefined' && require.main === module) void main();
