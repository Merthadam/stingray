// Tolerant static DDL reader. No SQL or repository code is executed.
import type { DbColumn, DbForeignKey, DbTable, DbWarning } from '../src/db-schema';

interface Token { text: string; value: string; line: number; kind: 'word' | 'identifier' | 'string' | 'symbol' }
interface Constraint { kind: 'primary' | 'unique' | 'foreign'; columns: string[]; references?: { table: string; columns: string[]; ondelete: string | null; onupdate: string | null } }
export type SqlOperation = { kind: 'create'; table: DbTable; ifNotExists: boolean } |
  { kind: 'alter'; table: string; columns: DbColumn[]; constraints: Constraint[]; file: string; line: number };

function tokenize(sql: string, startLine: number, sourceLines?: number[]): { tokens: Token[]; errors: { line: number; message: string }[] } {
  const tokens: Token[] = [], errors: { line: number; message: string }[] = [];
  let i = 0, line = startLine;
  const advance = () => { if (sql[i++] === '\n') line++; };
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { advance(); continue; }
    if (sql.startsWith('--', i)) { while (i < sql.length && sql[i] !== '\n') advance(); continue; }
    if (sql.startsWith('/*', i)) {
      const at = sourceLines?.[i] ?? line; advance(); advance();
      while (i < sql.length && !sql.startsWith('*/', i)) advance();
      if (i === sql.length) errors.push({ line: at, message: 'Unterminated SQL comment' });
      else { advance(); advance(); }
      continue;
    }
    const start = i, at = sourceLines?.[i] ?? line, quote = sql[i];
    // PostgreSQL dollar-quoted bodies ($$ ... $$, $fn$ ... $fn$) can contain semicolons.
    const dollar = quote === '$' ? sql.slice(i).match(/^\$(?:[A-Za-z_]\w*)?\$/)?.[0] : undefined;
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) errors.push({ line: at, message: 'Unterminated SQL quoted value' });
      while (i < (end < 0 ? sql.length : end + dollar.length)) advance();
      tokens.push({ text: sql.slice(start, i), value: sql.slice(start + dollar.length, end < 0 ? i : end), line: at, kind: 'string' });
    } else if (['\'', '"', '`', '['].includes(quote)) {
      const end = quote === '[' ? ']' : quote;
      advance(); let value = '', closed = false;
      while (i < sql.length) {
        if (sql[i] === end) {
          advance();
          if (sql[i] === end) { value += end; advance(); continue; }
          closed = true; break;
        }
        // MySQL backslash escapes in string literals.
        if (quote === "'" && sql[i] === '\\' && i + 1 < sql.length) { advance(); value += sql[i]; advance(); }
        else { value += sql[i]; advance(); }
      }
      if (!closed) errors.push({ line: at, message: 'Unterminated SQL quoted value' });
      tokens.push({ text: sql.slice(start, i), value, line: at, kind: quote === "'" ? 'string' : 'identifier' });
    } else if (/[\w$\u0080-\uffff]/.test(sql[i])) {
      while (i < sql.length && /[\w$\u0080-\uffff]/.test(sql[i])) advance();
      tokens.push({ text: sql.slice(start, i), value: sql.slice(start, i), line: at, kind: 'word' });
    } else { advance(); tokens.push({ text: quote, value: quote, line: at, kind: 'symbol' }); }
  }
  return { tokens, errors };
}

