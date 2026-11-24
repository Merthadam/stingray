// Repo-defined views: `.stingray/views/<slug>.yaml`, committed with the code so each worktree renders its own, plus the
// shared rule files they `use` (`.stingray/rules/<name>.yaml`). Files are only read (never executed) and read defensively:
// no symlinks, real directories only, regular files only, size-capped.
import * as path from '../shared/posix-path';
import type { DiagramNode, ViewKind, ViewLayout, ViewResult, ViewSummary, ViewWarning } from '../../../shared/contracts/views';
import { SLUG, YamlError, inScope, parseRuleFileYaml, parseViewYaml, type ExplainEntry } from './rules/schema';
import type { ResolvedView, SourcedRule } from './rules/types';
import { BUILTIN_SETS, TS_EXTRACTORS } from './sets';
import type { ViewFiles } from './ports';

export { inScope };
export const VIEWS_DIR = '.stingray/views', RULES_DIR = '.stingray/rules';
export const MAX_VIEW_FILE_BYTES = 64 * 1024, MAX_VIEW_FILES = 50;
export const VIEW_SLUG = SLUG;

export type BuiltinSets = Record<string, { yaml: string }>;
export interface ViewFileEntry {
  summary: ViewSummary;
  view: ResolvedView | null;
  ruleFiles: string[];        // worktree-relative rule files the view uses (also when they are invalid)
  errors: ViewWarning[];
  layout?: ViewLayout | null; // the file's `layout:`; absent/null when it has none
  explain?: ExplainEntry[];   // the file's `explain:`; absent when it has none
}

/** Builtin view of stinggraph's service layers (inferred, refined by `.stinggraph/layers.yaml`): works in any worktree. */
export const LAYERS_VIEW: ViewFileEntry & { view: ResolvedView } = {
  summary: { id: 'layers', name: 'Services', kind: 'graph', builtin: true, file: null, error: null,
    description: 'Services, modules, files and symbols of this worktree with the edges between them (Depth drills down)' },
  view: { id: 'layers', kind: 'graph', scope: { include: ['**/*'], exclude: [] }, rules: [], graph: null, flowchart: null, layers: { depth: 1 },
    builtins: [], include: [], exclude: [] },
  ruleFiles: [], errors: [],
};
const RESERVED = new Set(['database', LAYERS_VIEW.summary.id]);

const errorText = (file: string, w: ViewWarning) =>
  `${w.file !== null && w.file !== file ? `${w.file}${w.line ? `:${w.line}` : ''}: ` : w.line ? `line ${w.line}: ` : ''}${w.message}`;
const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as { code?: string })?.code ?? '');

/** Whether every directory of the worktree-relative `dir` is a real directory (symlinked ones are ignored). */
async function realDir(files: ViewFiles, root: string, dir: string): Promise<boolean> {
  const parts = dir.split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    try { if ((await files.kind(root, parts.slice(0, i).join('/'))) !== 'directory') return false; }
    catch (error) { if (isMissing(error)) return false; throw error; }
  }
  return true;
}

const yamlWarning = (error: unknown, file: string | null): ViewWarning =>
  error instanceof YamlError ? { file: error.file, line: error.line, message: error.message } : { file, line: null, message: (error as Error).message };

/** Resolve `use` names: TypeScript extractors, builtin YAML sets, then `.stingray/rules/<name>.yaml` (builtins win). */
async function resolveUse(files: ViewFiles, root: string, use: { name: string; line: number | null }[], file: string, sets: BuiltinSets) {
  const rules: SourcedRule[] = [], builtins: string[] = [], ruleFiles: string[] = [], errors: ViewWarning[] = [];
  for (const { name, line } of use) {
    if ((TS_EXTRACTORS as readonly string[]).includes(name)) { builtins.push(name); continue; }
    if (Object.hasOwn(sets, name)) {
      try { rules.push(...parseRuleFileYaml(sets[name].yaml, null, name, `builtin/${name}`).rules); }
      catch (error) { errors.push({ file, line, message: `Builtin set "${name}" is invalid: ${yamlWarning(error, null).message}` }); }
      continue;
    }
    const rel = `${RULES_DIR}/${name}.yaml`;
    let read: { text: string } | { error: string } | null = null;
    if (await realDir(files, root, RULES_DIR)) {
      try { read = await files.readBounded(root, rel, 'Rule file'); } catch (error) { if (!isMissing(error)) read = { error: `Could not read: ${(error as Error).message}` }; }
    }
    ruleFiles.push(rel); // also when missing: creating it must refresh the view
    if (!read) { errors.push({ file, line, message: `Unknown set "${name}": not a builtin set and no ${rel}` }); continue; }
    if ('error' in read) { errors.push({ file: rel, line: null, message: read.error }); continue; }
    try { rules.push(...parseRuleFileYaml(read.text, rel, name, `rules/${name}`).rules); } catch (error) { errors.push(yamlWarning(error, rel)); }
  }
  return { rules, builtins, ruleFiles, errors };
}

