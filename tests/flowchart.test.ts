import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../electron/views/rules/engine';
import { codegraphGrammarDir } from '../electron/views/rules/grammars';
import { MAX_FLOWCHART_NODES } from '../electron/views/flowchart/build';
import type { FlowchartStep, GraphApi, GraphRelation, GraphSymbol, ResolvedView } from '../electron/views/rules/types';
import type { DiagramNode } from '../src/views';
import { formatText } from '../src/views-text';

const grammarDir = codegraphGrammarDir();

/** Fake code graph over in-memory files: a symbol per `def`/`function`/method/`const f = (...) =>`, relations "from>to"
 * (trailing ? = heuristic) at the first line of `from` (after its definition) that calls `to(`. */
function fakeGraph(files: Record<string, string>, relations: string[]): GraphApi {
  const symbols: GraphSymbol[] = [];
  for (const [file, text] of Object.entries(files)) text.split('\n').forEach((line, i) => {
    const m = /^\s*(?:export\s+)?(?:async\s+)?(?:def|function)\s+(\w+)/.exec(line) ?? /^\s*(?:export\s+)?const\s+(\w+)\s*=.*=>/.exec(line)
      ?? /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[\w<>[\]]+\s*)?\{/.exec(line);
    if (m && !['if', 'for', 'while', 'switch', 'catch'].includes(m[1]))
      symbols.push({ id: `${file}#${m[1]}`, name: m[1], kind: /^\s*(def|function|export|const|async def)/.test(line) ? 'function' : 'method', file, line: i + 1 });
  });
  const byName = (name: string) => symbols.find(s => s.name === name)!;
  const rels = relations.map((r): GraphRelation => {
    const [, from, to, heuristic] = /^(\w+)>(\w+)(\?)?$/.exec(r)!;
    const caller = byName(from), lines = files[caller.file].split('\n');
    const line = lines.findIndex((l, i) => i >= caller.line - 1 && new RegExp(`\\b${to}\\(`).test(l)) + 1;
    assert.ok(line > 0, `no call ${r}`);
    return { from: caller.id, to: byName(to).id, kind: 'calls', line, certain: !heuristic };
  });
  return {
    findSymbols: (name, file) => symbols.filter(s => s.name === name && (!file || s.file === file)),
    symbols: ids => new Map(symbols.filter(s => ids.includes(s.id)).map(s => [s.id, s])),
    outgoing: (ids, kinds) => rels.filter(r => ids.includes(r.from) && kinds.includes(r.kind)),
    incoming: (ids, kinds) => rels.filter(r => ids.includes(r.to) && kinds.includes(r.kind)),
  };
}

const viewOf = (flowchart: Partial<FlowchartStep> & { start: FlowchartStep['start'] }, extra: Partial<ResolvedView> = {}): ResolvedView =>
  ({ id: 'fc', kind: 'flowchart', scope: { include: ['**/*'], exclude: [] }, rules: [], graph: null, builtins: [], include: [], exclude: [],
    flowchart: { depth: 1, ...flowchart }, ...extra });
async function run(files: Record<string, string>, relations: string[], flowchart: Parameters<typeof viewOf>[0], extra: Partial<ResolvedView> = {}) {
  const out = await evaluate({ view: viewOf(flowchart, extra), graph: fakeGraph(files, relations), graphStatus: { state: 'ready', message: null }, grammarDir,
    files: { list: async () => ({ files: Object.keys(files), truncated: false }), read: async f => files[f] ?? null } });
  return { ...out, text: formatText({ kind: 'flowchart', ...out }).split('\n').slice(1) };
}
const node = (nodes: DiagramNode[], label: string) => nodes.find(n => n.label === label)!;

