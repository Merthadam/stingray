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
  '    """A registered account that writes posts."""',
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
await put('.stingray/views/steps.yaml', 'version: 1\nname: Steps text\nkind: timeline\nrules:\n  - id: step\n    language: python\n    query: \'(call function: (attribute attribute: (identifier) @m (#eq? @m "add_node")) arguments: (argument_list . (string (string_content) @name)))\'\n    emit: { node: { id: "@name", label: "@name" } }\n');
await put('app/auth.py', 'def check_password(user, password):\n    """Reject inactive users, then verify the password.\n\n    Raises ValueError.\n    """\n    if not user.active:\n        raise ValueError("inactive")\n    return verify(password)\n\n\n'
  + 'def login(email, password):\n    user = find_user(email)\n    if user is None:\n        return None\n    check_password(user, password)\n    return user\n');
await put('app/handlers.py', 'def clean(value):\n    """Trim and lowercase a value."""\n    return value.strip().lower()\n\n\n'
  + 'def load(name):\n    """Load a record by its cleaned name."""\n    return clean(name)\n\n\n'
  + 'def handle(request):\n    """Handle a request end to end."""\n    record = load(request)\n    return clean(record)\n');
await put('.stingray/views/handlers.yaml', 'version: 1\nname: Handler calls\nkind: graph\ngraph:\n  start: [{ symbol: handle }]\n  follow: [calls]\n'
  + 'explain:\n  handle: { text: Serve one request, fingerprint: "000000000000" }\n');
await put('.stingray/views/login.yaml', 'version: 1\nname: Login chart\nkind: flowchart\nflowchart:\n  start: { symbol: login }\n  depth: 0\n'
  + 'explain:\n  login: { text: Sign a user in by email, fingerprint: { app/auth.py::login: "000000000000" } }\n');
// A FastAPI-like route -> service -> repository: a sequence view with an if/else (alt) and a raise (error note).
await put('app/routes.py', 'from app.service import authenticate\n\n\ndef sign_in_route(request):\n    return authenticate(request.email, request.password)\n');
await put('app/service.py', 'from app.repo import fetch_account, touch_login\n\n\ndef authenticate(email, password):\n    account = fetch_account(email)\n'
  + '    if account is None:\n        raise PermissionError("unknown account")\n    else:\n        touch_login(account)\n    return account\n');
