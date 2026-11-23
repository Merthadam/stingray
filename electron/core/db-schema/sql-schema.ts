// Static SQL extraction from DDL files and literal strings. Repository code is never executed.
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Language, Parser, type Node } from 'web-tree-sitter';
import type { DbBaseGroup, DbSchemaResult, DbWarning } from '../../../shared/contracts/db-schema';
import { applySqlConstraints, parseSqlDdl, sameSqlName } from './sql-ddl';
import { codegraphGrammarDir, GRAMMAR_FILES, initTreeSitter } from '../../adapters/driven/tree-sitter/grammars';

const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'site-packages', 'dist', 'dist-electron', 'build']);
const MAX_ENTRIES = 20000, MAX_FILES = 5000, MAX_FILE_BYTES = 1024 * 1024, MAX_WARNINGS = 200;
export const isSqlSource = (file: string) => /\.(sql|ts|tsx|js|mjs|cjs|py)$/i.test(file);
const PREFILTER = /\b(?:create\s+(?:(?:temp|temporary)\s+)?table|alter\s+table)\b/i;

/** Decode literal escapes without evaluation, retaining a source line for every decoded character. */
function literal(text: string, startLine: number, python: boolean): { sql: string; lines: number[] } | null {
  const match = text.match(python ? /^([rubf]*)("""|'''|"|')/i : /^()(["'`])/);
  if (!match) return null;
  const quote = match[2], raw = /r/i.test(match[1]);
  const body = text.slice(match[0].length, -quote.length);
  let sql = '', line = startLine;
  const lines: number[] = [];
  const append = (value: string) => { sql += value; for (let i = 0; i < value.length; i++) lines.push(line); };
  for (let i = 0; i < body.length; i++) {
    let c = body[i];
    if (c === '\n') { line++; append(c); continue; }
    if (c !== '\\' || raw || i + 1 === body.length) { append(c); continue; }
    c = body[++i];
    if (c === '\n') { line++; continue; }
    const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
    const count = c === 'x' ? 2 : c === 'u' ? 4 : python && c === 'U' ? 8 : 0;
    if (count && new RegExp(`^[0-9a-f]{${count}}$`, 'i').test(body.slice(i + 1, i + count + 1))) {
      const code = parseInt(body.slice(i + 1, i + count + 1), 16);
      append(code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd'); i += count;
    } else append(escapes[c] ?? (python && !['\\', "'", '"'].includes(c) ? '\\' + c : c));
  }
  return { sql, lines };
}

export async function extractSqlSchema(workspaceId: string, root: string, grammarDir = codegraphGrammarDir()): Promise<DbSchemaResult> {
  const warnings: DbWarning[] = [], groups: DbBaseGroup[] = [], files: string[] = [];
  const warn = (file: string, line: number | null, message: string) => { if (warnings.length < MAX_WARNINGS) warnings.push({ file, line, message }); };
  let entries = 0, filesScanned = 0, filesParsed = 0, truncated = false;
  const pending = [''];
  walk: while (pending.length) {
    const dir = pending.pop()!;
    let dirents;
    try { dirents = await readdir(path.join(root, dir), { withFileTypes: true }); }
    catch (error) { if (!dir) throw error; warn(dir, null, `Could not read directory: ${(error as Error).message}`); continue; }
    dirents.sort((a, b) => a.name < b.name ? 1 : -1);
    for (const d of dirents) {
      if (++entries > MAX_ENTRIES) { truncated = true; break walk; }
      const file = dir ? `${dir}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!d.name.startsWith('.') && !SKIP_DIRS.has(d.name)) pending.push(file); continue; }
      if (!d.isFile() || !isSqlSource(file)) continue;
      if (files.length === MAX_FILES) { truncated = true; break walk; }
      files.push(file);
    }
  }
  const parsers = new Map<string, Parser>();
  const parse = (sql: string, file: string, lines?: number[]) => {
    const result = parseSqlDdl(sql, file, 1, lines);
    for (const w of result.warnings) warn(file, w.line, w.message);
    for (const op of result.operations) {
      const groupId = `sql:${file}`;
      if (op.kind === 'create') {
        let group = groups.find(g => g.id === groupId);
        if (!group) { group = { id: groupId, name: file, file, line: op.table.line, tables: [] }; groups.push(group); }
        const existing = group.tables.find(t => t.fullName === op.table.fullName);
        if (existing) { if (!op.ifNotExists) warn(file, op.table.line, `Duplicate CREATE TABLE ${op.table.fullName}; keeping the first definition`); continue; }
        group.tables.push(op.table);
      } else {
        const candidates = [...groups.filter(g => g.id === groupId), ...groups.filter(g => g.id !== groupId)];
        const tables = candidates.flatMap(g => g.tables);
        const table = tables.find(t => t.fullName === op.table) ?? tables.find(t => sameSqlName(t.fullName, op.table));
        if (!table) { warn(file, op.line, `ALTER TABLE ${op.table}: table not found`); continue; }
        for (const column of op.columns) {
          if (table.columns.some(c => c.name === column.name)) warn(file, column.line, `Duplicate column ${column.name} on ${table.fullName}`);
          else table.columns.push(column);
        }
        try { applySqlConstraints(table, op.constraints); }
        catch (error) { warn(file, op.line, (error as Error).message); }
      }
    }
  };
  try {
    for (const file of files.sort()) {
      let source: string;
      try {
        const handle = await open(path.join(root, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) continue;
          if (stat.size > MAX_FILE_BYTES) { truncated = true; warn(file, null, 'Skipped: file is larger than 1 MiB.'); continue; }
          source = (await handle.readFile()).toString('utf8');
        } finally { await handle.close(); }
      } catch (error) { warn(file, null, `Could not read file: ${(error as Error).message}`); continue; }
      filesScanned++;
      if (file.toLowerCase().endsWith('.sql')) { filesParsed++; parse(source, file); continue; }
      if (!PREFILTER.test(source)) continue;
      const ext = path.extname(file).toLowerCase(), language = ext === '.py' ? 'python' : ext === '.tsx' ? 'tsx' : ext === '.ts' ? 'typescript' : 'javascript';
      try {
        let parser = parsers.get(language);
        if (!parser) {
          await initTreeSitter();
          const grammar = await Language.load(path.join(grammarDir, GRAMMAR_FILES[language]));
          parser = new Parser(); parser.setLanguage(grammar); parsers.set(language, parser);
        }
        const tree = parser.parse(source);
        if (!tree) { warn(file, null, 'Could not parse source'); continue; }
        filesParsed++;
        try {
          const visit = (node: Node) => {
            if (node.type === 'string' || node.type === 'template_string' || node.type === 'concatenated_string') {
              if (!PREFILTER.test(node.text)) return;
              // Python implicit concatenation ("CREATE TABLE t (" "id INT)") is one SQL value.
              const parts = node.type === 'concatenated_string' ? node.namedChildren.filter(c => c?.type === 'string') : [node];
              if (parts.some(p => p?.namedChildren.some(c => c?.type === 'template_substitution' || c?.type === 'interpolation'))) {
                warn(file, node.startPosition.row + 1, 'Skipped SQL string with substitutions'); return;
              }
              const values = parts.map(p => p && literal(p.text, p.startPosition.row + 1, language === 'python'));
              if (values.every(v => v)) parse(values.map(v => v!.sql).join(''), file, values.flatMap(v => v!.lines));
              return;
            }
            for (const child of node.namedChildren) if (child) visit(child);
          };
          visit(tree.rootNode);
        } finally { tree.delete(); }
      } catch (error) { warn(file, null, `Could not parse source: ${(error as Error).message}`); }
    }
  } finally { for (const parser of parsers.values()) parser.delete(); }
  // Resolve only SQL groups, same file first. Explicit targetGroup preserves per-file groups in the adapter.
  for (const group of groups) for (const table of group.tables) for (const column of table.columns) for (const fk of column.foreignKeys) {
    const candidates = [group, ...groups.filter(g => g !== group)];
    let found: { group: DbBaseGroup; table: typeof table } | undefined;
    for (const g of candidates) {
      const ref = fk.referencedTable ?? '';
      const target = g.tables.find(t => t.fullName === ref) ?? g.tables.find(t => sameSqlName(t.fullName, ref)) ??
        g.tables.find(t => !ref.includes('.') && sameSqlName(t.name, ref));
      if (target) { found = { group: g, table: target }; break; }
    }
    if (!found) continue;
    fk.targetTable = found.table.fullName; fk.targetGroup = found.group.id;
    // REFERENCES t without a column targets its primary key when it is unambiguous.
    const primary = found.table.columns.filter(c => c.primaryKey), column = fk.referencedColumn ?? (primary.length === 1 ? primary[0].name : null);
    fk.referencedColumn = column && (found.table.columns.find(c => sameSqlName(c.name, column))?.name ?? column);
  }
  groups.sort((a, b) => a.id < b.id ? -1 : 1);
  for (const group of groups) group.tables.sort((a, b) => a.fullName < b.fullName ? -1 : 1);
  return { workspaceId, scannedAt: Date.now(), filesScanned, filesParsed, truncated, groups, warnings };
}
