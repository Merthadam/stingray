import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { databaseView } from '../electron/views/database';
import { ViewService } from '../electron/views';
import { createCodeGraphHost } from '../electron/codegraph';
import type { DbColumn, DbSchemaResult, DbTable } from '../src/db-schema';

const grammar = path.join(import.meta.dirname, '../electron/tree-sitter-python.wasm');

const col = (c: Partial<DbColumn> & { name: string; line: number }): DbColumn => ({
  attribute: c.name, type: 'Integer', primaryKey: false, nullable: false, unique: false, foreignKeys: [], inheritedFrom: null, ...c,
});
const users = (file: string): DbTable => ({
  name: 'users', schema: null, fullName: 'users', model: 'User', file, line: 3,
  columns: [
    col({ name: 'id', line: 4, primaryKey: true }),
    col({ name: 'mail', attribute: 'email', type: 'String', unique: true, nullable: true, line: 5 }),
    col({ name: 'created_at', type: 'DateTime', inheritedFrom: 'TimestampMixin', line: 2 }),
  ],
  relationships: [{ name: 'posts', targetModel: 'Post', targetTable: 'posts', collection: true, backPopulates: 'author', secondary: null, line: 6 }],
});
const schema: DbSchemaResult = {
  workspaceId: 'ws', scannedAt: 123, filesScanned: 4, filesParsed: 3, truncated: false,
  warnings: [{ file: 'broken.py', line: 1, message: 'Parse error' }],
  groups: [
    { id: 'a.py:Base', name: 'Base', file: 'a.py', line: 1, tables: [
      { name: 'posts', schema: null, fullName: 'posts', model: 'Post', file: 'a/post.py', line: 1,
        columns: [
          col({ name: 'id', line: 2, primaryKey: true }),
          col({ name: 'author_id', line: 3, foreignKeys: [{ target: 'users.id', targetTable: 'users', ondelete: 'CASCADE' }] }),
          col({ name: 'tag_id', line: 4, nullable: null, foreignKeys: [{ target: 'tags.id', targetTable: null, ondelete: null }] }),
        ],
        relationships: [
          { name: 'author', targetModel: 'User', targetTable: 'users', collection: false, backPopulates: 'posts', secondary: null, line: 5 },
          { name: 'tags', targetModel: 'Tag', targetTable: null, collection: true, backPopulates: null, secondary: null, line: 6 },
          { name: 'editors', targetModel: 'User', targetTable: 'users', collection: true, backPopulates: null, secondary: null, line: 7 },
        ] },
      users('a/user.py'),
    ] },
    { id: 'b.py:Base', name: 'Base', file: null, line: null, tables: [users('b/user.py')] },
  ],
};

