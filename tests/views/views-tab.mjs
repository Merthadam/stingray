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
await put('agent/graph/builder.py', await readFile(fileURLToPath(new URL('../fixtures/views/langgraph/agent/graph/builder.py', import.meta.url)), 'utf8'));
await put('.stingray/views/agent-flow.yaml', 'version: 1\nname: Agent flow\nkind: flow\nuse: [langgraph]\n');
await put('.stingray/views/steps.yaml', 'version: 1\nname: Steps text\nkind: timeline\nrules:\n  - id: step\n    language: python\n    query: \'(call function: (attribute attribute: (identifier) @m (#eq? @m "add_node")) arguments: (argument_list . (string (string_content) @name)))\'\n    emit: { node: { id: "@name", label: "@name" } }\n');
await put('app/auth.py', 'def check_password(user, password):\n    """Reject inactive users, then verify the password.\n\n    Raises ValueError.\n    """\n    user.refresh()\n    if not user.active:\n        raise ValueError("inactive")\n    return verify(password)\n\n\n'
  + 'def login(email, password):\n    user = find_user(email)\n    if user is None:\n        return None\n    audit_login(email)\n    check_password(user, password)\n    return user\n');
await put('app/handlers.py', 'def clean(value):\n    """Trim and lowercase a value."""\n    return value.strip().lower()\n\n\n'
  + 'def load(name):\n    """Load a record by its cleaned name."""\n    return clean(name)\n\n\n'
  + 'def handle(request):\n    """Handle a request end to end."""\n    record = load(request)\n    return clean(record)\n');
await put('.stingray/views/handlers.yaml', 'version: 1\nname: Handler calls\nkind: graph\ngraph:\n  start: [{ symbol: handle }]\n  follow: [calls]\n'
  + 'explain:\n  handle: { text: Serve one request, fingerprint: "000000000000" }\n');
