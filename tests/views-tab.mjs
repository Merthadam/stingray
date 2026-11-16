// End-to-end check of the Views tab in the built Electron app (run `npm run build` first).
// Diagram assertions only look for table names inside the shell's `views-diagram` wrapper, so they hold for any ErDiagram.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const executablePath = process.env.STINGRAY_TEST_APP ? path.resolve(process.env.STINGRAY_TEST_APP) : undefined;
const root = await mkdtemp(path.join(tmpdir(), 'stingray-views-ui-'));
const repo = path.join(root, 'views-fixture');
await mkdir(repo);
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
async function put(file, content) { await mkdir(path.dirname(path.join(repo, file)), { recursive: true }); await writeFile(path.join(repo, file), content); }
git('init', '-b', 'main');
await put('app/db.py', 'from sqlalchemy.orm import DeclarativeBase\nclass Base(DeclarativeBase):\n    pass\n');
const models = [
  'from sqlalchemy import ForeignKey, String',
  'from sqlalchemy.orm import Mapped, mapped_column, relationship',
  'from app.db import Base',
  'class User(Base):',
  '    __tablename__ = "users"',
  '    id: Mapped[int] = mapped_column(primary_key=True)',
  '    email: Mapped[str] = mapped_column(String(255), unique=True)',
  '    posts: Mapped[list["Post"]] = relationship(back_populates="author")',
  'class Post(Base):',
  '    __tablename__ = "posts"',
  '    id: Mapped[int] = mapped_column(primary_key=True)',
  '    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"))',
  '    author: Mapped["User"] = relationship(back_populates="posts")',
].join('\n') + '\n';
await put('app/models.py', models);
await put('agent/graph/builder.py', await readFile(fileURLToPath(new URL('./fixtures/views/langgraph/agent/graph/builder.py', import.meta.url)), 'utf8'));
await put('.stingray/views/agent-flow.yaml', 'version: 1\nname: Agent flow\nkind: flow\nuse: [langgraph]\n');
await put('.stingray/views/steps.yaml', 'version: 1\nname: Steps text\nkind: graph\nrules:\n  - id: step\n    language: python\n    query: \'(call function: (attribute attribute: (identifier) @m (#eq? @m "add_node")) arguments: (argument_list . (string (string_content) @name)))\'\n    emit: { node: { id: "@name", label: "@name" } }\n');
await put('.stingray/views/broken.yaml', 'version: 1\nname: Broken\nkind: nope\nuse: [sqlalchemy]\n');
git('add', '.'); git('commit', '-m', 'fixture');

const env = { ...process.env, STINGRAY_DATA_DIR: path.join(root, 'data') };
delete env.ELECTRON_RUN_AS_NODE; delete env.STINGRAY_DEV_URL;
let app; const errors = [];
function check(name, value) { assert.ok(value, name); console.log('PASS', name); }
try {
  app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env, timeout: 30000 });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true));
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForFunction(() => !!window.stingray);
  await page.evaluate(async repo => window.stingray.openRepository(repo), repo);
  await page.reload(); await page.getByRole('button', { name: 'Open project views-fixture', exact: true }).click();
  await page.getByRole('tab', { name: 'Views' }).click();
  const list = page.getByRole('navigation', { name: 'Views list' });
  await list.getByRole('button', { name: 'Agent flow' }).waitFor();
  const names = await list.getByRole('button', { name: /^(?!(Collapse|Expand) views list)/ }).evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
  check('lists Database first, then the repo views', names[0] === 'Database' && names.includes('Agent flow') && names.some(n => /\(invalid\)$/.test(n)));

  const diagram = page.getByTestId('views-diagram');
  await diagram.getByText('posts', { exact: true }).first().waitFor();
  check('Database view draws the tables', await diagram.getByText('users', { exact: true }).count() > 0);

  await list.getByRole('button', { name: 'Agent flow' }).click();
  const flow = page.getByTestId('flow-diagram');
  await flow.getByRole('button', { name: 'Select transition 1. needs_plan' }).waitFor();
  check('flow view draws steps and START/END', await flow.locator('.flow-card').count() === 5 && await flow.locator('.flow-pill').count() === 2);
  check('flow view labels branches with router conditions', await flow.getByRole('button', { name: 'Select transition else' }).count() === 1
    && await flow.getByRole('button', { name: 'Select transition retry' }).count() === 1);
  check('flow view draws every transition', await flow.locator('.react-flow__edge').count() === 6);
  await flow.getByRole('button', { name: 'Select transition 1. needs_plan' }).click();
  check('clicking a branch shows its source', /agent\/graph\/builder\.py:\d+/.test(await page.getByRole('complementary', { name: 'Transition details' }).innerText()));
  await page.getByRole('button', { name: /Diagnostics/ }).click();
  check('flow diagnostics drawer lists rules', await page.getByRole('region', { name: 'Diagnostics' }).getByRole('heading', { name: /Rules/ }).isVisible());
  await page.getByRole('button', { name: /Diagnostics/ }).click();

  await list.getByRole('button', { name: 'Steps text' }).click();
  await page.getByText("This view type isn't drawn in the app yet").waitFor();
  const text = page.getByLabel('Text diagram');
  check('graph view shows its text form', /^graph: \d+ nodes/.test(await text.innerText()) && (await text.innerText()).includes('plan'));
  await page.getByLabel('Search the text').fill('plan');
  check('text search highlights matches', await text.locator('mark').count() > 0);
  await page.getByRole('button', { name: /Diagnostics/ }).click();
  const drawer = page.getByRole('region', { name: 'Diagnostics' });
  check('diagnostics drawer lists rules', await drawer.getByRole('heading', { name: /Rules/ }).isVisible());

  await list.getByRole('button', { name: /\(invalid\)$/ }).click();
  check('broken view shows its error', /kind/.test(await page.locator('.views-invalid-error').innerText()));

  await list.getByRole('button', { name: 'Database' }).click();
  await diagram.getByText('posts', { exact: true }).first().waitFor();
  await put('app/models.py', models + 'class Tag(Base):\n    __tablename__ = "tags"\n    id: Mapped[int] = mapped_column(primary_key=True)\n');
  await diagram.getByText('tags', { exact: true }).first().waitFor({ timeout: 30000 });
  check('editing a model file updates the diagram live', true);
  check('no renderer errors', errors.length === 0 || (console.log(errors), false));
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