const AUTH = {
  'app/auth.py': `from app.mail import send_reset_email


def load_user(name):
    if not name:
        raise ValueError("no name")
    return db_get(name)


def db_get(name):
    row = query(name)
    return row


def login(name, password):
    user = load_user(name)
    if user is None:
        return None
    elif not check(user, password):
        send_reset_email(user)
        raise PermissionError("bad password")
    else:
        audit("login")
    for attempt in user.sessions:
        if attempt.expired:
            continue
        if attempt.locked:
            break
        audit(attempt)
    return user


def check(user, password):
    return user.password == password


def audit(event):
    log(event)


def query(name):
    return None
`,
  'app/mail.py': `def send_reset_email(user):
    mailer.send(user.email)
`,
};
const AUTH_CALLS = ['login>load_user', 'login>check', 'login>send_reset_email', 'login>audit', 'load_user>db_get', 'db_get>query?'];

test('python: if/elif/else, early return, raise, loop with continue/break, calls expanded at depth 1', async () => {
  const out = await run(AUTH, AUTH_CALLS, { start: { symbol: 'login' } });
  assert.deepEqual(out.text, [
    '  (start) login · L15',
    '  » load_user',
    '    <?> name? · L5',
    '      No:',
    '        (error) ValueError: no name · L6',
    '      Yes:',
    '        → db get',
    '    [call] db get — +1 steps (increase depth) · L7',
    '  <?> has user? · L17',
    '    No:',
    '      (end) done · L18',
    '    Yes:',
    '      → check user password?',
    '  <?> check user password? · L19',
    '    No:',
    '      » send_reset_email',
    '        [ ] send · L2',
    '      (error) PermissionError: bad password · L21',
    '    Yes:',
    '      → log',
    '  » audit',
    '    [ ] log · L38',
    '  <loop> more sessions? · L24',
    '    Yes:',
    '      <?> attempt expired? · L25',
    '        Yes:',
    '          ↻ more sessions?',
    '        No:',
    '          <?> attempt locked? · L27',
    '            Yes:',
    '              → user',
    '            No:',
    '              » audit',
    '                [ ] log · L38',
    '              ↻ more sessions?',
    '    No:',
    '      → user',
    '  (end) user · L30',
  ]);
  const d = out.diagnostics.flowchart!;
  assert.deepEqual(d, { start: 'login (app/auth.py:15)', depth: 1, functions: 5, nodes: out.nodes.length, truncated: false, error: null });
  // Edge kinds and labels; the loop back-edges and `continue` are `loop` edges.
  const kinds = out.edges.map(e => `${e.kind}${e.label ? `/${e.label}` : ''}`).sort();
  assert.deepEqual([...new Set(kinds)], ['loop', 'loop/Yes', 'next', 'no/No', 'yes/Yes']); // `continue` on the Yes branch
  assert.equal(out.edges.filter(e => e.kind === 'loop').length, 2);
  // Groups per expansion, linked to the callee; nodes carry source and the call node its symbol.
  assert.deepEqual(out.groups.map(g => [g.id, g.label, g.source, g.parent]), [
    ['call:app/auth.py#load_user', 'load_user', { file: 'app/auth.py', line: 4 }, null],
    ['call:app/mail.py#send_reset_email', 'send_reset_email', { file: 'app/mail.py', line: 1 }, null],
    ['call:app/auth.py#audit', 'audit', { file: 'app/auth.py', line: 37 }, null],
    ['call:app/auth.py#audit#2', 'audit', { file: 'app/auth.py', line: 37 }, null],
  ]);
  const dbGet = node(out.nodes, 'db get');
  assert.deepEqual([dbGet.kind, dbGet.group, dbGet.symbol?.name, dbGet.source, dbGet.detail], ['call', 'call:app/auth.py#load_user', 'db_get', { file: 'app/auth.py', line: 7 }, 'return db_get(name)']);
  const start = node(out.nodes, 'login');
  assert.deepEqual([start.kind, start.role, start.symbol?.id], ['start', 'start', 'app/auth.py#login']);
  assert.deepEqual(node(out.nodes, 'ValueError: no name').role, 'end');
  assert.equal(node(out.nodes, 'name?').detail, 'not name');
  assert.ok(out.nodes.every(n => n.source));
});