/** Load one view file (worktree-relative `file`, already known to be inside real directories) named `<slug>.yaml`. */
async function loadView(files: ViewFiles, root: string, file: string, sets: BuiltinSets): Promise<ViewFileEntry> {
  const fileName = path.basename(file), slug = fileName.replace(/\.yaml$/, '');
  const summary: ViewSummary = { id: slug, name: slug, kind: 'tables' as ViewKind, description: '', builtin: false, file, error: null };
  // A file whose name is not a usable slug is listed under its file name as id (e.g. "database.yaml"); that id contains a
  // dot, so it can never collide with a slug or the builtin view.
  const fail = (errors: ViewWarning[], ruleFiles: string[] = [], id = slug): ViewFileEntry =>
    ({ summary: { ...summary, id, error: errorText(file, errors[0]!) }, view: null, ruleFiles, errors });
  if (!fileName.endsWith('.yaml') || !VIEW_SLUG.test(slug)) return fail([{ file, line: null, message: 'File name must be <slug>.yaml with a slug of 1-64 characters a-z, 0-9 or "-"' }], [], fileName);
  if (RESERVED.has(slug)) return fail([{ file, line: null, message: `"${slug}" is reserved for the builtin view; rename the file` }], [], fileName);
  let read;
  try { read = await files.readBounded(root, file, 'View file'); } catch (error) { return fail([{ file, line: null, message: `Could not read view file: ${(error as Error).message}` }]); }
  if ('error' in read) return fail([{ file, line: null, message: read.error }]);
  let definition;
  try { definition = parseViewYaml(read.text, file); } catch (error) { return fail([yamlWarning(error, file)]); }
  const use = await resolveUse(files, root, definition.use, file, sets);
  const named = { ...summary, name: definition.name, kind: definition.kind, description: definition.description };
  if (use.errors.length) return { ...fail(use.errors, use.ruleFiles), summary: { ...named, error: errorText(file, use.errors[0]!) } };
  return {
    summary: named, ruleFiles: use.ruleFiles, errors: [], layout: definition.layout, ...(definition.explain.length ? { explain: definition.explain } : {}),
    view: {
      id: slug, kind: definition.kind, scope: definition.scope, rules: [...use.rules, ...definition.rules], graph: definition.graph, flowchart: definition.flowchart, layers: definition.layers,
      ...(definition.sequence ? { sequence: definition.sequence } : {}),
      builtins: use.builtins, include: definition.include, exclude: definition.exclude,
    },
  };
}

const safeLoad = (files: ViewFiles, root: string, file: string, sets: BuiltinSets) =>
  loadView(files, root, file, sets).catch((error): ViewFileEntry => {
    const errors = [{ file, line: null, message: `Could not read view file: ${(error as Error).message}` }];
    return { summary: { id: path.basename(file), name: path.basename(file), kind: 'tables', description: '', builtin: false, file, error: errors[0].message }, view: null, ruleFiles: [], errors };
  });

/** All view files of a worktree, sorted by file name. Only the first MAX_VIEW_FILES `.yaml` files are loaded. */
export async function listViewFiles(files: ViewFiles, root: string, sets: BuiltinSets = BUILTIN_SETS): Promise<ViewFileEntry[]> {
  if (!(await realDir(files, root, VIEWS_DIR))) return [];
  const fileNames = (await files.list(root, VIEWS_DIR))
    .filter(d => d.name.endsWith('.yaml') && !d.directory).map(d => d.name).sort().slice(0, MAX_VIEW_FILES);
  return Promise.all(fileNames.map(name => safeLoad(files, root, `${VIEWS_DIR}/${name}`, sets)));
}

/** One view file by slug; null when there is no such file. */
export async function readViewFile(files: ViewFiles, root: string, slug: string, sets: BuiltinSets = BUILTIN_SETS): Promise<ViewFileEntry | null> {
  if (!VIEW_SLUG.test(slug) || RESERVED.has(slug) || !(await realDir(files, root, VIEWS_DIR))) return null;
  try { await files.kind(root, `${VIEWS_DIR}/${slug}.yaml`); } catch (error) { if (isMissing(error)) return null; throw error; }
  return loadView(files, root, `${VIEWS_DIR}/${slug}.yaml`, sets);
}

/** Any `.yaml` view file inside the worktree (for `stingray-views check`); the slug comes from its file name. */
export async function loadViewPath(files: ViewFiles, root: string, relFile: string, sets: BuiltinSets = BUILTIN_SETS): Promise<ViewFileEntry> {
  const file = files.relative(root, relFile);
  const fail = (message: string): ViewFileEntry => ({ summary: { id: path.basename(file), name: path.basename(file), kind: 'tables',
    description: '', builtin: false, file, error: message }, view: null, ruleFiles: [], errors: [{ file, line: null, message }] });
  if (!file || file.startsWith('../') || file === '..' || path.isAbsolute(file)) return fail('View file must be inside the worktree');
  if (!(await realDir(files, root, path.dirname(file)))) return fail('View file must be in a real directory of the worktree (symlinks are not followed)');
  return safeLoad(files, root, file, sets);
}

/** Narrow the database view to a `tables` view's membership (scope, include, exclude). Pure. */
export function tablesView(database: ViewResult, summary: ViewSummary, view: ResolvedView): ViewResult {
  const include = new Set(view.include), exclude = new Set(view.exclude);
  const named = (n: DiagramNode, set: Set<string>) => set.has(n.label) || (n.subtitle !== null && set.has(n.subtitle));
  const nodes = database.nodes.filter(n => !named(n, exclude) && (named(n, include) || (n.source !== null && inScope(n.source.file, view.scope))));
  const ids = new Set(nodes.map(n => n.id));
  const edges = database.edges.filter(e => ids.has(e.from) && ids.has(e.to));
  const groups = new Set(nodes.map(n => n.group));
  return {
    ...database, ...summary, nodes, edges,
    groups: database.groups.filter(g => groups.has(g.id)),
    warnings: database.warnings.filter(w => w.file === null || inScope(w.file, view.scope)),
    stats: { ...database.stats, tables: nodes.length,
      foreignKeys: edges.filter(e => e.kind === 'foreign-key').length, relationships: edges.filter(e => e.kind === 'relationship').length },
  };
}
