// Static SQLAlchemy schema extraction for the Database tab.
// Python source is only read and parsed with tree-sitter; repository code is never executed.
import type { Node, Parser } from 'web-tree-sitter';
import { syntaxParser } from '../shared/ports';
import type { SchemaFiles } from './ports';
import type { DbBaseGroup, DbColumn, DbRelationship, DbSchemaResult, DbTable, DbWarning } from '../../../shared/contracts/db-schema';

const MAX_WARNINGS = 200;
// __init__.py is always parsed so package re-exports (`from .base import Base`) resolve.
const PREFILTER = /sqlalchemy|__tablename__|\.Model\b/;

interface BaseDecl { line: number; flask: boolean }
interface PyClass {
  name: string; line: number; supers: string[]; tableName: string | null; abstract: boolean; schema: string | null;
  columns: DbColumn[]; relationships: DbRelationship[];
}
interface PyFile {
  file: string; module: string; imports: Map<string, string>; classes: Map<string, PyClass>; bases: Map<string, BaseDecl>;
}
interface Sym { file: PyFile; name: string }

let parserPromise: Promise<Parser> | undefined;
function loadParser(grammarPath: string): Promise<Parser> {
  return parserPromise ??= syntaxParser().loadLanguage(grammarPath).then(language => syntaxParser().parser(language))
    .catch(error => { parserPromise = undefined; throw error; });
}