test('python: depth 0 draws call nodes, depth 2 expands nested calls in nested groups; heuristic calls are dashed', async () => {
  const flat = await run(AUTH, AUTH_CALLS, { start: { symbol: 'login' }, depth: 0 });
  assert.deepEqual(flat.groups, []);
  assert.deepEqual(flat.nodes.filter(n => n.kind === 'call').map(n => [n.label, n.subtitle]), [
    ['load user', '+3 steps (increase depth)'], ['send reset email', '+1 steps (increase depth)'], ['audit', '+1 steps (increase depth)'], ['audit', '+1 steps (increase depth)'],
  ]);
  assert.equal(flat.diagnostics.flowchart!.functions, 1);
  // The condition's call `check(...)` is not drawn separately when not expanded: the decision names it.
  assert.ok(!flat.nodes.some(n => n.label === 'check'));

  const deep = await run(AUTH, AUTH_CALLS, { start: { symbol: 'login' }, depth: 2 });
  const group = deep.groups.find(g => g.label === 'db_get')!;
  assert.equal(group.parent, 'call:app/auth.py#load_user');
  // `query` has no steps to draw: a call node, reached through a heuristic relation (dashed).
  const query = node(deep.nodes, 'query');
  assert.deepEqual([query.kind, query.group, query.subtitle], ['call', group.id, null]);
  assert.deepEqual(deep.edges.filter(e => e.to === query.id).map(e => [e.certain, e.style]), [[false, 'dashed']]);
  assert.ok(deep.edges.filter(e => e.to !== query.id).every(e => e.certain && e.style === 'solid'));
});

test('python: try/except/else/finally, match, with, await, ternary', async () => {
  const files = { 'svc.py': `async def handle(event, store):
    with open_db() as db:
        try:
            await store.save(event)
        except (ValueError, KeyError) as e:
            report(e)
            raise
        except Exception:
            pass
        else:
            notify(event)
        finally:
            db.close()
    match event.kind:
        case "a" | "b":
            on_ab(event)
        case _:
            pass
    result = fast(event) if event.small else slow(event)
    x = 1
    if event.debug:
        pass
    return result
` };
  const out = await run(files, [], { start: { symbol: 'handle' } });
  assert.deepEqual(out.text, [
    '  (start) handle · L1',
    '  [ ] open db · L2',
    '  <?> succeeds? · L3',
    '    Yes:',
    '      [ ] save · L4',
    '      [ ] notify · L11',
    '    except (ValueError, KeyError):',
    '      [ ] report · L6',
    '      (error) re-raise · L7',
    '    except Exception:',
    '      → close',
    '  [ ] close · L13',
    '  <?> event kind? · L14',
    '    case "a" | "b":',
    '      [ ] on ab · L16',
    '    case other:',
    '      → event small?',
    '  <?> event small? · L19',
    '    Yes:',
    '      [ ] fast · L19',
    '    No:',
    '      [ ] slow · L19',
    '  (end) result · L23',
  ]);
  assert.deepEqual(out.edges.filter(e => e.kind === 'except' || e.kind === 'case').map(e => e.label), ['(ValueError, KeyError)', 'Exception', '"a" | "b"', 'other']);
});

const TS = {
  'src/run.ts': `import { helper } from './util';

export async function run(items: string[], mode: string) {
  if (!items.length) throw new Error('empty');
  for (const item of items) {
    await helper(item);
  }
  switch (mode) {
    case 'a':
    case 'b':
      helper(mode);
      break;
    default:
      return fallback(mode);
  }
  const value = mode ? pick(mode) : undefined;
  try {
    save(value);
  } catch (err) {
    console.error(err);
  }
  return value;
}

const fallback = (mode: string) => helper(mode);

class Runner {
  go(n: number): number {
    while (n > 0) {
      n = this.go(n - 1);
    }
    return n;
  }
}
`,
  'src/util.ts': `export async function helper(s: string) {
  if (s === null) return;
  log(s);
}
`,
};

