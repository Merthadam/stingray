import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractSqlSchema } from '../../electron/core/db-schema/sql-schema';
import { databaseView } from '../../shared/views/views-database';

async function repo(t: test.TestContext, files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stingray-sql-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

test('sql-schema: SQL files, ordered ALTER migrations and cross-file FK edges keep real sources', async t => {
  const root = await repo(t, {
    '01.sql': 'CREATE TABLE children (id INT PRIMARY KEY, parent INT REFERENCES parents(id));',
    '02.sql': 'CREATE TABLE parents (id INT PRIMARY KEY);',
    '03.sql': '\nALTER TABLE children ADD extra TEXT;\nALTER TABLE children ADD CONSTRAINT f FOREIGN KEY (extra) REFERENCES parents(id);',
    'node_modules/ignored.sql': 'CREATE TABLE nope (id INT);',
    '.git/ignored.sql': 'CREATE TABLE nope (id INT);',
    'dist/ignored.sql': 'CREATE TABLE nope (id INT);',
  });
  await symlink(path.join(root, '02.sql'), path.join(root, 'link.sql'));
  const result = await extractSqlSchema('w', root);
  assert.equal(result.filesScanned, 3);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.groups.map(g => g.id), ['sql:01.sql', 'sql:02.sql']);
  const view = databaseView(result);
  assert.equal(view.edges.length, 2);
  assert.deepEqual(view.edges.map(e => e.to), ['sql:02.sql#parents', 'sql:02.sql#parents']);
  assert.deepEqual(view.nodes[0].fields[2].source, { file: '03.sql', line: 2 });
  assert.equal(view.nodes[0].fields[2].badges.includes('FK'), true);
});

test('sql-schema: TS/TSX/JS/MJS/CJS and Python literals map decoded escapes to physical source lines', async t => {
  const root = await repo(t, {
    'schema.ts': '// header\nconst ddl = `\nCREATE TABLE users (\n  id INT PRIMARY KEY,\n  name TEXT\n);\n`;\nconst text = "CREATE TABLE escaped (\\n id INT PRIMARY KEY)";',
    'schema.py': '# header\nsql = """\nCREATE TABLE py (\n  id INTEGER PRIMARY KEY\n);\n"""\ns = "CREATE TABLE escaped_py (\\n id INT)"',
    'a.tsx': 'const x = <div/>; const sql = `CREATE TABLE tsx_table (id INT)`;',
    'b.js': 'const sql = "CREATE TABLE js_table (id INT)";',
    'c.mjs': 'const sql = `CREATE TABLE mjs_table (id INT)`;',
    'd.cjs': 'const sql = `CREATE TABLE cjs_table (id INT)`;',
    'no-sql.ts': 'const x = "hello";',
  });
  const result = await extractSqlSchema('w', root);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.filesScanned, 7); assert.equal(result.filesParsed, 6);
  const tables = result.groups.flatMap(g => g.tables);
  const users = tables.find(t => t.name === 'users')!;
  assert.equal(users.line, 3); assert.equal(users.columns[0].line, 4);
  assert.equal(tables.find(t => t.name === 'escaped')!.columns[0].line, 8);
  assert.equal(tables.find(t => t.name === 'py')!.columns[0].line, 4);
  assert.equal(tables.find(t => t.name === 'escaped_py')!.columns[0].line, 7);
  assert.equal(tables.length, 8);
});

test('sql-schema: dynamic templates are skipped, comments are not strings, warnings and file sizes bounded', async t => {
  const root = await repo(t, {
    'schema.ts': 'const sql = `CREATE TABLE ${name} (id INT)`;\n// CREATE TABLE comment (id INT);',
    'schema.py': 's = f"CREATE TABLE {name} (id INT)"',
    'large.sql': ' '.repeat(1024 * 1024 + 1),
    'garbage.sql': 'garbage;'.repeat(300),
  });
  const result = await extractSqlSchema('w', root);
  assert.equal(result.groups.length, 0); assert.equal(result.truncated, true); assert.equal(result.warnings.length, 200);
  await writeFile(path.join(root, 'garbage.sql'), '');
  const small = await extractSqlSchema('w', root);
  assert.equal(small.warnings.filter(w => /substitutions/.test(w.message)).length, 2);
});

test('sql-schema: same-file targets win over other SQL groups, implicit references resolve primary keys', async t => {
  const root = await repo(t, {
    'a.sql': 'CREATE TABLE parents (id INT PRIMARY KEY);',
    'b.sql': 'CREATE TABLE parents (id INT PRIMARY KEY); CREATE TABLE children (parent INT REFERENCES parents);',
  });
  const view = databaseView(await extractSqlSchema('w', root));
  assert.equal(view.edges[0].to, 'sql:b.sql#parents'); assert.equal(view.edges[0].toField, 'id');
  assert.deepEqual(view.warnings, []);
});

test('sql-schema: names resolve case-insensitively, Python implicit concatenation and ALTER-only sources are read', async t => {
  const root = await repo(t, {
    'a.py': 'ddl = ("CREATE TABLE Users ("\n       "ID INT PRIMARY KEY)")',
    'b.ts': 'export const up = "ALTER TABLE users ADD team INT REFERENCES USERS(id)";',
  });
  const result = await extractSqlSchema('w', root);
  assert.deepEqual(result.warnings, []);
  const view = databaseView(result);
  assert.deepEqual(view.nodes[0].fields.map(f => [f.label, f.source?.file, f.source?.line]), [['ID', 'a.py', 2], ['team', 'b.ts', 1]]);
  assert.deepEqual(view.edges.map(e => [e.to, e.toField]), [['sql:a.py#Users', 'ID']]);
});
