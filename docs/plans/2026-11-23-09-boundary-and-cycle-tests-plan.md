# 09 · Strict boundary and cycle tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** two node:test files keep the hexagonal layout honest with **no allow-list**: every import of `electron/`,
`shared/`, `src/`, `agents/` obeys the layer table, and core features form an acyclic graph whose edges are a subset of
the intended set. Plus the approved rule that only `electron/app/**` and tests call the core port `provide*` functions.
Any violation found is fixed in code, not excused.

**Architecture:** `tests/architecture/import-scan.ts` (helper) lists source files, extracts import specifiers with their
line and type-only flag, resolves relative ones, classifies files into layers and judges each import;
`import-boundaries.test.ts` and `core-cycles.test.ts` use it. No new dependency.

**Tech Stack:** node:test, `node:fs`, `node:path`.

**Spec:** [04 § Commit 9](../specs/2026-11-23-04-hexagonal-modules-design.md#commit-9--boundary-and-cycle-tests), [04 § Layers and rules](../specs/2026-11-23-04-hexagonal-modules-design.md#layers-and-rules).

**Depends on:** plan 08 committed. **Commit:** one, `test(architecture): strict import-boundary and core-cycle tests`.

---

## Files

Create: `tests/architecture/import-scan.ts`, `tests/architecture/import-boundaries.test.ts`, `tests/architecture/core-cycles.test.ts`.
Modify: whatever source files the tests flag (import specifiers only, plus moving a declaration to the right layer when an import cannot be made legal otherwise).

---

### Task 1: The scanner

- [ ] **Step 1: `tests/architecture/import-scan.ts`**

```ts
// Import scanner for the architecture tests: files of electron/, shared/, src/, agents/; specifiers with line and
// type-only flag; layer of every file; the layer rules of docs/specs/2026-11-23-04-hexagonal-modules-design.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type ImportRef = { file: string; line: number; specifier: string; target: string | null; typeOnly: boolean };
export type Layer = { kind: 'entry' | 'app' | 'core' | 'driving' | 'driven' | 'shared' | 'renderer-app' | 'renderer-feature' | 'renderer-shared' | 'agents' | 'other'; group?: string };

const ROOTS = ['electron', 'shared', 'src', 'agents'];
export function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); } else if (/\.tsx?$/.test(e.name)) out.push(rel);
    }
  };
  for (const root of ROOTS) if (existsSync(root)) walk(root);
  return out.sort();
}

const STATIC = /^[ \t]*(?:import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC = /(typeof\s+)?\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
// Comments are blanked (keeping line numbers) so commented-out code and prose are not read as imports.
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/^[ \t]*\/\/.*$/gm, '');
const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;
const allTypeBindings = (bindings: string) => bindings.startsWith('{') &&
  bindings.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).every(s => s.startsWith('type '));

export function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // package or node builtin
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return base; // reported as unresolved
}

export function importsOf(file: string, source = readFileSync(file, 'utf8')): ImportRef[] {
  const text = stripComments(source), refs: ImportRef[] = [];
  const add = (index: number, specifier: string, typeOnly: boolean) => refs.push({ file, line: lineAt(text, index), specifier, target: resolveImport(file, specifier), typeOnly });
  for (const m of text.matchAll(STATIC)) add(m.index!, m[3], Boolean(m[1]) || allTypeBindings(m[2]));
  for (const m of text.matchAll(SIDE_EFFECT)) add(m.index!, m[1], false);
  for (const m of text.matchAll(DYNAMIC)) add(m.index!, m[2], Boolean(m[1]));
  return refs;
}

export function layerOf(file: string): Layer {
  let m: RegExpExecArray | null;
  if (file === 'electron/main.ts') return { kind: 'entry' };
  if (file.startsWith('electron/app/')) return { kind: 'app' };
  if ((m = /^electron\/core\/([^/]+)\//.exec(file))) return { kind: 'core', group: m[1] };
  if ((m = /^electron\/adapters\/driving\/([^/]+)\//.exec(file))) return { kind: 'driving', group: m[1] };
  if ((m = /^electron\/adapters\/driven\/([^/]+)\//.exec(file))) return { kind: 'driven', group: m[1] };
  if (file.startsWith('shared/')) return { kind: 'shared' };
  if (file.startsWith('src/app/')) return { kind: 'renderer-app' };
  if ((m = /^src\/features\/([^/]+)\//.exec(file))) return { kind: 'renderer-feature', group: m[1] };
  if (file.startsWith('src/shared/')) return { kind: 'renderer-shared' };
  if (file.startsWith('agents/')) return { kind: 'agents' };
  return { kind: 'other' };
}

const CORE_PACKAGES = new Set(['zod', 'yaml']);
const packageName = (s: string) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
const isIndex = (file: string, dir: string) => file === `${dir}/index.ts` || file === `${dir}/index.tsx`;
const renderer = (k: Layer['kind']) => k === 'renderer-app' || k === 'renderer-feature' || k === 'renderer-shared';

/** The broken rule, or null when the import is allowed. Type-only imports skip package rules, never layer rules. */
export function violation(from: string, specifier: string, target: string | null, typeOnly: boolean, exists: (file: string) => boolean = existsSync): string | null {
  const a = layerOf(from);
  if (a.kind === 'other') return 'file is in no layer';
  if (target === null) {
    if (a.kind === 'entry') return 'electron/main.ts imports only electron/app/index.ts';
    if (a.kind === 'core') return typeOnly || CORE_PACKAGES.has(packageName(specifier)) ? null : 'core imports only zod and yaml at runtime';
    if (a.kind === 'shared') return typeOnly || packageName(specifier) === 'zod' ? null : 'shared/ imports only zod at runtime';
    return null;
  }
  if (!exists(target)) return 'unresolved relative import';
  const b = layerOf(target);
  switch (a.kind) {
    case 'entry': return target === 'electron/app/index.ts' ? null : 'electron/main.ts imports only electron/app/index.ts';
    case 'app': return renderer(b.kind) || b.kind === 'agents' ? 'electron/app imports only electron/ and shared/' : null;
    case 'core':
      if (b.kind === 'shared') return null;
      if (b.kind !== 'core') return 'core imports only core and shared/';
      if (b.group === a.group || b.group === 'shared') return null;
      return isIndex(target, `electron/core/${b.group}`) ? null : 'core features import each other only via index.ts';
    case 'driving':
    case 'driven':
      if (b.kind === 'shared') return null;
      if (b.kind === 'core') {
        const ok = b.group === 'shared' || isIndex(target, `electron/core/${b.group}`) || (a.kind === 'driven' && target === `electron/core/${b.group}/ports.ts`);
        return ok ? null : 'adapters import core via index.ts (driven also ports.ts)';
      }
      if (b.kind === a.kind && b.group === a.group) return null;
      if (b.kind === 'driving' || b.kind === 'driven') return 'adapters never import another adapter folder';
      return b.kind === 'app' ? 'only electron/app imports adapters, never the reverse' : 'adapters never import src/ or agents/';
    case 'shared': return b.kind === 'shared' ? null : 'shared/ imports nothing from electron/, src/, agents/';
    case 'renderer-app':
    case 'renderer-feature':
    case 'renderer-shared':
      if (b.kind === 'shared') return null;
      if (!renderer(b.kind)) return 'src/ never imports electron/ or agents/';
      if (a.kind === 'renderer-shared' && b.kind !== 'renderer-shared') return 'src/shared imports no feature and no app';
      if (b.kind === 'renderer-feature' && !(a.kind === 'renderer-feature' && a.group === b.group) && !isIndex(target, `src/features/${b.group}`)) return 'other features only via src/features/<f>/index.ts';
      return null;
    case 'agents': return b.kind === 'shared' || b.kind === 'agents' ? null : 'agents/ imports only shared/ and packages';
  }
  return null;
}
```

### Task 2: Boundary test with a self-check table (TDD)

- [ ] **Step 1: `tests/architecture/import-boundaries.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importsOf, layerOf, sourceFiles, violation } from './import-scan';

test('classifier self-check', () => {
  const ok = null;
  const cases: [string, string, string | null, boolean, string | null][] = [
    ['electron/core/git/git.ts', 'node:path', null, false, 'core imports only zod and yaml at runtime'],
    ['electron/core/git/git.ts', 'zod', null, false, ok],
    ['electron/core/views/rules/engine.ts', 'web-tree-sitter', null, true, ok],
    ['electron/core/views/rules/engine.ts', 'web-tree-sitter', null, false, 'core imports only zod and yaml at runtime'],
    ['electron/core/repo-map/repo-map-service.ts', '../git', 'electron/core/git/index.ts', true, ok],
    ['electron/core/repo-map/repo-map-service.ts', '../git/git', 'electron/core/git/git.ts', true, 'core features import each other only via index.ts'],
    ['electron/core/git/git.ts', '../shared/posix-path', 'electron/core/shared/posix-path.ts', false, ok],
    ['electron/core/git/git.ts', '../../adapters/driven/git/runner', 'electron/adapters/driven/git/runner.ts', true, 'core imports only core and shared/'],
    ['electron/adapters/driven/git/gh.ts', './runner', 'electron/adapters/driven/git/runner.ts', false, ok],
    ['electron/adapters/driven/stinggraph-worker/stinggraph-overlay.ts', '../git/runner', 'electron/adapters/driven/git/runner.ts', false, 'adapters never import another adapter folder'],
    ['electron/adapters/driving/ipc/git.ts', '../../driven/git/runner', 'electron/adapters/driven/git/runner.ts', true, 'adapters never import another adapter folder'],
    ['electron/adapters/driving/ipc/git.ts', '../../../app/ipc', 'electron/app/ipc.ts', false, 'only electron/app imports adapters, never the reverse'],
    ['electron/main.ts', './app', 'electron/app/index.ts', false, ok],
    ['electron/main.ts', './app/ipc', 'electron/app/ipc.ts', false, 'electron/main.ts imports only electron/app/index.ts'],
    ['shared/contracts/git.ts', '../../src/app/api', 'src/app/api.ts', true, 'shared/ imports nothing from electron/, src/, agents/'],
    ['shared/contracts/stinggraph.ts', '@colbymchenry/codegraph', null, true, ok],
    ['src/app/App.tsx', '../features/git', 'src/features/git/index.ts', false, ok],
    ['src/app/App.tsx', '../features/git/useGitState', 'src/features/git/useGitState.ts', false, 'other features only via src/features/<f>/index.ts'],
    ['src/shared/Modal.tsx', '../app/api', 'src/app/api.ts', false, 'src/shared imports no feature and no app'],
    ['src/features/runtime/LiveView.tsx', '../../../electron/core/runtime', 'electron/core/runtime/index.ts', true, 'src/ never imports electron/ or agents/'],
    ['agents/hook-client.ts', '../shared/contracts/activity', 'shared/contracts/activity.ts', true, ok],
    ['agents/hook-client.ts', '../src/features/activity/activity', 'src/features/activity/activity.ts', true, 'agents/ imports only shared/ and packages'],
  ];
  // Table paths need not exist on disk: judge them as if they did.
  for (const [from, spec, target, typeOnly, expected] of cases) assert.equal(violation(from, spec, target, typeOnly, () => true), expected, `${from} → ${spec}`);
  assert.equal(layerOf('electron/adapters/driven/fs/walk.ts').group, 'fs');
});

test('every import follows the layer rules (no allow-list)', () => {
  const failures: string[] = [];
  for (const file of sourceFiles()) {
    if (layerOf(file).kind === 'other') { failures.push(`${file}:1 → (file is in no layer)`); continue; }
    for (const ref of importsOf(file)) {
      const rule = violation(ref.file, ref.specifier, ref.target, ref.typeOnly);
      if (rule) failures.push(`${ref.file}:${ref.line} → ${ref.target ?? ref.specifier} (${rule})`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('core port slots are filled only by electron/app and tests', () => {
  const offenders = sourceFiles()
    .filter(file => !file.startsWith('electron/app/') && file !== 'electron/core/shared/ports.ts')
    .filter(file => /\b(provideGlobMatcher|provideHasher|provideSyntaxParser|resetCorePorts)\s*\(/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});
```

- [ ] **Step 2: Run** — `npx tsx --test tests/architecture/import-boundaries.test.ts`
Expected: the self-check and the provide rule PASS; "every import follows the layer rules" FAILS and prints `file:line → target (rule)` for every remaining violation.

### Task 3: Fix every violation in code

- [ ] **Step 1:** Work through the printed list. Allowed fixes, in this order of preference:
  1. Point the specifier at the target feature's `index.ts` (add the missing named export there; no `export *`). Expected bulk: renderer cross-feature imports and `src/app/*` → `src/features/<f>/…` (plan 04 left direct paths), adapters → `electron/core/<f>/<file>`, core → other core feature files.
  2. Type-only imports from another adapter folder or from an adapter into driving code: move the type to the owning core feature's `ports.ts` (as plan 05d did with `ConflictsSource`) and import it from the core index.
  3. A runtime import across adapter folders: inject the dependency from `electron/app/` (as plans 05d/05f did).
  Never add an exception list, never weaken a rule in `import-scan.ts`.
- [ ] **Step 2:** Re-run until `npx tsx --test tests/architecture/import-boundaries.test.ts` PASSES, then `npm run check` (index re-exports can create load-order cycles; fix with a direct same-feature import where the cycle is inside one feature).

### Task 4: Core cycle test (TDD)

- [ ] **Step 1: `tests/architecture/core-cycles.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importsOf, layerOf, sourceFiles } from './import-scan';

/** Reviewed core feature edges (spec 04). A new edge must be added here in a reviewed change and keep the graph acyclic. */
const INTENDED_EDGES = new Set(['repo-map→git', 'terminals→git', 'terminals→activity', 'runtime→git', 'runtime→terminals',
  'views→git', 'views→db-schema', 'views→stinggraph', 'stinggraph→git', 'app→git']);

function findCycle(edges: Set<string>): string[] | null {
  const next = new Map<string, string[]>();
  for (const e of edges) { const [a, b] = e.split('→'); next.set(a, [...(next.get(a) ?? []), b]); }
  const state = new Map<string, 'open' | 'done'>(), stack: string[] = [];
  const visit = (node: string): string[] | null => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'open') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'open'); stack.push(node);
    for (const n of next.get(node) ?? []) { const cycle = visit(n); if (cycle) return cycle; }
    stack.pop(); state.set(node, 'done');
    return null;
  };
  for (const node of next.keys()) { const cycle = visit(node); if (cycle) return cycle; }
  return null;
}

function coreEdges() {
  const edges = new Map<string, string>(); // edge -> first file:line
  for (const file of sourceFiles()) {
    const a = layerOf(file);
    if (a.kind !== 'core' || a.group === 'shared') continue;
    for (const ref of importsOf(file)) {
      if (!ref.target) continue;
      const b = layerOf(ref.target);
      if (b.kind === 'core' && b.group !== 'shared' && b.group !== a.group) {
        const edge = `${a.group}→${b.group}`;
        if (!edges.has(edge)) edges.set(edge, `${ref.file}:${ref.line}`);
      }
    }
  }
  return edges;
}

test('cycle finder self-check', () => {
  assert.equal(findCycle(new Set(['a→b', 'b→c'])), null);
  assert.deepEqual(findCycle(new Set(['a→b', 'b→c', 'c→a'])), ['a', 'b', 'c', 'a']);
});

test('core feature imports form an acyclic graph within the intended edges', () => {
  const edges = coreEdges();
  const unexpected = [...edges].filter(([edge]) => !INTENDED_EDGES.has(edge)).map(([edge, at]) => `${edge} (${at})`);
  assert.deepEqual(unexpected, [], `edges outside INTENDED_EDGES:\n${unexpected.join('\n')}`);
  const cycle = findCycle(new Set(edges.keys()));
  assert.equal(cycle, null, `cycle: ${cycle?.join(' → ')}`);
});
```

- [ ] **Step 2: Run** — PASS (fix any unexpected edge in code as in Task 3; do not widen `INTENDED_EDGES`).

### Task 5: One-time manual proof that the tests bite (noted in the PR)

- [ ] **Step 1:** Add `import { readFileSync } from 'node:fs';` to `electron/core/git/store.ts` → `npx tsx --test tests/architecture/import-boundaries.test.ts` FAILS with `electron/core/git/store.ts:N → node:fs (core imports only zod and yaml at runtime)`. Revert.
- [ ] **Step 2:** Add `import type { RepoMapService } from '../repo-map';` to `electron/core/git/git.ts` → `npx tsx --test tests/architecture/core-cycles.test.ts` FAILS (unexpected edge `git→repo-map`, cycle `git → repo-map → git`). Revert.
- [ ] **Step 3:** Append to the ledger's `## Manual checks`: "Plan 09: deliberate bad import and deliberate cycle both failed the architecture tests (then reverted)."

### Task 6: Verify and commit

- [ ] **Step 1**

```bash
npm run check 2>&1 | tail -n 12
npm run test:e2e
ls electron     # adapters app core main.ts
ls src          # app features shared
```
Expected: `# fail 0`; all e2e suites PASS.

- [ ] **Step 2: Commit**

```bash
git add -A tests electron src shared agents docs/plans/2026-11-23-test-edit-ledger.md
git commit -m "test(architecture): strict import-boundary and core-cycle tests"
```

## Self-review

- Spec coverage: scanner over the four roots with static/side-effect/dynamic imports and the type-only flag; resolution `.ts`/`.tsx`/`/index.ts(x)`/exact; layer table incl. type-only exemption from package rules only; cross-feature via `index.ts` (core and `src/features`); adapter folder isolation; `main.ts` → `app/index.ts` only; `shared/`, `src/`, `agents/` rules; no allow-list; `file:line → target (rule)` output; self-check table; cycle test with `INTENDED_EDGES`; approved provide* rule; manual bite check.