test('typescript: throw, for-of, switch with fallthrough labels and break, ternary, try/catch, arrow function callee', async () => {
  const out = await run(TS, ['run>helper', 'run>fallback', 'fallback>helper'], { start: { symbol: 'run', file: 'src/run.ts' } });
  assert.deepEqual(out.text, [
    '  (start) run · L3',
    '  <?> items empty? · L4',
    '    Yes:',
    '      (error) Error: empty · L4',
    '    No:',
    '      → more items?',
    '  <loop> more items? · L5',
    '    Yes:',
    '      » helper',
    '        <?> has s? · L2',
    '          No:',
    '            → more items?',
    '          Yes:',
    '            [ ] log · L3',
    '      ↻ more items?',
    '    No:',
    '      → mode?',
    '  <?> mode? · L8',
    "    case 'a' / 'b':",
    '      → has s?',
    '    case other:',
    '      » fallback',
    '        [call] helper — +2 steps (increase depth) · L25',
    '      (end) fallback mode · L14',
    '  » helper',
    '    <?> has s? · L2',
    '      No:',
    '        → mode?',
    '      Yes:',
    '        [ ] log · L3',
    '  <?> mode? · L16',
    '    Yes:',
    '      [ ] pick · L16',
    '    No:',
    '      → succeeds?',
    '  <?> succeeds? · L17',
    '    Yes:',
    '      [ ] save · L18',
    '    except error:',
    '      [ ] error · L20',
    '  (end) value · L22',
  ]);
});

test('typescript: recursion guard marks a call to a function on the stack', async () => {
  const out = await run(TS, ['go>go'], { start: { symbol: 'go' }, depth: 3 });
  const self = out.nodes.find(n => n.kind === 'call')!;
  assert.deepEqual([self.label, self.subtitle, self.symbol?.name], ['go', 'recursive', 'go']);
  assert.ok(out.edges.some(e => e.kind === 'loop' && e.from === self.id));
});

test('include/exclude limit which callees expand', async () => {
  const included = await run(AUTH, AUTH_CALLS, { start: { symbol: 'login' }, include: ['app/mail.py'] });
  assert.deepEqual(included.groups.map(g => g.label), ['send_reset_email']);
  assert.equal(node(included.nodes, 'load user').subtitle, null); // out of include: a plain call node, no "+N" hint
  const excluded = await run(AUTH, AUTH_CALLS, { start: { symbol: 'login' }, exclude: ['app/mail.py'] });
  assert.deepEqual(excluded.groups.map(g => g.label), ['load_user', 'audit', 'audit']);
  const scoped = await run(AUTH, AUTH_CALLS, { start: { symbol: 'login' } }, { scope: { include: ['app/auth.py'], exclude: [] } });
  assert.ok(!scoped.groups.some(g => g.label === 'send_reset_email'));
  // View-level exclude (node ids/labels) still drops nodes.
  const dropped = await run(AUTH, AUTH_CALLS, { start: { symbol: 'login' }, depth: 0 }, { exclude: ['audit'] });
  assert.ok(!dropped.nodes.some(n => n.label === 'audit'));
});

test('node cap: stops expanding, marks unexpanded calls and reports truncation', async () => {
  const many = Array.from({ length: 60 }, (_, i) => `    step_${i}()`).join('\n');
  const files = { 'big.py': `def main():\n    a()\n    b()\n    c()\n\n\ndef a():\n${many}\n\n\ndef b():\n${many}\n\n\ndef c():\n${many}\n` };
  const out = await run(files, ['main>a', 'main>b', 'main>c'], { start: { symbol: 'main' } });
  assert.ok(out.nodes.length <= MAX_FLOWCHART_NODES);
  assert.deepEqual(out.groups.map(g => g.label), ['a', 'b']);
  assert.equal(node(out.nodes, 'c').subtitle, '+60 steps (increase depth)');
  assert.equal(out.truncated, true);
  assert.equal(out.diagnostics.flowchart!.truncated, true);
  assert.ok(out.warnings.some(w => /Flowchart stopped/.test(w.message)));
  // A single body larger than the cap is cut at the cap.
  const huge = { 'huge.py': `def main():\n${Array.from({ length: 200 }, (_, i) => `    s${i}()`).join('\n')}\n` };
  const cut = await run(huge, [], { start: { symbol: 'main' } });
  assert.equal(cut.nodes.length, MAX_FLOWCHART_NODES);
  assert.equal(cut.truncated, true);
});