await put('.stingray/views/login.yaml', 'version: 1\nname: Login chart\nkind: flowchart\nflowchart:\n  start: { symbol: login }\n  depth: 0\n'
  + 'explain:\n  login: { text: Sign a user in by email, fingerprint: { app/auth.py::login: "000000000000" } }\n'
  + "  'user is None': { text: Account found for this email? }\n");
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

  // Counts saves of the flow view only: switching away from Database flushes that view's own pending state.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('views.saveViewState');
    globalThis.viewStateSaves = 0;
    ipcMain.removeHandler('views.saveViewState');
    ipcMain.handle('views.saveViewState', async (...args) => { if (args[2] === 'agent-flow') globalThis.viewStateSaves++; return original(...args); });
  });
  const saves = () => app.evaluate(() => globalThis.viewStateSaves);
  const waitSaves = async (n) => { for (let i = 0; i < 50 && await saves() < n; i++) await page.waitForTimeout(100); return saves(); };
  await list.getByRole('button', { name: 'Agent flow' }).click();
  const flow = page.getByTestId('flow-diagram');
  await flow.getByRole('button', { name: 'Select transition 1. needs_plan' }).waitFor();
  check('flow view draws steps and START/END', await flow.locator('.flow-card').count() === 5 && await flow.locator('.flow-pill').count() === 2);
  check('flow view labels branches with router conditions', await flow.getByRole('button', { name: 'Select transition else' }).count() === 1
    && await flow.getByRole('button', { name: 'Select transition retry' }).count() === 1);
  check('flow view draws every transition', await flow.locator('.react-flow__edge').count() === 6);
  const flowTexts = await flow.locator('.flow-card').allInnerTexts();
  check('flow cards show words, not the handler code; the graph frame is titled without its file',
    !flowTexts.some(t => /ConversationNode|plan_node|\(/.test(t)) && (await flow.locator('.flow-frame-label').allInnerTexts()).join() === 'builder'
    && (await flow.locator('.flow-frame-label').getAttribute('title')) === 'builder\nagent/graph/builder.py');
  await page.waitForTimeout(1000); // automatic layout settled
  check('opening a flow view writes no view state', await saves() === 0);
  const card = await flow.locator('.flow-card').first().boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2); await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 + 80, card.y + card.height / 2 + 40, { steps: 8 }); await page.mouse.up();
  check('dragging a card saves the layout', await waitSaves(1) >= 1);
  const afterDrag = await saves();
  await page.getByRole('button', { name: 'Re-layout the diagram' }).click();
  check('re-layout saves the new layout once it is computed', await waitSaves(afterDrag + 1) > afterDrag);
  await flow.getByRole('button', { name: 'Select transition 1. needs_plan' }).click();
  check('clicking a branch shows its source', /agent\/graph\/builder\.py:\d+/.test(await page.getByRole('complementary', { name: 'Transition details' }).innerText()));
  await page.getByRole('button', { name: /Diagnostics/ }).click();
  check('flow diagnostics drawer lists rules', await page.getByRole('region', { name: 'Diagnostics' }).getByRole('heading', { name: /Rules/ }).isVisible());
  await page.getByRole('button', { name: /Diagnostics/ }).click();
  check('flow steps without a description are marked; pills are not', await flow.locator('.flow-step.undescribed .flow-undescribed').count() === 3
    && await flow.locator('.flow-pill .flow-undescribed').count() === 0);
  if (process.env.VIEWS_SCREENSHOT) await page.screenshot({ path: process.env.VIEWS_SCREENSHOT.replace(/\.png$/, '-flow.png') });
  // Describe… on a rule step without a symbol writes an explain: entry keyed by its node id; Remove restores the file.
  const flowFile = path.join(repo, '.stingray/views/agent-flow.yaml'), flowYaml = await readFile(flowFile, 'utf8');
  await flow.getByRole('group', { name: 'Step chat' }).click();
  const chatInspector = flow.getByRole('complementary', { name: 'Step chat' });
  await chatInspector.getByRole('button', { name: 'Describe…' }).click();
  await chatInspector.getByRole('textbox', { name: 'Description' }).fill('Answer the traveler directly');
  await chatInspector.getByRole('button', { name: 'Save' }).click();
  const chatCard = flow.getByRole('group', { name: 'Step chat' });
  await chatCard.locator('.flow-explanation', { hasText: 'Answer the traveler directly' }).waitFor();
  check('describing a flow step shows the text on its card, unmarked, and writes it under the step id',
    await chatCard.locator('.flow-undescribed').count() === 0
    && (await readFile(flowFile, 'utf8')).includes("explain:\n  agent/graph/builder.py:builder:chat:\n    text: Answer the traveler directly\n"));
  await chatInspector.getByRole('button', { name: 'Edit description' }).click();
  await chatInspector.getByRole('button', { name: 'Remove' }).click();
  await chatCard.locator('.flow-undescribed').waitFor();
  // shortcut: the yaml library re-pads flow collections (`[langgraph]` → `[ langgraph ]`); compare without that padding.
  const unpadded = (t) => t.replace(/\[ (.*?) \]/g, '[$1]');
  check('removing the flow step description restores the view file', unpadded(await readFile(flowFile, 'utf8')) === flowYaml);
  await page.keyboard.press('Escape');
  await flow.getByRole('button', { name: 'Select builder' }).click();
  check('a graph frame opens its group inspector with Describe…',
    await flow.getByRole('complementary', { name: 'Group builder' }).getByRole('button', { name: 'Describe…' }).isEnabled());
  await page.keyboard.press('Escape');

  // Flowcharts need the code graph; the view refreshes once indexing finishes.
  await list.getByRole('button', { name: 'Login chart' }).click();
  const chart = page.getByTestId('flow-diagram');
  await chart.getByRole('group', { name: 'decision has user?' }).waitFor({ timeout: 60000 });
  await chart.getByRole('button', { name: 'Select transition Yes' }).waitFor();
  check('flowchart draws pills, a decision diamond and a call box with its hidden steps',
    await chart.locator('.flow-diamond').count() === 1 && await chart.locator('.flow-pill').count() === 3
    && (await chart.locator('.flow-chart-call').innerText()).includes('+4 steps'));
  check('a call box shows its callee docstring summary as a visible explanation',
    await chart.locator('.flow-chart-call .flow-explanation').innerText() === 'Reject inactive users, then verify the password.');
  const startExplanation = chart.locator('.flow-pill.start .flow-explanation');
  check('a stale explain: entry replaces the explanation and is marked "may be outdated"',
    await startExplanation.locator('.flow-explanation-stale').innerText() === 'may be outdated'
    && (await startExplanation.innerText()).endsWith('Sign a user in by email'));
  check('flowchart labels the decision branches Yes/No', await chart.getByRole('button', { name: 'Select transition Yes' }).count() === 1
    && await chart.getByRole('button', { name: 'Select transition No' }).count() === 1);
  check('an explain: entry keyed by its condition titles the decision diamond',
    (await chart.locator('.flow-diamond').innerText()).trim() === 'Account found for this email?');
  check('the summary hides undescribed library steps; a stored call result is no step at all',
    await chart.getByRole('group', { name: 'action audit login' }).count() === 0 && await chart.locator('.flow-chart-action').count() === 0);
  await chart.getByRole('button', { name: 'Show all steps' }).click();
  await chart.getByRole('group', { name: 'action audit login' }).waitFor();
  check('"All steps" shows them, marked as undescribed; described steps are not marked',
    await chart.locator('.flow-chart-action.undescribed .flow-undescribed').count() === 1 && await chart.locator('.flow-diamond.undescribed').count() === 0
    && await chart.locator('.flow-chart-call.undescribed').count() === 0 && await chart.getByRole('group', { name: 'action find user' }).count() === 0);
  const cardTexts = await chart.locator('.flow-card').allInnerTexts();
  check('flowchart cards show words, not code', cardTexts.length > 0 && !cardTexts.some(t => /[=_]|\w\(/.test(t)));
  if (process.env.FLOWCHART_SCREENSHOT) await page.screenshot({ path: process.env.FLOWCHART_SCREENSHOT });
  await chart.getByRole('group', { name: 'action audit login' }).click();
  check('the inspector shows the step\'s code', (await page.getByRole('complementary', { name: 'Step audit login' }).getByLabel('Code').innerText())
    .includes('audit_login(email)'));
  await page.keyboard.press('Escape');
  await chart.getByRole('button', { name: 'Show the summary' }).click();
  await chart.getByRole('group', { name: 'action audit login' }).waitFor({ state: 'detached' });
  const depth = page.getByRole('slider', { name: 'Flowchart depth' });
  check('depth slider starts at the view file depth', await depth.inputValue() === '0');
  await depth.fill('1');
  const frame = chart.getByRole('button', { name: 'Open check_password in editor' });
  await frame.waitFor();
  check('raising the depth expands the callee into a frame; its guard folds into a "can fail" badge on the step before it',
    await chart.locator('.flow-diamond').count() === 1 && await chart.locator('.flow-pill.error').count() === 0 && await chart.locator('.flow-chart-call').count() === 0
    && (await chart.getByRole('group', { name: 'action refresh' }).locator('.flow-can-fail').innerText()).includes('inactive'));
  await chart.getByRole('group', { name: 'action refresh' }).click();
  check('the inspector lists what the step can fail with', (await chart.getByRole('list', { name: 'Can fail' }).innerText()).includes('inactive'));
  await page.keyboard.press('Escape');
  await chart.getByRole('button', { name: 'Show all steps of check_password' }).click();
  await chart.locator('.flow-pill.error').waitFor();
  check('a frame\'s "all steps" switch shows that function\'s guard', await chart.locator('.flow-diamond').count() === 2
    && await chart.locator('.flow-can-fail').count() === 0);
  if (process.env.FLOWCHART_SCREENSHOT) await page.screenshot({ path: process.env.FLOWCHART_SCREENSHOT.replace(/\.png$/, '-depth1.png') });
  await chart.getByRole('button', { name: 'Summarize check_password' }).click();
  await chart.locator('.flow-pill.error').waitFor({ state: 'detached' });
  await chart.getByRole('button', { name: 'Explanation of check_password: Reject inactive users, then verify the password.' }).click();
  check('the frame explanation opens the full text in the inspector',
    (await chart.getByRole('complementary', { name: 'Function check_password' }).innerText()).includes('Reject inactive users, then verify the password.'));
  const saveAs = chart.getByRole('button', { name: 'Save as view' });
  check('save as view is off while the depth is overridden', await saveAs.isDisabled());
  await depth.fill('0');
  await chart.locator('.flow-chart-call').waitFor();
  check('moving the slider back to the file depth drops the override', await saveAs.isEnabled());
  // Drill-down: one call at a time, by its call path; the new frame takes the clicked card's place on screen.
  const callCard = chart.locator(".react-flow__node", { has: page.locator(".flow-chart-call") });
  const before = await callCard.boundingBox();
  await chart.getByRole('button', { name: 'Expand check password' }).dispatchEvent('click'); // the minimap can cover it in small CI windows
  await frame.waitFor();
  check('a call card\'s chevron opens that call in place as a frame', await chart.locator('.flow-chart-call').count() === 0
    && await depth.inputValue() === '0');
  const frameBox = chart.locator('.react-flow__node-frame', { has: page.getByRole('button', { name: 'Open check_password in editor' }) });
  let after = await frameBox.boundingBox();
  for (let i = 0; i < 20 && after && Math.hypot(after.x - before.x, after.y - before.y) > 2; i++) { await page.waitForTimeout(50); after = await frameBox.boundingBox(); }
  check('the opened frame sits where the call card was', !!before && !!after && Math.hypot(after.x - before.x, after.y - before.y) <= 2);
  check('save as view stays on with opened calls', await saveAs.isEnabled());
  await saveAs.click();
  const saveDialog = page.getByRole('dialog', { name: 'Save as view' });
  check('save as view writes the opened calls to flowchart.expand', (await saveDialog.innerText()).includes('1 expanded call saved to flowchart.expand: check_password'));
  await saveDialog.getByRole('button', { name: 'Cancel' }).click();
  await chart.getByRole('button', { name: 'Collapse check_password' }).dispatchEvent('click'); // the minimap can cover it in small CI windows
  await chart.locator('.flow-chart-call').waitFor();
  check('the frame\'s collapse button closes it into the call card again', await frame.count() === 0 && await saveAs.isEnabled());
  // "Describe…" writes the step's explain: entry into the view file; Remove deletes it and the docstring shows again.
  const loginFile = path.join(repo, '.stingray/views/login.yaml'), loginYaml = await readFile(loginFile, 'utf8');
  const callExplanation = chart.locator('.flow-chart-call .flow-explanation');
  const waitText = async (want) => { for (let i = 0; i < 100 && await callExplanation.innerText() !== want; i++) await page.waitForTimeout(100); return callExplanation.innerText(); };
  await chart.getByRole('group', { name: 'call check password' }).dispatchEvent('click'); // the minimap can cover it in small CI windows
  const stepInspector = chart.getByRole('complementary', { name: 'Step check password' });
  await stepInspector.getByRole('button', { name: 'Edit description' }).click();
  const description = stepInspector.getByRole('textbox', { name: 'Description' });
  check('describing a step opens its docstring text with a hint that the view overrides it',
    await description.inputValue() === 'Reject inactive users, then verify the password.' && (await stepInspector.innerText()).includes('Overrides the docstring in this view')
    && await stepInspector.getByRole('button', { name: 'Remove' }).count() === 0);
  await description.fill("Verify the user's password");
  if (process.env.FLOWCHART_SCREENSHOT) await page.screenshot({ path: process.env.FLOWCHART_SCREENSHOT.replace(/\.png$/, '-describe.png') });
  await stepInspector.getByRole('button', { name: 'Save' }).click();
  check('saving a description shows it on the card, fingerprinted (not marked outdated)', await waitText("Verify the user's password") === "Verify the user's password"
    && await chart.locator('.flow-chart-call .flow-explanation-stale').count() === 0
    && /check_password:\n {4}text: Verify the user's password\n {4}fingerprint:\n {6}app\/auth\.py::check_password: \w{12}\n$/.test(await readFile(loginFile, 'utf8')));
  await stepInspector.getByRole('button', { name: 'Edit description' }).click();
  await stepInspector.getByRole('button', { name: 'Remove' }).click();
  check('removing it brings the docstring back and restores the view file',
    await waitText('Reject inactive users, then verify the password.') === 'Reject inactive users, then verify the password.' && await readFile(loginFile, 'utf8') === loginYaml);
  await page.keyboard.press('Escape');

  // The builtin Services view: stinggraph layers from .stinggraph/layers.yaml, drilled down with the depth slider.
  await list.getByRole('button', { name: 'Services' }).click();
  const services = page.getByTestId('flow-diagram');
  await services.getByRole('group', { name: 'Step App service' }).waitFor({ timeout: 60000 });
  const layersDepth = page.getByRole('slider', { name: 'Layers depth' });
  check('Services view draws one node per service, at depth 1', await layersDepth.inputValue() === '1'
    && await services.getByRole('group', { name: 'Step Agent service' }).count() === 1);
  await layersDepth.fill('3');
  await services.getByRole('group', { name: 'Step models.py' }).waitFor();
  await services.locator('.flow-frame', { hasText: 'App service' }).first().waitFor(); // frames follow the re-layout
  check('raising the layers depth draws files inside service frames', await services.getByRole('group', { name: 'Step App service' }).count() === 0
    && (await services.locator('.flow-frame').allInnerTexts()).some(t => t.includes('App service')));
  const edgeTexts = await services.locator('.flow-edge-label').allInnerTexts();
  check('file cards show no folder path; roll-up edges show only their count', await services.locator('.flow-step > span').count() === 0
    && edgeTexts.length > 0 && edgeTexts.every(t => /^\d+$/.test(t.trim())));
  await layersDepth.fill('4');
  const symbolCard = services.getByRole('group', { name: 'Step check password' });
  await symbolCard.waitFor();
  check('symbol cards are titled in words and carry their docstring summary',
    await symbolCard.locator('.flow-explanation').innerText() === 'Reject inactive users, then verify the password.');
  if (process.env.VIEWS_SCREENSHOT) await page.screenshot({ path: process.env.VIEWS_SCREENSHOT.replace(/\.png$/, '-layers.png') });

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
  check('graph cards show no code line and set fields in the text font',
    await calls.locator('.flow-step > span').count() === 0
    && !/mono/i.test(await calls.getByRole('list', { name: 'Fields of handle' }).evaluate(el => getComputedStyle(el).fontFamily)));
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