const text = (n: Node | null | undefined) => n?.text ?? '';
const named = (n: Node | null | undefined) => (n?.namedChildren ?? []).filter((c): c is Node => !!c && c.type !== 'comment');
const lineOf = (n: Node) => n.startPosition.row + 1;
function literal(n: Node | null | undefined): string | null {
  if (n?.type !== 'string' || named(n).some(c => c.type === 'interpolation')) return null;
  return text(n).match(/^(['"])([^\\\n'"]*)\1$/)?.[2] ?? null;
}
const args = (call: Node | null | undefined) => named(call?.childForFieldName('arguments'));
const positional = (call: Node | null | undefined) => args(call).filter(a => a.type !== 'keyword_argument');
function kwargs(call: Node | null | undefined): Map<string, Node | null> {
  return new Map(args(call).filter(a => a.type === 'keyword_argument').map(a => [text(a.childForFieldName('name')), a.childForFieldName('value')]));
}
function bool(n: Node | null | undefined, fallback: boolean | null): boolean | null {
  if (n === undefined) return fallback;
  return n?.type === 'true' ? true : n?.type === 'false' ? false : null;
}
// The callee's last dotted segment: matches `Column`, `sa.Column`, `db.Column`, `orm.mapped_column`.
const callee = (n: Node | null | undefined) => n?.type === 'call' ? text(n.childForFieldName('function')).split('.').at(-1)! : '';
const short = (s: string) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 80 ? t.slice(0, 79) + '…' : t; };
const stripModules = (s: string) => s.replace(/(?<![\w"'])(?:[A-Za-z_]\w*\.)+(?=[A-Za-z_])/g, '');

function moduleName(file: string): string {
  const parts = file.replace(/\.py$/, '').split('/');
  if (parts.at(-1) === '__init__') parts.pop();
  return parts.join('.');
}

function readImports(stmt: Node, module: string, isPackage: boolean, imports: Map<string, string>) {
  if (stmt.type === 'import_statement') {
    for (const n of stmt.childrenForFieldName('name')) {
      if (n?.type === 'aliased_import') imports.set(text(n.childForFieldName('alias')), text(n.childForFieldName('name')));
      else if (n) imports.set(text(n).split('.')[0]!, text(n).split('.')[0]!);
    }
    return;
  }
  const source = stmt.childForFieldName('module_name');
  let from = text(source);
  if (source?.type === 'relative_import') {
    const dots = text(named(source).find(c => c.type === 'import_prefix')).length;
    const pkg = module.split('.').filter(Boolean).slice(0, isPackage ? undefined : -1);
    const tail = text(named(source).find(c => c.type === 'dotted_name'));
    from = [...pkg.slice(0, pkg.length - (dots - 1)), ...(tail ? [tail] : [])].join('.');
  }
  for (const n of stmt.childrenForFieldName('name')) {
    if (!n) continue;
    const name = n.type === 'aliased_import' ? text(n.childForFieldName('name')) : text(n);
    const alias = n.type === 'aliased_import' ? text(n.childForFieldName('alias')) : name;
    imports.set(alias, from ? from + '.' + name : name);
  }
}

function inferType(annotation: string): string | null {
  const inner = annotation.match(/^(?:[\w.]+\.)?Mapped\s*\[([\s\S]*)\]$/)?.[1]?.replace(/^(["'])(.*)\1$/, '$2')
    .replace(/^(?:typing\.)?Optional\s*\[([\s\S]*)\]$/, '$1').replace(/\s*\|\s*None\b|\bNone\s*\|\s*/g, '').trim();
  if (!inner) return null;
  const known: Record<string, string> = { str: 'String', int: 'Integer', bool: 'Boolean', float: 'Float', bytes: 'LargeBinary',
    'uuid.UUID': 'Uuid', UUID: 'Uuid', datetime: 'DateTime', 'datetime.datetime': 'DateTime', date: 'Date', 'datetime.date': 'Date',
    Decimal: 'Numeric', 'decimal.Decimal': 'Numeric', dict: 'JSON' };
  return known[inner] ?? short(inner);
}

function relationshipAnnotation(annotation: string): { target: string | null; collection: boolean | null } {
  let inner = annotation.match(/^(?:[\w.]+\.)?Mapped\s*\[([\s\S]*)\]$/)?.[1]?.trim();
  if (!inner) return { target: null, collection: null };
  inner = inner.replace(/^(["'])(.*)\1$/, '$2').replace(/^(?:typing\.)?Optional\s*\[([\s\S]*)\]$/, '$1').replace(/\s*\|\s*None$/, '').trim();
  const many = inner.match(/^(?:typing\.)?(?:list|List|set|Set)\s*\[([\s\S]*)\]$/);
  if (many) inner = many[1]!.trim();
  const target = inner.match(/^(["']?)([A-Za-z_][\w.]*)\1$/)?.[2]?.split('.').at(-1) ?? null;
  return { target, collection: !!many };
}

function readClass(cls: Node, imports: Map<string, string>, file: PyFile) {
  const name = text(cls.childForFieldName('name'));
  const supers = named(cls.childForFieldName('superclasses')).filter(s => s.type === 'identifier' || s.type === 'attribute').map(text);
  const canonical = (ref: string) => { const [head, ...rest] = ref.split('.'); return [imports.get(head!) ?? head, ...rest].join('.'); };
  const c: PyClass = { name, line: lineOf(cls), supers, tableName: null, abstract: false, schema: null, columns: [], relationships: [] };
  if (supers.some(s => /^sqlalchemy\..*\.DeclarativeBase(NoMeta)?$/.test(canonical(s)))) file.bases.set(name, { line: c.line, flask: false });
  for (const stmt of named(cls.childForFieldName('body'))) {
    const a = stmt.type === 'expression_statement' ? named(stmt)[0] : null;
    if (a?.type !== 'assignment' || a.childForFieldName('left')?.type !== 'identifier') continue;
    const attr = text(a.childForFieldName('left')), value = a.childForFieldName('right');
    // Collapsing whitespace once keeps every later annotation regex linear.
    const annotation = text(a.childForFieldName('type')).replace(/\s+/g, ' ');
    if (attr === '__tablename__') c.tableName = literal(value);
    else if (attr === '__abstract__') c.abstract = value?.type === 'true';
    else if (attr === '__table_args__') {
      const dicts = value?.type === 'dictionary' ? [value] : named(value).filter(n => n.type === 'dictionary');
      for (const pair of dicts.flatMap(named)) if (literal(pair.childForFieldName('key')) === 'schema') c.schema = literal(pair.childForFieldName('value'));
    } else if (attr.startsWith('__')) continue;
    else if (callee(value) === 'relationship') {
      const kw = kwargs(value), explicit = positional(value)[0] ?? kw.get('argument');
      const fromAnnotation = relationshipAnnotation(annotation);
      const target = explicit ? (literal(explicit) ?? (explicit.type === 'identifier' ? text(explicit) : null))?.split('.').at(-1) ?? null : fromAnnotation.target;
      const secondary = kw.get('secondary');
      c.relationships.push({ name: attr, targetModel: target, targetTable: null,
        collection: bool(kw.get('uselist'), annotation ? fromAnnotation.collection : null), backPopulates: literal(kw.get('back_populates')),
        secondary: secondary ? literal(secondary) ?? short(text(secondary)) : null, line: lineOf(a) });
    } else if (['mapped_column', 'Column'].includes(callee(value)) || (!value && /^(?:[\w.]+\.)?Mapped\s*\[/.test(annotation))) {
      const kw = kwargs(value), p = positional(value);
      const typeNode = p.find(n => n.type !== 'string' && callee(n) !== 'ForeignKey');
      const primaryKey = bool(kw.get('primary_key'), false) === true;
      const optional = /Optional\[|\|\s*None\b|\bNone\s*\|/.test(annotation);
      c.columns.push({
        name: literal(p[0]) ?? attr, attribute: attr,
        type: typeNode ? short(stripModules(text(typeNode))) : inferType(annotation),
        primaryKey,
        nullable: bool(kw.get('nullable'), primaryKey ? false : optional ? true : !/Mapped\s*\[/.test(annotation)),
        unique: bool(kw.get('unique'), false),
        foreignKeys: p.filter(n => callee(n) === 'ForeignKey').map(fk => {
          const target = positional(fk)[0];
          return { target: literal(target) ?? text(target), targetTable: null, ondelete: literal(kwargs(fk).get('ondelete')) };
        }),
        inheritedFrom: null, line: lineOf(a),
      });
    }
  }
  file.classes.set(name, c);
}

function readFile(root: Node, file: PyFile) {
  const isPackage = file.file.endsWith('__init__.py');
  for (let stmt of named(root)) {
    if (stmt.type === 'decorated_definition') stmt = stmt.childForFieldName('definition') ?? stmt;
    if (stmt.type === 'import_statement' || stmt.type === 'import_from_statement') readImports(stmt, file.module, isPackage, file.imports);
    else if (stmt.type === 'class_definition') readClass(stmt, file.imports, file);
    else if (stmt.type === 'expression_statement') {
      const a = named(stmt)[0];
      const fn = text(a?.childForFieldName('right')?.childForFieldName('function'));
      const last = fn.split('.').at(-1);
      if (a?.type !== 'assignment' || a.childForFieldName('left')?.type !== 'identifier') continue;
      if (last === 'declarative_base' || last === 'generate_base' || last === 'SQLAlchemy')
        file.bases.set(text(a.childForFieldName('left')), { line: lineOf(a), flask: last === 'SQLAlchemy' });
    }
  }
}

function firstErrorLine(n: Node): number | null {
  if (n.isError || n.isMissing) return lineOf(n);
  for (const c of n.children) if (c && (c.hasError || c.isMissing)) return firstErrorLine(c);
  return null;
}

export async function extractDbSchema(workspaceId: string, root: string, grammarPath: string, schemaFiles: SchemaFiles): Promise<DbSchemaResult> {
  const parser = await loadParser(grammarPath);
  const warnings: DbWarning[] = [];
  const warn = (file: string, line: number | null, message: string) => { if (warnings.length < MAX_WARNINGS) warnings.push({ file, line, message }); };
  const files: PyFile[] = [];
  let filesScanned = 0, filesParsed = 0;

  // The one walker (driven/fs/walk.ts): no symlinks, dot-dirs skipped, 20 000 entries, 5 000 Python files, sorted.
  const listed = await schemaFiles.list(root, rel => rel.endsWith('.py'), (dir, error) => warn(dir, null, `Could not read directory: ${error.message}`));
  const truncated = listed.truncated;
  for (const rel of listed.files) {
    let source: string;
    try {
      const read = await schemaFiles.read(root, rel);
      if ('skipped' in read) { if (read.skipped === 'tooLarge') warn(rel, null, 'Skipped: file is larger than 1 MiB.'); continue; }
      source = read.text;
    } catch (error) { warn(rel, null, `Could not read file: ${(error as Error).message}`); continue; }
    filesScanned++;
    if (!PREFILTER.test(source) && rel.split('/').at(-1) !== '__init__.py') continue;
    filesParsed++;
    await new Promise(resolve => setTimeout(resolve, 0)); // yield between files
    const tree = parser.parse(source);
    if (!tree) { warn(rel, null, 'Could not parse file.'); continue; }
    try {
      if (tree.rootNode.hasError) warn(rel, firstErrorLine(tree.rootNode), 'Syntax error; models in this file may be incomplete.');
      const file: PyFile = { file: rel, module: moduleName(rel), imports: new Map(), classes: new Map(), bases: new Map() };
      readFile(tree.rootNode, file);
      files.push(file);
    } catch (error) { warn(rel, null, `Could not extract models: ${(error as Error).message}`); }
    finally { tree.delete(); }
  }

  // Cross-file resolution: imports map to dotted module paths, matched by unique dotted suffix (handles src/ layouts).
  const byModule = new Map(files.map(f => [f.module, f]));
  const findModule = (name: string): PyFile | null => {
    const exact = byModule.get(name);
    if (exact) return exact;
    const matches = files.filter(f => f.module.endsWith('.' + name));
    return matches.length === 1 ? matches[0]! : null;
  };
  function resolve(file: PyFile, ref: string, depth = 0): Sym | null {
    if (depth > 5) return null;
    const parts = ref.split('.');
    if (parts.length === 1 && (file.classes.has(ref) || file.bases.has(ref))) return { file, name: ref };
    if (parts.length > 1 && parts.at(-1) === 'Model') { // Flask-SQLAlchemy: `db.Model` where `db = SQLAlchemy()`
      const db = resolve(file, parts.slice(0, -1).join('.'), depth);
      if (db && db.file.bases.get(db.name)?.flask) return db;
    }
    const imported = file.imports.get(parts[0]!);
    if (!imported) return null;
    const full = [imported, ...parts.slice(1)].join('.').split('.');
    for (let i = full.length - 1; i >= 1; i--) {
      const module = findModule(full.slice(0, i).join('.'));
      if (module) return resolve(module, full.slice(i).join('.'), depth + 1);
    }
    return null;
  }
  const allBases = files.flatMap(f => [...f.bases.keys()].map(name => ({ file: f, name })));

  const groups = new Map<string, DbBaseGroup>();
  const unresolved: DbBaseGroup = { id: 'unresolved', name: 'Unresolved base', file: null, line: null, tables: [] };
  interface Analysis { base: Sym | null; columns: DbColumn[]; relationships: DbRelationship[]; tableName: string | null }
  const analyses = new Map<PyClass, Analysis | 'pending'>();
  // Resolves a class's base, its effective columns and its table name. Columns come from mixins, abstract classes and
  // the declarative base; a mapped parent keeps its own columns (joined or single-table inheritance).
  function analyze(file: PyFile, cls: PyClass): Analysis | null {
    const cached = analyses.get(cls);
    if (cached) return cached === 'pending' ? null : cached;
    analyses.set(cls, 'pending');
    let base = null as Sym | null; // assigned inside visit(); the cast stops TS narrowing it to null
    const inherited: DbColumn[] = [], relationships = [...cls.relationships], unknown: string[] = [];
    const seen = new Set<PyClass>([cls]);
    const visit = (owner: PyFile, refs: string[], depth: number, collect: boolean) => {
      for (const ref of refs) {
        const sym = resolve(owner, ref);
        if (!sym) { unknown.push(ref.split('.').at(-1)!); continue; }
        const parent = sym.file.classes.get(sym.name);
        const isBase = sym.file.bases.has(sym.name);
        if (isBase) base ??= sym;
        if (!parent || seen.has(parent) || depth >= 10) continue;
        seen.add(parent);
        const mapped = !isBase && !parent.abstract && analyze(sym.file, parent)?.tableName != null;
        if (collect && !mapped) {
          inherited.push(...parent.columns.map(c => ({ ...c, foreignKeys: c.foreignKeys.map(fk => ({ ...fk })), inheritedFrom: parent.name })));
          relationships.push(...parent.relationships.map(r => ({ ...r })));
        }
        if (!isBase) visit(sym.file, parent.supers, depth + 1, collect && !mapped);
      }
    };
    visit(file, cls.supers, 0, true);
    if (!base) {
      const byName = allBases.filter(b => unknown.includes(b.name));
      if (byName.length === 1) base = byName[0]!;
    }
    // Own columns override inherited ones; among inherited columns the first (MRO-nearest) wins.
    const columns = [...cls.columns, ...inherited.filter((c, i, all) => !cls.columns.some(own => own.attribute === c.attribute)
      && all.findIndex(other => other.attribute === c.attribute) === i)];
    // Flask-SQLAlchemy names a table from the class name when a mapped class has a primary key but no __tablename__.
    const flask = !!base && base.file.bases.get(base.name)!.flask;
    const tableName = cls.abstract || file.bases.has(cls.name) ? null : cls.tableName ?? (flask && columns.some(c => c.primaryKey)
      ? cls.name.replace(/((?<=[a-z0-9])[A-Z]|(?!^)[A-Z](?=[a-z]))/g, '_$1').toLowerCase().replace(/^_+/, '') : null);
    const analysis = { base, columns, relationships, tableName };
    analyses.set(cls, analysis);
    return analysis;
  }

  for (const file of files) for (const cls of file.classes.values()) {
    if (file.bases.has(cls.name) || cls.abstract) continue;
    const analysis = analyze(file, cls);
    if (!analysis) continue;
    const { base, columns, relationships, tableName } = analysis;
    if (!tableName) {
      // A declarative model with its own key but no literal __tablename__ (e.g. a declared_attr on the base) cannot be named statically.
      if (base && cls.columns.some(c => c.primaryKey)) warn(file.file, cls.line, `${cls.name}: table name is computed at runtime; skipped.`);
      continue;
    }
    let group = unresolved;
    if (base) {
      const id = `${base.file.file}:${base.name}`;
      group = groups.get(id) ?? { id, name: base.name, file: base.file.file, line: base.file.bases.get(base.name)!.line, tables: [] };
      groups.set(id, group);
    } else warn(file.file, cls.line, `Could not resolve the declarative base of ${cls.name}.`);
    const fullName = cls.schema ? `${cls.schema}.${tableName}` : tableName;
    if (group.tables.some(t => t.fullName === fullName)) { warn(file.file, cls.line, `Duplicate table ${fullName} in ${group.name}; skipped ${cls.name}.`); continue; }
    group.tables.push({ name: tableName, schema: cls.schema, fullName, model: cls.name, file: file.file, line: cls.line, columns, relationships: relationships.map(r => ({ ...r })) } satisfies DbTable);
  }
  if (unresolved.tables.length) groups.set('unresolved', unresolved);

  // FK and relationship targets resolve only within the same base group.
  for (const group of groups.values()) {
    group.tables.sort((a, b) => a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0);
    const tables = new Set(group.tables.map(t => t.fullName));
    const byModel = (model: string) => { const m = group.tables.filter(t => t.model === model); return m.length === 1 ? m[0]!.fullName : null; };
    for (const table of group.tables) {
      for (const fk of table.columns.flatMap(c => c.foreignKeys)) {
        const owner = fk.target.split('.').slice(0, -1).join('.');
        fk.targetTable = tables.has(owner) ? owner : byModel(owner);
      }
      for (const r of table.relationships) r.targetTable = r.targetModel ? byModel(r.targetModel) : null;
    }
  }
  const sorted = [...groups.values()].sort((a, b) => a.file === null ? 1 : b.file === null ? -1
    : a.file < b.file ? -1 : a.file > b.file ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { workspaceId, scannedAt: Date.now(), filesScanned, filesParsed, truncated, groups: sorted, warnings };
}