test('errors: missing/ambiguous start, unsupported language, no code graph', async () => {
  const missing = await run(AUTH, [], { start: { symbol: 'nope' } });
  assert.equal(missing.diagnostics.flowchart!.error, 'start symbol not found: nope');
  assert.deepEqual(missing.nodes, []);
  const twice = { 'a.py': 'def go():\n    x()\n', 'b.py': 'def go():\n    y()\n' };
  assert.match((await run(twice, [], { start: { symbol: 'go' } })).diagnostics.flowchart!.error!, /ambiguous start symbol go: add a file \(a\.py:1, b\.py:1\)/);
  assert.equal((await run(twice, [], { start: { symbol: 'go', file: 'b.py' } })).diagnostics.flowchart!.error, null);
  const go = await run({ 'main.go': 'function main() {\n}\n' }, [], { start: { symbol: 'main' } });
  assert.equal(go.diagnostics.flowchart!.error, 'flowchart does not support go files yet');
  assert.deepEqual(go.warnings.map(w => [w.file, w.message]), [['main.go', 'flowchart does not support go files yet']]);
  const noGraph = await evaluate({ view: viewOf({ start: { symbol: 'login' }, depth: 2 }), graph: null, graphStatus: { state: 'indexing', message: null }, grammarDir,
    files: { list: async () => ({ files: [], truncated: false }), read: async () => null } });
  assert.deepEqual(noGraph.diagnostics.flowchart, { start: null, depth: 2, functions: 0, nodes: 0, truncated: false, error: 'code graph not ready (indexing)' });
});

test('python: while with a negated condition loops on No; break inside match leaves the loop', async () => {
  const files = { 'w.py': `def poll(job):
    while not job.done:
        match job.state:
            case "failed":
                break
            case _:
                job.refresh()
    finish(job)
` };
  const out = await run(files, [], { start: { symbol: 'poll' } });
  assert.deepEqual(out.text, [
    '  (start) poll · L1',
    '  <loop> job done? · L2',
    '    No:',
    '      <?> job state? · L3',
    '        case "failed":',
    '          → finish',
    '        case other:',
    '          [ ] refresh · L7',
    '          ↻ job done?',
    '    Yes:',
    '      → finish',
    '  [ ] finish · L8',
    '  (end) done · L1',
  ]);
});

test('a callee that draws nothing stays a call node instead of an empty group', async () => {
  const files = { 'f.ts': `export function run(s: string) {
  return fmt(s);
}
const fmt = (s: string) => s.trim();
` };
  const out = await run(files, ['run>fmt'], { start: { symbol: 'run' } });
  assert.deepEqual(out.groups, []);
  assert.deepEqual(out.text, ['  (start) run · L1', '  [call] fmt · L2', '  (end) fmt s · L2']);
});

