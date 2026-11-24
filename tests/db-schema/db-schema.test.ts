import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractDbSchema } from '../../electron/app/wiring/db-schema';
import type { DbSchemaResult, DbTable } from '../../shared/contracts/db-schema';

const grammar = path.join(import.meta.dirname, '../../electron/adapters/driven/tree-sitter/tree-sitter-python.wasm');

async function repo(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stingray-db-schema-'));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}
const table = (result: DbSchemaResult, group: string, name: string): DbTable => {
  const found = result.groups.find(g => g.id === group)?.tables.find(t => t.fullName === name);
  assert.ok(found, `missing ${group} ${name}`);
  return found;
};
const column = (t: DbTable, name: string) => {
  const found = t.columns.find(c => c.name === name);
  assert.ok(found, `missing column ${t.fullName}.${name}`);
  return found;
};

const files = {
  'app/__init__.py': '',
  'app/db/__init__.py': 'from .base import Base\n',
  'app/db/base.py': 'from sqlalchemy.orm import DeclarativeBase\n\nclass Base(DeclarativeBase):\n    pass\n',
  'app/mixins.py': [
    'from datetime import datetime',
    'from sqlalchemy.orm import Mapped, mapped_column',
    'class TimestampMixin:',
    '    created_at: Mapped[datetime] = mapped_column()',
  ].join('\n'),
  'app/models/user.py': [
    'from typing import Optional',
    'import sqlalchemy as sa',
    'from sqlalchemy import String',
    'from sqlalchemy.orm import Mapped, mapped_column, relationship',
    'from app.db import Base',
    'from ..mixins import TimestampMixin',
    '',
    'class User(TimestampMixin, Base):',
    '    __tablename__ = "users"',
    '    id: Mapped[int] = mapped_column(primary_key=True)',
    '    email: Mapped[str] = mapped_column(String(255), unique=True)',
    '    nick: Mapped[Optional[str]]',
    '    status = sa.Column("state", sa.String(20))',
    '    addresses: Mapped[list["Address"]] = relationship(back_populates="user")',
  ].join('\n'),
  'app/models/address.py': [
    'from sqlalchemy import ForeignKey',
    'from sqlalchemy.orm import Mapped, mapped_column, relationship',
    'from app.db.base import Base',
    '',
    '@some_decorator',
    'class Address(Base):',
    '    __tablename__ = "addresses"',
    '    __table_args__ = {"schema": "crm"}',
    '    id: Mapped[int] = mapped_column(primary_key=True)',
    '    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))',
    '    user: Mapped["User"] = relationship(back_populates="addresses")',
  ].join('\n'),
  'app/main.py': '"""Application entry point."""\nimport os\n\napp = object()\n\ndef run():\n    return os.getcwd()\n',
  'billing/db.py': 'from sqlalchemy.orm import declarative_base\nBase = declarative_base()\n',
  'billing/models.py': [
    'from sqlalchemy import Column, Integer, String, ForeignKey',
    'from sqlalchemy.orm import relationship',
    'from .db import Base',
    '',
    'class User(Base):',
    '    __tablename__ = "users"',
    '    id = Column(Integer, primary_key=True)',
    '    ref = Column("user_ref", String)',
    '',
    'class Invoice(Base):',
    '    __tablename__ = "invoices"',
    '    id = Column(Integer, primary_key=True)',
    '    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)',
    '    user = relationship("User")',
  ].join('\n'),
  'web/__init__.py': 'from flask_sqlalchemy import SQLAlchemy\ndb = SQLAlchemy()\n',
  'web/models.py': 'from . import db\n\nclass BlogPost(db.Model):\n    id = db.Column(db.Integer, primary_key=True)\n',
  'broken.py': 'import sqlalchemy\nclass Broken(:\n',
  '.venv/lib/x.py': 'from sqlalchemy.orm import declarative_base\nBase = declarative_base()\nclass Hidden(Base):\n    __tablename__ = "hidden"\n',
  'node_modules/pkg/x.py': 'from sqlalchemy.orm import declarative_base\nBase = declarative_base()\nclass Hidden(Base):\n    __tablename__ = "hidden"\n',
  'pwn.py': 'import os\nimport sqlalchemy\nos.system("touch PWNED")\nopen("PWNED2", "w")\n',
};

test('extracts models from an ordinary repository without executing it', async () => {
  const root = await repo(files);
  try {
    await symlink('app/models/user.py', path.join(root, 'alias.py'));
    await symlink('.', path.join(root, 'loop'));
    await symlink('/nonexistent/target.py', path.join(root, 'dangling.py'));
    const result = await extractDbSchema('ws', root, grammar);
    assert.deepEqual(structuredClone(result), result);
    assert.deepEqual(result.groups.map(g => g.id), ['app/db/base.py:Base', 'billing/db.py:Base', 'web/__init__.py:db']);
    assert.equal(result.truncated, false);

    const users = table(result, 'app/db/base.py:Base', 'users');
    assert.equal(users.file, 'app/models/user.py');
    assert.deepEqual(column(users, 'id'), { name: 'id', attribute: 'id', type: 'Integer', primaryKey: true, nullable: false, unique: false, foreignKeys: [], inheritedFrom: null, line: 10 });
    assert.equal(column(users, 'email').type, 'String(255)');
    assert.equal(column(users, 'email').unique, true);
    assert.equal(column(users, 'email').nullable, false);
    assert.equal(column(users, 'nick').nullable, true);
    assert.equal(column(users, 'nick').type, 'String');
    assert.equal(column(users, 'state').attribute, 'status');
    assert.equal(column(users, 'state').type, 'String(20)');
    assert.equal(column(users, 'state').nullable, true);
    assert.equal(column(users, 'created_at').inheritedFrom, 'TimestampMixin');
    assert.deepEqual(users.relationships.map(r => [r.name, r.targetModel, r.targetTable, r.collection, r.backPopulates]),
      [['addresses', 'Address', 'crm.addresses', true, 'user']]);

    const addresses = table(result, 'app/db/base.py:Base', 'crm.addresses');
    assert.equal(addresses.schema, 'crm');
    assert.deepEqual(column(addresses, 'user_id').foreignKeys, [{ target: 'users.id', targetTable: 'users', ondelete: 'CASCADE' }]);
    assert.deepEqual(addresses.relationships.map(r => [r.targetModel, r.targetTable, r.collection]), [['User', 'users', false]]);

    // The billing Base is a separate group: same table names never cross groups.
    const invoices = table(result, 'billing/db.py:Base', 'invoices');
    assert.equal(column(invoices, 'user_id').foreignKeys[0]!.targetTable, 'users');
    assert.equal(column(invoices, 'user_id').nullable, false);
    assert.equal(invoices.relationships[0]!.targetTable, 'users');
    assert.equal(column(table(result, 'billing/db.py:Base', 'users'), 'user_ref').attribute, 'ref');

    assert.equal(table(result, 'web/__init__.py:db', 'blog_post').model, 'BlogPost');

    const all = result.groups.flatMap(g => g.tables.map(t => t.file));
    assert.ok(!all.some(f => f.startsWith('.venv') || f.startsWith('node_modules') || f.startsWith('loop') || f === 'alias.py'));
    assert.ok(result.warnings.some(w => w.file === 'broken.py'));
    assert.ok(!existsSync(path.join(root, 'PWNED')) && !existsSync(path.join(root, 'PWNED2')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('re-extracts after commits and branch switches without stale state', async () => {
  const root = await repo({ 'db.py': files['billing/db.py'], 'models.py': 'from sqlalchemy import Column, Integer\nfrom db import Base\nclass A(Base):\n    __tablename__ = "a"\n    id = Column(Integer, primary_key=True)\n' });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' });
  try {
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'one');
    const first = await extractDbSchema('ws', root, grammar);
    assert.deepEqual(first.groups[0]!.tables[0]!.columns.map(c => c.name), ['id']);
    git('checkout', '-qb', 'feature');
    await writeFile(path.join(root, 'models.py'), 'from sqlalchemy import Column, Integer\nfrom db import Base\nclass A(Base):\n    __tablename__ = "a"\n    id = Column(Integer, primary_key=True)\n    b = Column(Integer)\n');
    git('commit', '-qam', 'two');
    const second = await extractDbSchema('ws', root, grammar);
    assert.deepEqual(second.groups[0]!.tables[0]!.columns.map(c => c.name), ['id', 'b']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('large files and empty repositories degrade to warnings, not failures', async () => {
  const root = await repo({ 'big.py': 'import sqlalchemy\n' + '#'.repeat(1024 * 1024 + 10), 'readme.txt': 'hi' });
  try {
    const result = await extractDbSchema('ws', root, grammar);
    assert.deepEqual(result.groups, []);
    assert.ok(result.warnings.some(w => w.file === 'big.py' && /1 MiB/.test(w.message)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Flask inheritance keeps parent columns on the parent table', async () => {
  const root = await repo({ 'models.py': [
    'from flask_sqlalchemy import SQLAlchemy',
    'db = SQLAlchemy()',
    'class User(db.Model):',
    '    id = db.Column(db.Integer, primary_key=True)',
    '    type = db.Column(db.String(20))',
    "    __mapper_args__ = {'polymorphic_on': type}",
    'class Admin(User):',
    "    __mapper_args__ = {'polymorphic_identity': 'admin'}",
    'class Employee(db.Model):',
    '    id = db.Column(db.Integer, primary_key=True)',
    '    name = db.Column(db.String)',
    'class Manager(Employee):',
    "    id = db.Column(db.ForeignKey('employee.id'), primary_key=True)",
    '    budget = db.Column(db.Integer)',
    '',
  ].join('\n') });
  try {
    const result = await extractDbSchema('ws', root, grammar);
    const group = 'models.py:db';
    assert.deepEqual(result.groups.find(g => g.id === group)?.tables.map(t => t.fullName), ['employee', 'manager', 'user']);
    assert.deepEqual(table(result, group, 'manager').columns.map(c => c.name), ['id', 'budget']);
    assert.equal(column(table(result, group, 'manager'), 'id').foreignKeys[0]!.targetTable, 'employee');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime table names warn, duplicate mixin columns collapse, long annotations stay fast', async () => {
  const root = await repo({ 'models.py': [
    'from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, declared_attr',
    'class Base(DeclarativeBase):',
    '    @declared_attr.directive',
    '    def __tablename__(cls) -> str: return cls.__name__.lower()',
    'class Computed(Base):',
    '    id: Mapped[int] = mapped_column(primary_key=True)',
    'class A:',
    '    created: Mapped[int] = mapped_column()',
    'class B:',
    '    created: Mapped[str] = mapped_column()',
    'class Thing(A, B, Base):',
    "    __tablename__ = 'thing'",
    '    id: Mapped[int] = mapped_column(primary_key=True)',
    `    x: Mapped[(${' '.repeat(300_000)}int)]`,
    '',
  ].join('\n') });
  try {
    const started = Date.now();
    const result = await extractDbSchema('ws', root, grammar);
    assert.ok(Date.now() - started < 3000, 'annotation regexes must stay linear');
    assert.ok(result.warnings.some(w => w.line === 5 && /computed at runtime/.test(w.message)));
    const thing = table(result, 'models.py:Base', 'thing');
    assert.deepEqual(thing.columns.map(c => [c.name, c.type]), [['id', 'Integer'], ['x', '( int)'], ['created', 'Integer']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
