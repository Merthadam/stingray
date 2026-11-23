import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { extractDbSchema } from '../../electron/core/db-schema';
import { provideSyntaxParser, resetCorePorts } from '../../electron/core/shared/ports';
import { webTreeSitter } from '../../electron/adapters/driven/tree-sitter/syntax-parser';
import { memorySchemaFiles } from '../fakes/db-schema';

const grammarPath = path.join(import.meta.dirname, '../../electron/adapters/driven/tree-sitter/tree-sitter-python.wasm');
const model = 'from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column\nclass Base(DeclarativeBase):\n    pass\nclass User(Base):\n    __tablename__ = "users"\n    id: Mapped[int] = mapped_column(primary_key=True)\n';
before(() => provideSyntaxParser(webTreeSitter));
after(() => resetCorePorts());

test('extracts tables from in-memory files; skips large files and unreadable dirs with warnings', async () => {
  const files = memorySchemaFiles({ 'app/models.py': model, 'big.py': 'tooLarge', 'locked/x.py': model, 'notes.txt': 'x' }, ['locked']);
  const result = await extractDbSchema('w1', '/repo', grammarPath, files);
  assert.deepEqual(result.groups.flatMap(g => g.tables.map(t => t.name)), ['users']);
  assert.ok(result.warnings.some(w => w.file === 'big.py' && /1 MiB/.test(w.message)));
  assert.ok(result.warnings.some(w => w.file === 'locked' && /Could not read directory/.test(w.message)));
  assert.equal(result.filesScanned, 1);
});