await put('app/repo.py', 'def fetch_account(email):\n    return {"email": email}\n\n\ndef touch_login(account):\n    return account\n');
await put('.stingray/views/sign-in.yaml', 'version: 1\nname: Sign in sequence\nkind: sequence\nsequence:\n  start: { symbol: sign_in_route }\n  trigger: POST /sign-in\n  participants: file\n');
await put('.stinggraph/layers.yaml', 'version: 1\nservices:\n  - id: app\n    label: App service\n    include: ["app/**"]\n  - id: agent\n    label: Agent service\n    include: ["agent/**"]\n');
await put('infra/main.tf', 'resource "aws_s3_bucket" "uploads" {}\nresource "aws_lambda_function" "api" {\n  environment { variables = { BUCKET = aws_s3_bucket.uploads.id } }\n}\n');
await put('.stingray/views/infra.yaml', 'version: 1\nname: Infrastructure\nkind: graph\nuse: [terraform]\nscope:\n  include: ["infra/**"]\n');
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

  // Flowcharts need the code graph; the view refreshes once indexing finishes.
  await list.getByRole('button', { name: 'Login chart' }).click();
  const chart = page.getByTestId('flow-diagram');
  await chart.getByRole('group', { name: 'decision has user?' }).waitFor({ timeout: 60000 });
  await chart.getByRole('button', { name: 'Select transition Yes' }).waitFor();
  check('flowchart draws pills, a decision diamond and a call box with its hidden steps',
    await chart.locator('.flow-diamond').count() === 1 && await chart.locator('.flow-pill').count() === 3
    && (await chart.locator('.flow-chart-call').innerText()).includes('+3 steps'));
  check('a call box shows its callee docstring summary as a visible explanation',
    await chart.locator('.flow-chart-call .flow-explanation').innerText() === 'Reject inactive users, then verify the password.');
  const startExplanation = chart.locator('.flow-pill.start .flow-explanation');
  check('a stale explain: entry replaces the explanation and is marked "may be outdated"',
    await startExplanation.locator('.flow-explanation-stale').innerText() === 'may be outdated'
    && (await startExplanation.innerText()).endsWith('Sign a user in by email'));
  check('flowchart labels the decision branches Yes/No', await chart.getByRole('button', { name: 'Select transition Yes' }).count() === 1
    && await chart.getByRole('button', { name: 'Select transition No' }).count() === 1);
  const depth = page.getByRole('slider', { name: 'Flowchart depth' });
  check('depth slider starts at the view file depth', await depth.inputValue() === '0');
  await depth.fill('1');
  const frame = chart.getByRole('button', { name: 'Open check_password in editor' });
  await frame.waitFor();
  check('raising the depth expands the callee into a frame with its own steps', await chart.locator('.flow-diamond').count() === 2
    && await chart.locator('.flow-pill.error').count() === 1 && await chart.locator('.flow-chart-call').count() === 0);
  await chart.getByRole('button', { name: 'Explanation of check_password: Reject inactive users, then verify the password.' }).click();
  check('the frame explanation opens the full text in the inspector',
    (await chart.getByRole('complementary', { name: 'Function check_password' }).innerText()).includes('Reject inactive users, then verify the password.'));
  const saveAs = chart.getByRole('button', { name: 'Save as view' });
  check('save as view is off while the depth is overridden', await saveAs.isDisabled());
  await depth.fill('0');
  await chart.locator('.flow-chart-call').waitFor();
  check('moving the slider back to the file depth drops the override', await saveAs.isEnabled());

  // The builtin Services view: stinggraph layers from .stinggraph/layers.yaml, drilled down with the depth slider.
  await list.getByRole('button', { name: 'Services' }).click();
  const services = page.getByTestId('flow-diagram');
  await services.getByRole('group', { name: 'Step App service' }).waitFor({ timeout: 60000 });
  const layersDepth = page.getByRole('slider', { name: 'Layers depth' });
  check('Services view draws one node per service, at depth 1', await layersDepth.inputValue() === '1'
    && await services.getByRole('group', { name: 'Step Agent service' }).count() === 1);
  await layersDepth.fill('3');
  await services.getByRole('group', { name: 'Step models.py' }).waitFor();
  check('raising the layers depth draws files inside service frames', await services.getByRole('group', { name: 'Step App service' }).count() === 0
    && (await services.locator('.flow-frame').allInnerTexts()).some(t => t.includes('App service')));

  // A graph view: functions reached through calls; clean (called by both, calls nothing) collapses into a helper field.
  await list.getByRole('button', { name: 'Handler calls' }).click();
  const calls = page.getByTestId('flow-diagram');
  await calls.getByRole('group', { name: 'Step load' }).waitFor({ timeout: 60000 });
  check('graph view draws its functions as flow cards with explanations',
    await calls.getByRole('group', { name: 'Step handle' }).count() === 1 && await calls.getByRole('group', { name: 'Step clean' }).count() === 0
    && await calls.getByRole('group', { name: 'Step load' }).locator('.flow-explanation').innerText() === 'Load a record by its cleaned name.');
  check('an explain: entry with an old string fingerprint is marked "old fingerprint", not "may be outdated"',
    await calls.getByRole('group', { name: 'Step handle' }).locator('.flow-explanation-stale.legacy').innerText() === 'old fingerprint');
  check('collapsed helpers show as fields of their callers', (await calls.getByRole('list', { name: 'Fields of handle' }).innerText()).includes('clean'));
  await calls.getByRole('group', { name: 'Step handle' }).click();
  check('selecting a graph node opens its symbol and helpers in the inspector',
    await calls.getByRole('button', { name: 'Open handle in editor' }).isVisible()
    && await calls.getByRole('button', { name: 'Open handle.clean in editor' }).isVisible());
  await page.screenshot({ path: process.env.VIEWS_SCREENSHOT ?? path.join(root, 'graph-view.png') });
  await page.getByRole('button', { name: 'Show as text' }).click();
  const graphText = page.getByLabel('Text diagram');
  await graphText.waitFor();
  check('a graph view switches to its searchable text form, without the fallback note',
    (await graphText.innerText()).includes('handle') && await page.locator('.views-text-note').count() === 0
    && (await graphText.innerText()).includes('Serve one request (old fingerprint)'));
  await page.getByRole('button', { name: 'Show as diagram' }).click();
  await calls.getByRole('group', { name: 'Step load' }).waitFor({ timeout: 60000 });
  check('and back to the diagram', await page.getByRole('button', { name: 'Show as text' }).isVisible());

  // Terraform resources drawn as their cloud service: official icon, resource name, service name, in an AWS group box.
  await list.getByRole('button', { name: 'Infrastructure' }).click();
  const infra = page.getByTestId('flow-diagram');
  const lambda = infra.getByRole('group', { name: 'AWS Lambda aws_lambda_function.api' });
  await lambda.waitFor();
  check('terraform view draws resources as service icons in an AWS cloud frame', (await lambda.innerText()).replace(/\s+/g, ' ').trim() === 'api AWS Lambda'
    && await infra.locator('.flow-infra-icon').evaluateAll(imgs => imgs.length === 2 && imgs.every(i => i.complete && i.naturalWidth > 0))
    && await infra.locator('.flow-frame.cloud.aws .flow-frame-cloud-icon').count() === 1);
  await lambda.click();
  check('the inspector explains the service and links its docs', (await page.getByRole('region', { name: 'Service AWS Lambda' }).innerText()).includes('Runs your code')
    && await page.getByRole('button', { name: 'Open AWS Lambda documentation' }).isVisible());

  await list.getByRole('button', { name: 'Steps text' }).click();
  await page.getByText("This view type isn't drawn in the app yet").waitFor();
  const text = page.getByLabel('Text diagram');
  check('timeline view shows its text form', /^timeline: \d+ nodes/.test(await text.innerText()) && (await text.innerText()).includes('plan'));
  await page.getByLabel('Search the text').fill('plan');
  check('text search highlights matches', await text.locator('mark').count() > 0);
  await page.getByRole('button', { name: /Diagnostics/ }).click();
  const drawer = page.getByRole('region', { name: 'Diagnostics' });
  check('diagnostics drawer lists rules', await drawer.getByRole('heading', { name: /Rules/ }).isVisible());

  await list.getByRole('button', { name: /\(invalid\)$/ }).click();
  check('broken view shows its error', /kind/.test(await page.locator('.views-invalid-error').innerText()));

  // A sequence view: lifelines per file, call/return arrows, an alt fragment with the raise as a note in its first arm.
  await list.getByRole('button', { name: 'Sign in sequence' }).click();
  const sequence = page.getByTestId('sequence-diagram');
  await sequence.getByRole('button', { name: /^Message routes\.py -> service\.py: authenticate/ }).waitFor({ timeout: 60000 });
  check('sequence view draws the actor and one lifeline per file', await sequence.getByRole('button', { name: /^Participant / }).evaluateAll(els => els.map(e => e.getAttribute('aria-label'))).then(l =>
    l.join('|') === 'Participant User|Participant routes.py (app/routes.py)|Participant service.py (app/service.py)|Participant repo.py (app/repo.py)'));
  check('sequence view draws calls with labels and dashed returns', await sequence.getByRole('button', { name: /^Message service\.py -> repo\.py: fetch account/ }).count() === 1
    && await sequence.locator('.seq-message.return').count() >= 2);
  check('sequence view frames the if/else as an alt with the raise as an error note',
    await sequence.locator('.seq-fragment-kind').allTextContents().then(t => t.join() === 'alt')
    && await sequence.getByRole('button', { name: 'Note on service.py: error: PermissionError' }).count() === 1);
  await sequence.getByRole('button', { name: 'Participant service.py (app/service.py)' }).click();
  check('clicking a participant opens its messages in the inspector',
    (await sequence.getByRole('complementary', { name: 'Participant service.py' }).innerText()).includes('fetch account'));
  await sequence.getByRole('button', { name: 'Participant repo.py (app/repo.py)' }).click();
  await sequence.getByRole('button', { name: 'Fold into caller' }).click();
  check('folding a participant draws its part on the caller lifeline', await sequence.getByRole('button', { name: /^Participant / }).count() === 3
    && await sequence.getByRole('button', { name: /fetch account/ }).count() === 0);
  await sequence.getByRole('button', { name: 'Unfold 1' }).click();
  check('and unfolding brings it back', await sequence.getByRole('button', { name: /^Participant / }).count() === 4);
  await page.getByRole('button', { name: 'Show as text' }).click();
  check('a sequence view switches to the CLI text', (await page.getByLabel('Text diagram').innerText()).includes('service.py -> repo.py: fetch account'));
  await page.getByRole('button', { name: 'Show as diagram' }).click();
  await page.evaluate(() => window.stingray.setEditor('repo-map')); // never launch a real editor from the test
  // Dragging pans from anywhere, also from a full-width message row, without opening the message.
  for (let i = 0; i < 4; i++) await sequence.getByRole('button', { name: 'Zoom in' }).click();
  const canvas = sequence.locator('.seq-canvas'), scrolled = () => canvas.evaluate(el => el.scrollLeft + el.scrollTop);
  const row = await sequence.getByRole('button', { name: /^Message routes\.py -> service\.py: authenticate/ }).boundingBox();
  const panFrom = await scrolled();
  await page.mouse.move(row.x + 60, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + 20, row.y + row.height / 2 - 40, { steps: 6 });
  await page.mouse.up();
  check('dragging a message row pans the diagram and does not open it', await scrolled() > panFrom
    && await page.getByRole('tab', { name: 'Views' }).getAttribute('aria-selected') === 'true');
  await sequence.getByRole('button', { name: 'Reset zoom' }).click();
  await sequence.getByRole('button', { name: /^Message service\.py -> repo\.py: fetch account/ }).click();
  await page.getByRole('tab', { name: /Repo Map/ }).and(page.locator('[aria-selected=true]')).waitFor();
  check('clicking a message opens its call site', true);
  await page.getByRole('tab', { name: 'Views' }).click();

  await list.getByRole('button', { name: 'Database' }).click();
  await diagram.getByText('posts', { exact: true }).first().waitFor();
  const usersExplanation = diagram.locator('.er-card-explanation', { hasText: 'A registered account that writes posts.' });
  await usersExplanation.waitFor({ timeout: 30000 });
  check('a table linked to its model class shows the class docstring under the card header',
    await usersExplanation.getAttribute('title') === 'A registered account that writes posts.' && await diagram.locator('.er-card-explanation').count() === 1);
  await put('app/models.py', models + 'class Tag(Base):\n    __tablename__ = "tags"\n    id: Mapped[int] = mapped_column(primary_key=True)\n');
  await diagram.getByText('tags', { exact: true }).first().waitFor({ timeout: 30000 });
  check('editing a model file updates the diagram live', true);
  check('no renderer errors', errors.length === 0 || (console.log(errors), false));
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