test('databaseView maps tables, fields, and edges deterministically', () => {
  const view = databaseView(schema);
  assert.deepEqual(view, databaseView(structuredClone(schema)));
  assert.equal(view.id, 'database');
  assert.equal(view.computedAt, 123);
  assert.deepEqual(view.groups, [
    { id: 'a.py:Base', label: 'Base', source: { file: 'a.py', line: 1 } },
    { id: 'b.py:Base', label: 'Base', source: null },
  ]);
  const ids = view.nodes.map(n => n.id);
  assert.deepEqual(ids, ['a.py:Base#posts', 'a.py:Base#users', 'b.py:Base#users']);

  const user = view.nodes[1];
  assert.equal(user.subtitle, 'User');
  assert.deepEqual(user.fields, [
    { id: 'id', label: 'id', type: 'Integer', badges: ['PK'], detail: null, source: { file: 'a/user.py', line: 4 } },
    { id: 'email', label: 'mail', type: 'String', badges: ['UQ', 'NULL'], detail: 'attribute email', source: { file: 'a/user.py', line: 5 } },
    { id: 'created_at', label: 'created_at', type: 'DateTime', badges: [], detail: 'from TimestampMixin', source: null },
  ]);
  assert.deepEqual(view.nodes[0].fields[1].badges, ['FK']);

  assert.deepEqual(view.edges.map(e => e.id), [...view.edges.map(e => e.id)].sort());
  assert.deepEqual(view.edges, [
    { id: 'fk:a.py:Base#posts:author_id:0', from: 'a.py:Base#posts', to: 'a.py:Base#users', fromField: 'author_id', toField: 'id',
      kind: 'foreign-key', style: 'solid', certain: true, label: 'on delete CASCADE', source: { file: 'a/post.py', line: 3 } },
    { id: 'rel:a.py:Base#posts:author', from: 'a.py:Base#posts', to: 'a.py:Base#users', fromField: null, toField: null,
      kind: 'relationship', style: 'dashed', certain: true, label: 'author / posts', source: { file: 'a/post.py', line: 5 } },
    { id: 'rel:a.py:Base#posts:editors', from: 'a.py:Base#posts', to: 'a.py:Base#users', fromField: null, toField: null,
      kind: 'relationship', style: 'dashed', certain: true, label: 'editors (many)', source: { file: 'a/post.py', line: 7 } },
  ]);
  assert.deepEqual(view.stats, { filesScanned: 4, filesParsed: 3, tables: 3, foreignKeys: 1, relationships: 2 });
  assert.deepEqual(view.warnings, [
    { file: 'broken.py', line: 1, message: 'Parse error' },
    { file: 'a/post.py', line: 4, message: 'Foreign key tags.id on Post.tag_id: target table not found' },
    { file: 'a/post.py', line: 6, message: 'Relationship Post.tags: target Tag not found' },
    // b.py's users.posts points at "posts", which is absent from that group.
    { file: 'b/user.py', line: 6, message: 'Relationship User.posts: target Post not found' },
  ]);
});

test('databaseView caps warnings at 200', () => {
  const many = { ...schema, warnings: Array.from({ length: 200 }, (_, i) => ({ file: 'x.py', line: i, message: 'w' })) };
  assert.equal(databaseView(many).warnings.length, 200);
});

// The in-process host stands in for the app's child process; keep CodeGraph's opt-outs as the child would set them.
process.env.CODEGRAPH_TELEMETRY = '0'; process.env.CODEGRAPH_NO_UPDATE_CHECK = '1';
test('computeView builds the database view from a repository and rejects unknown views', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stingray-views-'));
  const service = new ViewService({ host: createCodeGraphHost(), grammarPath: grammar, emit: () => {} });
  try {
    assert.deepEqual((await service.listViews('ws', root)).map(v => v.id), ['database', 'layers']);
    const files: Record<string, string> = {
      'app/models.py': [
        'from sqlalchemy import ForeignKey, String',
        'from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship',
        '',
        'class Base(DeclarativeBase):',
        '    pass',
        '',
        'class User(Base):',
        '    __tablename__ = "users"',
        '    id: Mapped[int] = mapped_column(primary_key=True)',
        '    email: Mapped[str] = mapped_column(String(255), unique=True)',
        '    posts: Mapped[list["Post"]] = relationship(back_populates="author")',
        '',
        'class Post(Base):',
        '    __tablename__ = "posts"',
        '    id: Mapped[int] = mapped_column(primary_key=True)',
        '    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"))',
        '    author: Mapped["User"] = relationship(back_populates="posts")',
      ].join('\n'),
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    const view = await service.computeView('ws', root, 'database');
    assert.deepEqual(view.nodes.map(n => n.id), ['app/models.py:Base#posts', 'app/models.py:Base#users']);
    assert.deepEqual(view.edges.map(e => [e.id, e.label, e.toField]), [
      ['fk:app/models.py:Base#posts:author_id:0', null, 'id'],
      ['rel:app/models.py:Base#posts:author', 'author / posts', null],
    ]);
    assert.deepEqual(view.nodes[1].fields.find(f => f.id === 'email')?.badges, ['UQ']);
    await assert.rejects(service.computeView('ws', root, 'nope'), /Unknown view: nope/);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