test('a raise inside a try body continues at the handler that catches it, also from an expanded callee', async () => {
  const files = { 'svc.py': `def handle(x):
    try:
        if not x:
            raise ValueError("no x")
        check(x)
        if x > 3:
            raise KeyError("big")
        save(x)
    except asyncio.CancelledError:
        raise
    except ValueError:
        report(x)
    return x


def check(x):
    if x < 0:
        raise ValueError("negative")
` };
  const out = await run(files, ['handle>check'], { start: { symbol: 'handle' } });
  assert.deepEqual(out.text, [
    '  (start) handle · L1',
    '  <?> succeeds? · L2',
    '    Yes:',
    '      <?> x? · L3',
    '        No:',
    '          [ ] report · L12',
    '        Yes:',
    '          » check',
    '            <?> x < 0? · L17',
    '              Yes:',
    '                ↻ report',
    '              No:',
    '                <?> x > 3? · L6',
    '                  Yes:',
    '                    (error) KeyError: big · L7',
    '                  No:',
    '                    → save',
    '                [ ] save · L8',
    '    except asyncio.CancelledError:',
    '      (error) re-raise · L10',
    '    except ValueError:',
    '      ↻ report',
    '  (end) x · L13',
  ]);
  // the handler's except edge, then the caught raises keep their branch labels (Yes/No)
  const report = node(out.nodes, 'report').id;
  assert.deepEqual(out.edges.filter(e => e.to === report).map(e => `${e.kind}:${e.label}`), ['except:ValueError', 'no:No', 'yes:Yes']);
});

test('typescript: catch-all catch receives throws; a call chained on a call result is drawn as the inner call', async () => {
  const files = { 'f.ts': `export async function status(run: (a: string[]) => Promise<string>) {
  try {
    const upstream = (await run(['a'])).trim();
    const counts = (await run(['b'])).trim().split(/ /);
    if (counts.length !== 2) throw new Error('Invalid counts');
    return counts;
  } catch {
    return null;
  }
}
` };
  const out = await run(files, [], { start: { symbol: 'status' } });
  assert.deepEqual(out.text, [
    '  (start) status · L1',
    '  <?> succeeds? · L2',
    '    Yes:',
    '      [ ] run · L3',
    '      [ ] run · L4',
    '      <?> counts length is not 2? · L5',
    '        Yes:',
    '          → done',
    '        No:',
    '          (end) counts · L6',
    '    except error:',
    '      → done',
    '  (end) done · L8',
  ]);
});

test('text: consecutive sibling callees and a callee nested in its first step each get a header', async () => {
  const files = { 'g.py': `def run(x):
    with guard(x), tx():
        save(x)


def guard(x):
    if ok(x):
        log(x)


def ok(x):
    if x:
        trace(x)
    return x


def tx():
    if x:
        begin()
` };
  const out = await run(files, ['run>guard', 'run>tx', 'guard>ok'], { start: { symbol: 'run' }, depth: 2 });
  assert.deepEqual(out.text.filter(l => l.includes('»')), ['  » guard', '    » ok', '  » tx']);
});

test('a bare raise re-raises its handler\'s type: an outer handler for that type catches it, not a later catch-all', async () => {
  const files = { 'n.py': `async def node(state):
    try:
        try:
            await work(state)
        except asyncio.CancelledError:
            raise
        except Exception:
            note(state)
    except asyncio.CancelledError:
        cancel(state)
    except Exception:
        fail(state)
` };
  const out = await run(files, [], { start: { symbol: 'node' } });
  const into = (label: string) => out.edges.filter(e => e.to === node(out.nodes, label).id).map(e => `${e.kind}:${e.label}`);
  // the outer handler's own edge, then the inner handler's re-raise
  assert.deepEqual(into('cancel'), ['except:asyncio.CancelledError', 'except:asyncio.CancelledError']);
  assert.deepEqual(into('fail'), ['except:Exception']);
});

test('typescript: a case body without break falls through into the next case; for-loop increment calls are drawn', async () => {
  const files = { 'f.ts': `export function run(n: number) {
  switch (n) {
    case 1:
      a();
    case 2:
      b();
      break;
    default:
      c();
  }
  for (let i = 0; i < n; i = step(i)) {
    d();
  }
}
` };
  const out = await run(files, [], { start: { symbol: 'run' } });
  const into = (label: string) => out.edges.filter(e => e.to === node(out.nodes, label).id).map(e => `${e.kind}:${e.label}`);
  assert.deepEqual(into('b'), ['case:2', 'next:null']); // from the switch and from `a` falling through
  assert.ok(out.edges.some(e => e.from === node(out.nodes, 'a').id && e.to === node(out.nodes, 'b').id));
  assert.ok(out.edges.some(e => e.from === node(out.nodes, 'd').id && e.to === node(out.nodes, 'step').id));
  assert.equal(out.edges.find(e => e.from === node(out.nodes, 'step').id)!.kind, 'loop');
});