class Reader {
  i = 0;
  constructor(readonly tokens: Token[]) {}
  peek(word: string) { const t = this.tokens[this.i]; return t?.kind !== 'identifier' && t?.kind !== 'string' && t?.value.toUpperCase() === word; }
  take(word: string) { if (!this.peek(word)) return false; this.i++; return true; }
  expect(word: string) { if (!this.take(word)) throw new Error(`Expected ${word}`); }
  name(): string {
    const t = this.tokens[this.i++];
    if (!t || !['word', 'identifier'].includes(t.kind)) throw new Error('Expected identifier');
    return t.value;
  }
  qualified(): string { let name = this.name(); while (this.take('.')) name += '.' + this.name(); return name; }
  // Each entry's leading name; ASC/DESC, COLLATE and MySQL prefix lengths after it are ignored.
  list(): string[] { return split(this.block(), ',').map(part => new Reader(part).name()); }
  block(): Token[] {
    this.expect('('); const start = this.i; let depth = 1;
    while (this.i < this.tokens.length) {
      if (this.peek('(')) depth++;
      if (this.peek(')') && --depth === 0) return this.tokens.slice(start, this.i++);
      // Only closing parentheses decrease depth.
      this.i++;
    }
    throw new Error('Unclosed parentheses');
  }
}
function split(tokens: Token[], separator: string): Token[][] {
  const parts: Token[][] = []; let start = 0, depth = 0;
  tokens.forEach((t, i) => {
    if (t.kind === 'symbol') {
      if (t.value === '(') depth++;
      if (t.value === ')') depth--;
      if (t.value === separator && depth === 0) { parts.push(tokens.slice(start, i)); start = i + 1; }
    }
  });
  if (start < tokens.length) parts.push(tokens.slice(start));
  return parts;
}
function reference(r: Reader): NonNullable<Constraint['references']> {
  const table = r.qualified(), columns = r.peek('(') ? r.list() : [];
  let ondelete: string | null = null, onupdate: string | null = null;
  while (r.i < r.tokens.length) {
    if (r.take('ON')) {
      const action = r.name().toUpperCase(); let value = r.name().toUpperCase();
      if (value === 'SET' || value === 'NO') value += ' ' + r.name().toUpperCase();
      if (action === 'DELETE') ondelete = value;
      if (action === 'UPDATE') onupdate = value;
    } else if (r.take('MATCH')) r.name();
    else break;
  }
  return { table, columns, ondelete, onupdate };
}
function foreignKey(ref: NonNullable<Constraint['references']>, index: number): DbForeignKey {
  return { target: ref.table + (ref.columns[index] ? '.' + ref.columns[index] : ''), targetTable: null,
    ondelete: ref.ondelete, onupdate: ref.onupdate, referencedTable: ref.table, referencedColumn: ref.columns[index] ?? null };
}
const CONSTRAINTS = new Set(['PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'DEFAULT', 'CHECK', 'COLLATE', 'AUTOINCREMENT', 'AUTO_INCREMENT', 'GENERATED', 'REFERENCES', 'CONSTRAINT']);
function definition(tokens: Token[], file: string): { column?: DbColumn; constraint?: Constraint } {
  const r = new Reader(tokens);
  if (r.take('CONSTRAINT')) r.name();
  if (r.take('PRIMARY')) { r.expect('KEY'); return { constraint: { kind: 'primary', columns: r.list() } }; }
  if (r.take('UNIQUE')) { r.take('KEY') || r.take('INDEX'); if (!r.peek('(')) r.name(); return { constraint: { kind: 'unique', columns: r.list() } }; }
  if (r.take('FOREIGN')) {
    r.expect('KEY'); if (!r.peek('(')) r.name(); const columns = r.list(); r.expect('REFERENCES');
    const references = reference(r);
    if (references.columns.length && references.columns.length !== columns.length) throw new Error('Foreign key column counts differ');
    return { constraint: { kind: 'foreign', columns, references } };
  }
  if (r.take('CHECK')) { r.block(); return {}; }
  // MySQL secondary indexes are not columns; `key VARCHAR(255)` is (index lists start with a name, not a number).
  if ((r.peek('FULLTEXT') || r.peek('SPATIAL')) && /^(KEY|INDEX)$/i.test(tokens[r.i + 1]?.value ?? '')) r.i++;
  const open = tokens[r.i + 1]?.text === '(' ? r.i + 1 : tokens[r.i + 2]?.text === '(' ? r.i + 2 : -1, first = tokens[open + 1];
  if ((r.peek('KEY') || r.peek('INDEX')) && open >= 0 && first && ['word', 'identifier'].includes(first.kind) && !/^\d/.test(first.value)) return {};
  const name = r.name(), typeStart = r.i;
  while (r.i < tokens.length && !(tokens[r.i].kind === 'word' && CONSTRAINTS.has(tokens[r.i].value.toUpperCase()))) {
    if (r.peek('(')) r.block(); else r.i++;
  }
  const type = tokens.slice(typeStart, r.i).map(t => t.text).join(' ').replace(/\s*([(),])\s*/g, '$1') || null;
  const column: DbColumn = { name, attribute: name, type, primaryKey: false, nullable: null, unique: null,
    foreignKeys: [], inheritedFrom: null, file, line: tokens[0].line };
  while (r.i < tokens.length) {
    if (r.take('PRIMARY')) { r.expect('KEY'); column.primaryKey = true; }
    else if (r.take('NOT')) { r.expect('NULL'); column.nullable = false; }
    else if (r.take('NULL')) column.nullable = true;
    else if (r.take('UNIQUE')) column.unique = true;
    else if (r.take('REFERENCES')) column.foreignKeys.push(foreignKey(reference(r), 0));
    else if (r.take('CONSTRAINT') || r.take('COLLATE')) r.name();
    else if (r.take('DEFAULT')) {
      if (r.peek('(')) r.block();
      else { if (r.peek('-') || r.peek('+')) r.i++; if (r.i >= tokens.length) throw new Error('Missing DEFAULT expression'); r.i++; if (r.peek('(')) r.block(); }
    } else if (r.take('CHECK')) r.block();
    else if (r.take('GENERATED')) {
      // GENERATED {ALWAYS | BY DEFAULT} AS (expr) [STORED] or AS IDENTITY [(options)]; later constraints still apply.
      while (['ALWAYS', 'BY', 'DEFAULT', 'AS'].some(w => r.take(w))) { /* keywords only */ }
      if (r.peek('(')) { r.block(); r.take('STORED') || r.take('VIRTUAL'); }
    } else if (r.peek('(')) r.block();
    else r.i++;
  }
  if (column.primaryKey) column.nullable = false;
  return { column };
}
// Unquoted SQL identifiers are case-insensitive; exact matches win.
export const sameSqlName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function applySqlConstraints(table: DbTable, constraints: Constraint[]) {
  for (const constraint of constraints) constraint.columns.forEach((name, i) => {
    const column = table.columns.find(c => c.name === name) ?? table.columns.find(c => sameSqlName(c.name, name));
    if (!column) throw new Error(`Constraint column ${name} not found on ${table.fullName}`);
    if (constraint.kind === 'primary') { column.primaryKey = true; column.nullable = false; }
    if (constraint.kind === 'unique' && constraint.columns.length === 1) column.unique = true;
    if (constraint.references) column.foreignKeys.push(foreignKey(constraint.references, i));
  });
}

/** Parse independently of filesystem/grammars. Operations preserve statement order; malformed DDL is diagnosed. */
export function parseSqlDdl(sql: string, file = '', startLine = 1, sourceLines?: number[]): { operations: SqlOperation[]; warnings: DbWarning[] } {
  const { tokens, errors } = tokenize(sql, startLine, sourceLines);
  const warnings: DbWarning[] = errors.slice(0, 200).map(e => ({ file, ...e })), operations: SqlOperation[] = [];
  // Semicolons delimit statements even after a malformed unclosed parenthesis, allowing recovery.
  const statements: Token[][] = []; let start = 0;
  tokens.forEach((t, i) => { if (t.kind === 'symbol' && t.value === ';') { statements.push(tokens.slice(start, i)); start = i + 1; } });
  statements.push(tokens.slice(start));
  for (const statement of statements) {
    if (!statement.length) continue;
    const r = new Reader(statement);
    try {
      if (r.take('CREATE')) {
        r.take('TEMP') || r.take('TEMPORARY');
        if (!r.take('TABLE')) continue;
        const ifNotExists = r.take('IF'); if (ifNotExists) { r.expect('NOT'); r.expect('EXISTS'); }
        const fullName = r.qualified(), parts = fullName.split('.');
        // CREATE TABLE ... AS SELECT / PARTITION OF / OF type declare no columns of their own.
        if (r.peek('AS') || r.peek('PARTITION') || r.peek('OF')) continue;
        const table: DbTable = { name: parts.pop()!, schema: parts.join('.') || null, fullName, model: fullName, file,
          line: statement[0].line, columns: [], relationships: [] };
        const constraints: Constraint[] = [];
        for (const part of split(r.block(), ',')) {
          const def = definition(part, file); if (def.column) table.columns.push(def.column); if (def.constraint) constraints.push(def.constraint);
        }
        if (!table.columns.length) throw new Error('CREATE TABLE has no columns');
        applySqlConstraints(table, constraints);
        operations.push({ kind: 'create', table, ifNotExists });
      } else if (r.take('ALTER')) {
        r.expect('TABLE'); if (r.take('IF')) r.expect('EXISTS'); r.take('ONLY');
        const table = r.qualified(), columns: DbColumn[] = [], constraints: Constraint[] = [];
        // One statement can hold several comma-separated actions; only ADD changes the diagram.
        for (const action of split(statement.slice(r.i), ',')) {
          const a = new Reader(action);
          if (!a.take('ADD')) continue;
          a.take('COLUMN'); if (a.take('IF')) { a.expect('NOT'); a.expect('EXISTS'); }
          const def = definition(action.slice(a.i), file);
          if (def.column) columns.push(def.column); if (def.constraint) constraints.push(def.constraint);
        }
        if (columns.length || constraints.length) operations.push({ kind: 'alter', table, columns, constraints, file, line: statement[0].line });
      } else if (!['DROP', 'INSERT', 'UPDATE', 'DELETE', 'SELECT', 'WITH', 'PRAGMA', 'BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'SET', 'USE', 'DO', 'TRUNCATE', 'COMMENT', 'GRANT', 'REVOKE', 'VACUUM', 'ANALYZE', 'EXPLAIN', 'REPLACE', 'MERGE', 'CALL', 'LOCK', 'REINDEX', 'ATTACH', 'DETACH'].some(s => r.peek(s))) {
        throw new Error('Unrecognized SQL statement');
      }
    } catch (error) { if (warnings.length < 200) warnings.push({ file, line: statement[0].line, message: `Could not parse SQL: ${(error as Error).message}` }); }
  }
  return { operations, warnings };
}