test('python: for/while else runs on the loop exit, not after break; try else is not caught by its handlers; while True has no exit branch', async () => {
  const files = { 'l.py': `def scan(items):
    for x in items:
        if x:
            break
    else:
        missing(items)
    try:
        load(items)
    except ValueError:
        report(items)
    else:
        if not items:
            raise ValueError("empty")
    while True:
        if poll():
            return items
` };
  const out = await run(files, [], { start: { symbol: 'scan' } });
  const loop = node(out.nodes, 'more items?').id;
  assert.deepEqual(out.edges.filter(e => e.to === node(out.nodes, 'missing').id).map(e => `${e.from === loop}:${e.label}`), ['true:No']);
  assert.ok(out.edges.some(e => e.to === node(out.nodes, 'succeeds?').id && e.from !== node(out.nodes, 'missing').id)); // break skips else
  assert.ok(node(out.nodes, 'ValueError: empty'), 'a raise in try-else is not caught by the same try');
  assert.deepEqual(out.edges.filter(e => e.to === node(out.nodes, 'report').id).map(e => e.label), ['ValueError']);
  const endless = out.nodes.find(n => n.kind === 'loop' && n.label !== 'more items?')!;
  assert.deepEqual(out.edges.filter(e => e.from === endless.id).map(e => e.label), ['Yes']);
  assert.ok(!out.nodes.some(n => n.label === 'done'), 'nothing falls off the end of an endless loop');
});

test('a call without a relation on its line only falls back to a same-name relation when that name has one target', async () => {
  const files = { 'g.py': `def run(store, d):
    store.get(1)
    d.get(2)


def get(k):
    fetch(k)
`, 'o.py': `def get(k):
    other(k)
` };
  // relations on line 2 only: one target for `get` anywhere in run -> line 3 also resolves to it
  const one = await run(files, ['run>get'], { start: { symbol: 'run' } });
  assert.equal(one.groups.length, 2);
  // a second `get` target (line 2 calls Other.get too): line 3 has no relation of its own and stays a library action
  const graph = fakeGraph(files, ['run>get']), other = graph.findSymbols('get', 'o.py')[0];
  const outgoing = graph.outgoing;
  graph.outgoing = (ids, kinds) => [...outgoing(ids, kinds), { from: 'g.py#run', to: other.id, kind: 'calls', line: 2, certain: false } satisfies GraphRelation];
  const two = await evaluate({ view: viewOf({ start: { symbol: 'run' } }), graph, graphStatus: { state: 'ready', message: null }, grammarDir,
    files: { list: async () => ({ files: Object.keys(files), truncated: false }), read: async f => files[f as keyof typeof files] ?? null } });
  assert.deepEqual(two.groups.map(g => g.label), ['get']);
  assert.ok(two.nodes.some(n => n.kind === 'action' && n.label === 'get' && n.source?.line === 3));
});

test('a callee that only raises into the caller\'s try is drawn as a call node, its raise not routed to the handler', async () => {
  const files = { 'r.py': `def run(x):
    try:
        boom(x)
        save(x)
    except ValueError:
        report(x)


def boom(x):
    raise ValueError("bad")
` };
  const out = await run(files, ['run>boom'], { start: { symbol: 'run' }, depth: 1 });
  // boom draws only a caught raise (no node): the step before it must not jump to the handler
  assert.deepEqual(out.groups, []);
  assert.equal(out.diagnostics.flowchart!.functions, 1);
  assert.deepEqual(out.edges.filter(e => e.to === node(out.nodes, 'report').id).map(e => e.label), ['ValueError']);
  assert.ok(out.edges.some(e => e.from === node(out.nodes, 'boom').id && e.to === node(out.nodes, 'save').id));
});
