# 05a · Git feature extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution rules (every plan of this PR):** the executor runs the plans sequentially, one plan at a time, in the
> order of [the index](2026-11-23-modular-restructure-plan.md). Every commit passes `npm run check`. Never edit or delete
> an existing test assertion except those the spec lists; every allowed test edit is recorded in
> `docs/plans/2026-11-23-test-edit-ledger.md` in the same commit. Branch: `chore/modular-restructure`. Do not push or open
> the PR before plan 10's last task. Never stage `release/`, `artifacts/`, `dist*/`, `node_modules/`.

**Goal:** `electron/core/git/` becomes pure logic behind ports (no `node:*`), with driven adapters, fakes, core unit
tests, the `WorkspaceLifecycle` (failure-isolation rule 3 core), and the git audit fixes: 3 (removal consent
fingerprint), 6 (one git runner with `core.fsmonitor=false`), git error detail, branch exists, status buffer.

**Architecture:** core classes take ports in their constructors; `electron/app/wiring/git.ts` builds them with the real
adapters under the old names/signatures (`new GitService(store, count?, hooks?)`, `new Store(dir)`, `git(cwd, args)`,
`new GitStateService(git, prs, emit, visible?, options?)`), so existing tests only change import paths. Shared pure
helpers appear in `electron/core/shared/` (`posix-path.ts`, `ports.ts` with the `Hasher` slot).

**Tech Stack:** TypeScript, zod, node:test, real git for adapter tests.

**Spec:** [04 § Commit 5](../specs/2026-11-23-04-hexagonal-modules-design.md#commit-5--per-feature-extraction) (git row, rule 3),
[07 § 3, § 6, Small fixes](../specs/2026-11-23-07-audit-fixes-design.md).

**Plan-level clarifications (approved):** (1) `Hasher`/`GlobMatcher`/`SyntaxParser` are module-level slots in
`electron/core/shared/ports.ts` (`provide*`/`reset*`), called only from `electron/app/**` and tests. (5) No legacy
consent path: the fingerprint is required everywhere; the existing unit-test calls pass
`(await service.reviewRemoval(id)).fingerprint` (ledger), and a new test proves a consent without fingerprint is refused.

**Depends on:** plan 04 committed. **Commit:** one, `refactor(git): extract git core behind ports; one git runner; removal consent fingerprint`.

---

## Files

Create:
- `electron/core/shared/posix-path.ts`, `electron/core/shared/ports.ts`
- `electron/core/git/ports.ts`, `electron/core/git/workspace-lifecycle.ts`
- `electron/adapters/driven/git/runner.ts`, `electron/adapters/driven/git/watcher.ts`, `electron/adapters/driven/git/gh.ts`
- `electron/adapters/driven/fs/workspace-files.ts`, `electron/adapters/driven/fs/hash.ts`
- `electron/adapters/driven/sqlite/state-repository.ts`
- `electron/adapters/driving/ipc/git.ts`
- `electron/app/wiring/git.ts`
- `tests/fakes/git.ts`
- `tests/views/posix-path.test.ts`, `tests/git/runner.test.ts`, `tests/git/git.core.test.ts`, `tests/git/git-state.core.test.ts`, `tests/git/workspace-lifecycle.test.ts`

Modify: `electron/core/git/{git,git-state,git-lines,store,pull-requests,worktree-removal,index}.ts`,
`electron/adapters/driven/git/{clone,git-exclude}.ts`, `electron/core/repo-map/repo-map.ts` (runner only),
`electron/adapters/driven/stinggraph-worker/stinggraph-overlay.ts` (runner only), `electron/adapters/driving/cli/views-cli.ts` (runner only),
`electron/main.ts`, `shared/contracts/git.ts`, `src/features/git/RemoveWorktreeForm.tsx`, `src/features/git/demo.ts`,
`tests/git/{git,worktree-removal,git-state,git-lines,clone,git-exclude}.test.ts` and other tests importing `git`/`GitService`/`Store` (paths),
`tests/git/worktree-removal.mjs` (one new check), ledger.

---

### Task 1: `posix-path.ts` (TDD against `node:path.posix`)

- [ ] **Step 1: Write `tests/views/posix-path.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as posix from '../../electron/core/shared/posix-path';

const inputs = ['', '.', '..', '/', '//', '///a', 'a', 'a/', 'a//b', 'a/./b', 'a/../b', '../a', '../../a/b', '/a/b/c', '/a/b/c/',
  '/a/../../b', 'a/b/../../..', '.git', 'a/.hidden', 'a/b.c', 'a/b.c.d', 'a/.b', 'a/b.', 'a/..b', 'file.tar.gz', '/x/y/z.ts', 'src/app/main.tsx'];

test('normalize, dirname, basename, extname, isAbsolute match node:path.posix', () => {
  for (const p of inputs) {
    assert.equal(posix.normalize(p), path.posix.normalize(p), `normalize ${JSON.stringify(p)}`);
    assert.equal(posix.dirname(p), path.posix.dirname(p), `dirname ${JSON.stringify(p)}`);
    assert.equal(posix.basename(p), path.posix.basename(p), `basename ${JSON.stringify(p)}`);
    for (const suffix of ['.ts', '.c', 'c', 'b.c']) assert.equal(posix.basename(p, suffix), path.posix.basename(p, suffix), `basename ${JSON.stringify(p)} ${suffix}`);
    assert.equal(posix.extname(p), path.posix.extname(p), `extname ${JSON.stringify(p)}`);
    assert.equal(posix.isAbsolute(p), path.posix.isAbsolute(p), `isAbsolute ${JSON.stringify(p)}`);
  }
});

test('join matches node:path.posix', () => {
  const parts: string[][] = [[], [''], ['a'], ['a', 'b'], ['/a', '../b'], ['a', '', 'b'], ['/', 'a'], ['a/', '/b/'], ['..', 'a'], ['/a/b', '../../..', 'c'], ['.', '.']];
  for (const p of parts) assert.equal(posix.join(...p), path.posix.join(...p), JSON.stringify(p));
});

test('relative matches node:path.posix for absolute paths and rejects relative input', () => {
  const abs = ['/', '/a', '/a/b', '/a/b/c', '/a/bc', '/x/y', '/a/b/', '/a//b/../c'];
  for (const from of abs) for (const to of abs) assert.equal(posix.relative(from, to), path.posix.relative(from, to), `${from} -> ${to}`);
  assert.throws(() => posix.relative('a', '/b'));
  assert.equal(posix.sep, '/');
});
```

- [ ] **Step 2: Run** — `npx tsx --test tests/views/posix-path.test.ts` → FAIL (module missing).

- [ ] **Step 3: Create `electron/core/shared/posix-path.ts`** (port of Node's posix algorithms; core works on POSIX paths only)

```ts
// POSIX path helpers for core (no node:path). Same results as node:path.posix; relative() needs absolute paths
// because core has no working directory (tests/views/posix-path.test.ts compares every helper with node:path.posix).
export const sep = '/';
const SLASH = 47, DOT = 46;

function normalizeString(path: string, allowAboveRoot: boolean): string {
  let res = '', lastSegmentLength = 0, lastSlash = -1, dots = 0, code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (code === SLASH) break;
    else code = SLASH;
    if (code === SLASH) {
      if (lastSlash === i - 1 || dots === 1) { /* skip */ } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== DOT || res.charCodeAt(res.length - 2) !== DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('/');
            if (lastSlashIndex === -1) { res = ''; lastSegmentLength = 0; } else { res = res.slice(0, lastSlashIndex); lastSegmentLength = res.length - 1 - res.lastIndexOf('/'); }
            lastSlash = i; dots = 0; continue;
          } else if (res.length !== 0) { res = ''; lastSegmentLength = 0; lastSlash = i; dots = 0; continue; }
        }
        if (allowAboveRoot) { res += res.length > 0 ? '/..' : '..'; lastSegmentLength = 2; }
      } else {
        res = res.length > 0 ? `${res}/${path.slice(lastSlash + 1, i)}` : path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i; dots = 0;
    } else if (code === DOT && dots !== -1) ++dots;
    else dots = -1;
  }
  return res;
}

export const isAbsolute = (path: string) => path.length > 0 && path.charCodeAt(0) === SLASH;

export function normalize(path: string): string {
  if (path.length === 0) return '.';
  const absolute = isAbsolute(path), trailing = path.charCodeAt(path.length - 1) === SLASH;
  let out = normalizeString(path, !absolute);
  if (out.length === 0) { if (absolute) return '/'; return trailing ? './' : '.'; }
  if (trailing) out += '/';
  return absolute ? `/${out}` : out;
}

export function join(...parts: string[]): string {
  const joined = parts.filter(p => p.length > 0).join('/');
  return joined.length === 0 ? '.' : normalize(joined);
}

export function dirname(path: string): string {
  if (path.length === 0) return '.';
  const hasRoot = path.charCodeAt(0) === SLASH;
  let end = -1, matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === SLASH) { if (!matchedSlash) { end = i; break; } } else matchedSlash = false;
  }
  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
}

export function basename(path: string, suffix?: string): string {
  let start = 0, end = -1, matchedSlash = true;
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return '';
    let extIdx = suffix.length - 1, firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === SLASH) { if (!matchedSlash) { start = i + 1; break; } } else {
        if (firstNonSlashEnd === -1) { matchedSlash = false; firstNonSlashEnd = i + 1; }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) { if (--extIdx === -1) end = i; } else { extIdx = -1; end = firstNonSlashEnd; }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd; else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === SLASH) { if (!matchedSlash) { start = i + 1; break; } } else if (end === -1) { matchedSlash = false; end = i + 1; }
  }
  return end === -1 ? '' : path.slice(start, end);
}

export function extname(path: string): string {
  let startDot = -1, startPart = 0, end = -1, matchedSlash = true, preDotState = 0;
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i);
    if (code === SLASH) { if (!matchedSlash) { startPart = i + 1; break; } continue; }
    if (end === -1) { matchedSlash = false; end = i + 1; }
    if (code === DOT) { if (startDot === -1) startDot = i; else if (preDotState !== 1) preDotState = 1; } else if (startDot !== -1) preDotState = -1;
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) return '';
  return path.slice(startDot, end);
}

const resolveAbsolute = (path: string) => `/${normalizeString(path, false)}`;
export function relative(from: string, to: string): string {
  if (!isAbsolute(from) || !isAbsolute(to)) throw new Error('posix-path.relative needs absolute paths.');
  if (from === to) return '';
  from = resolveAbsolute(from); to = resolveAbsolute(to);
  if (from === to) return '';
  const fromStart = 1, fromEnd = from.length, fromLen = fromEnd - fromStart, toStart = 1, toLen = to.length - toStart;
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1, i = 0;
  for (; i < length; i++) {
    const fromCode = from.charCodeAt(fromStart + i);
    if (fromCode !== to.charCodeAt(toStart + i)) break;
    else if (fromCode === SLASH) lastCommonSep = i;
  }
  if (i === length) {
    if (toLen > length) {
      if (to.charCodeAt(toStart + i) === SLASH) return to.slice(toStart + i + 1);
      if (i === 0) return to.slice(toStart + i);
    } else if (fromLen > length) {
      if (from.charCodeAt(fromStart + i) === SLASH) lastCommonSep = i; else if (i === 0) lastCommonSep = 0;
    }
  }
  let out = '';
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) if (i === fromEnd || from.charCodeAt(i) === SLASH) out += out.length === 0 ? '..' : '/..';
  return `${out}${to.slice(toStart + lastCommonSep)}`;
}
```

- [ ] **Step 4: Run** — PASS.

### Task 2: Core shared ports slot (`Hasher`)

- [ ] **Step 1: Create `electron/core/shared/ports.ts`**

```ts
// Ports every core feature may use. Filled once per process by electron/app (wiring, worker and CLI entries) and by
// tests (fakes); nothing else calls provide*/resetCorePorts (enforced by tests/architecture/import-boundaries.test.ts).
export interface Hasher { /** sha256 of UTF-8 text as 64 lowercase hex characters. */ sha256(text: string): string }

let hasher: Hasher | undefined;
const missing = (port: string) => new Error(`${port} port not provided; wire it in electron/app.`);
export function provideHasher(value: Hasher) { hasher = value; }
export function sha256(text: string): string { if (!hasher) throw missing('Hasher'); return hasher.sha256(text); }
/** Tests only: forget every provided port. */
export function resetCorePorts() { hasher = undefined; }
```

- [ ] **Step 2: Create `electron/adapters/driven/fs/hash.ts`**

```ts
import { createHash } from 'node:crypto';
import type { Hasher } from '../../../core/shared/ports';

export const nodeHasher: Hasher = { sha256: text => createHash('sha256').update(text).digest('hex') };
```

### Task 3: One git runner (audit 6 + git error detail) (TDD)

- [ ] **Step 1: Write `tests/git/runner.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GIT_SAFE_CONFIG, git, runGit } from '../../electron/adapters/driven/git/runner';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), 'stingray-runner-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { env });
  return root;
}

test('runGit ignores a repository core.fsmonitor program', async () => {
  const root = await repo();
  try {
    const marker = path.join(root, '..', path.basename(root) + '-fsmonitor-ran');
    const script = path.join(root, '..', path.basename(root) + '-fsmonitor.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.fsmonitor', script], { cwd: root, env });
    await runGit(root, ['status', '--porcelain']);
    assert.equal(existsSync(marker), false, 'fsmonitor must not run');
    execFileSync('git', ['status', '--porcelain'], { cwd: root, env, stdio: 'ignore' });
    assert.equal(existsSync(marker), true, 'control: plain git runs it');
    await rm(marker, { force: true }); await rm(script, { force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runGit ignores repository hooks', async () => {
  const root = await repo();
  try {
    const hooks = path.join(root, '.git', 'custom-hooks'); await mkdir(hooks);
    const marker = path.join(root, '.git', 'hook-ran');
    await writeFile(path.join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.hooksPath', hooks], { cwd: root, env });
    await runGit(root, ['-c', 'user.name=T', '-c', 'user.email=t@invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'x']);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(GIT_SAFE_CONFIG, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('git() failures carry the first stderr line, without control characters or URL credentials', async () => {
  const root = await repo();
  try {
    await assert.rejects(git(root, ['worktree', 'add', '-b', 'x', path.join(root, 'wt'), 'HEAD']),
      (e: Error) => /^Git operation failed: .*HEAD.*\. Check the repository, branch, and worktree on disk\. No force operation was attempted\.$/.test(e.message));
    await assert.rejects(git(root, ['fetch', 'https://user:secret@127.0.0.1:1/x.git']),
      (e: Error) => e.message.startsWith('Git operation failed') && !e.message.includes('secret') && e.message.length < 400);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('no git process is spawned outside electron/adapters/driven/git/', async () => {
  const offenders: string[] = [];
  for (const file of await readdir('electron', { recursive: true })) {
    if (!file.endsWith('.ts') || file.startsWith(path.join('adapters', 'driven', 'git'))) continue;
    const text = await readFile(path.join('electron', file), 'utf8');
    if (text.includes("'node:child_process'") && /['"]git['"]/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
```

- [ ] **Step 2: Run** — `npx tsx --test tests/git/runner.test.ts` → FAIL (module missing).

- [ ] **Step 3: Create `electron/adapters/driven/git/runner.ts`**

```ts
// The one git runner: no repository hooks or fsmonitor programs, no prompts, no optional locks.
// Callers keep their own timeouts, buffer limits and error wrapping.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const GIT_SAFE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
export type RunGitOptions = { timeout?: number; maxBuffer?: number; env?: Record<string, string> };

export async function runGit(cwd: string, args: string[], options?: RunGitOptions): Promise<string>;
export async function runGit(cwd: string, args: string[], options: RunGitOptions & { encoding: 'buffer' }): Promise<Buffer>;
export async function runGit(cwd: string, args: string[], options: RunGitOptions & { encoding?: 'buffer' } = {}): Promise<string | Buffer> {
  const { stdout } = await exec('git', [...GIT_SAFE_CONFIG, ...args], {
    cwd, timeout: options.timeout ?? 30000, maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    encoding: options.encoding ?? 'utf8', env: { ...process.env, ...GIT_ENV, ...options.env },
  });
  return stdout;
}

/** First non-empty stderr line: control characters stripped, URL credentials redacted, at most 200 characters. */
export function gitFailureDetail(error: unknown): string {
  const stderr = String((error as { stderr?: unknown })?.stderr ?? '');
  const line = stderr.split('\n').map(l => l.replace(/[\x00-\x1f\x7f]/g, '').trim()).find(Boolean) ?? '';
  return line.replace(/:\/\/[^/@\s]*@/g, '://<redacted>@').slice(0, 200);
}

/** Bounded git for workspace operations, with a fixed, user-facing failure message. Implements the core GitRunner port. */
export async function git(cwd: string, args: string[], options: { timeout?: number; maxBuffer?: number } = {}): Promise<string> {
  try { return await runGit(cwd, args, { timeout: options.timeout ?? 30000, maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024 }); } catch (error) {
    const detail = gitFailureDetail(error);
    throw new Error(`Git operation failed${detail ? `: ${detail.replace(/\.$/, '')}` : ''}. Check the repository, branch, and worktree on disk. No force operation was attempted.`);
  }
}
```

- [ ] **Step 4: Switch every git spawn to the runner** (callers keep their timeouts, buffers and error wrapping)

| File | Change |
|---|---|
| `electron/adapters/driven/git/clone.ts:10-14` | `spawn('git', [...GIT_SAFE_CONFIG, '-c', 'protocol.allow=never', …])` — delete the old `'-c', 'core.hooksPath=/dev/null',` pair; keep every other flag in order; `import { GIT_SAFE_CONFIG } from './runner';` |
| `electron/adapters/driven/git/git-exclude.ts:14-15` | `const stdout = await runGit(root, ['rev-parse', '--git-path', 'info/exclude'], { timeout: 10_000, maxBuffer: 1024 * 1024 });`; drop `execFile`/`promisify`/`exec` |
| `electron/core/git/git-lines.ts:5-13` | delete `exec` and the default `run`; `readGitLines(cwd, changes, runner: LineRunner, base = 'HEAD')` and `originMainBase(cwd, runner: LineRunner)` take a required runner; no node imports remain |
| `electron/core/git/pull-requests.ts:1-22` | delete the default `run` and node imports; constructor `constructor(private execute: PRRunner, private now = Date.now)`; in `branchStatus` drop the `'-c', 'core.hooksPath=/dev/null',` pair from the `for-each-ref` args |
| `electron/core/repo-map/repo-map.ts` | `inventoryGit`: `return await runGit(root, args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024 })` inside the existing try/catch; the `show-ref` call: `await runGit(root, ['show-ref', '--verify', '--quiet', branch], { timeout: 10000, maxBuffer: 4096 })` inside the existing try/catch; `boundedGit`: `return runGit(root, args, { timeout: 10000, maxBuffer: maxBytes, encoding: 'buffer' })`; `import { git, runGit } from '../../adapters/driven/git/runner'` replaces `import { git } from '../git/git'` and the `execFile`/`promisify` imports (temporary core→adapter import, removed in plan 05e) |
| `electron/adapters/driven/stinggraph-worker/stinggraph-overlay.ts:19-25` | `gitOut` body: `return runGit(cwd, args, { timeout: 0, maxBuffer: 1 << 28, env });` with `import { runGit } from '../git/runner'` (temporary cross-adapter import, replaced by injection in plan 05d); drop `execFile`/`promisify` |
| `electron/adapters/driving/cli/views-cli.ts:55,64` | `worktreeRoot`: `(await runGit(dir, ['rev-parse', '--show-toplevel'], { timeout: 10_000 })).trim()`; drop `exec`/`execFile`/`promisify` (temporary driving→driven import, moved to `electron/app/` wiring in plan 05f) |

New file `electron/adapters/driven/git/gh.ts` — the default `PRRunner`, moved from `pull-requests.ts:6-22`, with git delegating to the runner:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PRRunner } from '../../../core/git';
import { GIT_ENV, runGit } from './runner';

const exec = promisify(execFile);
export const ghRunner: PRRunner = async (command, args, cwd) => {
  if (command === 'git') return runGit(cwd, args, { timeout: 15000, maxBuffer: 1024 * 1024 });
  const env = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', ...GIT_ENV };
  delete (env as NodeJS.ProcessEnv).GH_DEBUG;
  // Finder's PATH may not include Homebrew. Never install or log in automatically.
  const candidates = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
  for (const executable of candidates) {
    try {
      // PR lists are trimmed with --jq (~20 KB for 100 PRs plus headers).
      return (await exec(executable, args, { cwd, env, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || executable === candidates.at(-1)) throw error;
    }
  }
  throw new Error('Command unavailable');
};
```

- [ ] **Step 5: Run** — `npx tsx --test tests/git/runner.test.ts` → the scan test still FAILS until Task 6 removes `node:child_process` from `core/git/git.ts`; the other three PASS.

### Task 4: Git ports, adapters and `Store`

- [ ] **Step 1: Create `electron/core/git/ports.ts`**

```ts
import type { State, WorkspaceGitState } from '../../../shared/contracts/git';

/** Bounded git returning stdout; rejects with a user-facing "Git operation failed…" message. */
export type GitRunner = (cwd: string, args: string[], options?: { timeout?: number; maxBuffer?: number }) => Promise<string>;
export interface WorkspaceFiles {
  realpath(path: string): Promise<string>;
  /** mkdir -p with this mode. */
  mkdirp(path: string, mode: number): Promise<void>;
  /** Exclusive mkdir: rejects when anything (file, empty dir, symlink) already exists. */
  mkdirExclusive(path: string, mode: number): Promise<void>;
  /** lstat says directory; false when missing or unreadable. */
  isDirectory(path: string): Promise<boolean>;
}
export interface StateRepository { load(): Promise<State>; save(state: State): Promise<void> }
export interface WatchHandle { close(): void; on(event: 'error', listener: (error: Error) => void): unknown }
export interface GitDirWatcher {
  /** `git rev-parse --git-dir --git-common-dir` as absolute paths; rejects when unreadable. */
  gitDirs(workspacePath: string): Promise<{ gitDir: string; common: string }>;
  /** Recursive watch of a common .git dir; filename is POSIX and relative ('' when unknown). Throws when unavailable. */
  watch(common: string, onChange: (filename: string) => void): WatchHandle;
}
export type PRRunner = (command: 'git' | 'gh', args: string[], cwd: string) => Promise<string>;
export type Cloner = (url: string, target: string, parent: string) => Promise<void>;
export type GitStatePublisher = (state: WorkspaceGitState) => void;
```
`pull-requests.ts` now imports `PRRunner` from `./ports` (delete its local type and re-export it from `./ports` in `index.ts`).

- [ ] **Step 2: `electron/core/git/store.ts`**

```ts
import { stateSchema, type State } from '../../../shared/contracts/git';
import type { StateRepository } from './ports';

/** Repositories and workspaces. `directory` is the app data dir (managed worktrees live in <directory>/worktrees). */
export class Store {
  constructor(readonly directory: string, private readonly repository: StateRepository) {}
  load(): Promise<State> { return this.repository.load(); }
  async save(state: State) { await this.repository.save(stateSchema.parse(state)); }
}
```

- [ ] **Step 3: Driven adapters**

`electron/adapters/driven/sqlite/state-repository.ts`:
```ts
import type { State } from '../../../../shared/contracts/git';
import type { StateRepository } from '../../../core/git';
import { database, readState, transaction, writeState } from './database';

/** The `repos` and `workspaces` tables of the app database. */
export function sqliteStateRepository(directory: string): StateRepository {
  return {
    async load() { return readState(database(directory)); },
    async save(state: State) { const db = database(directory); transaction(db, () => writeState(db, state)); },
  };
}
```
`electron/adapters/driven/fs/workspace-files.ts`:
```ts
import { lstat, mkdir, realpath } from 'node:fs/promises';
import type { WorkspaceFiles } from '../../../core/git';

export const nodeWorkspaceFiles: WorkspaceFiles = {
  realpath: p => realpath(p),
  mkdirp: async (p, mode) => { await mkdir(p, { recursive: true, mode }); },
  mkdirExclusive: async (p, mode) => { await mkdir(p, { mode }); },
  isDirectory: p => lstat(p).then(s => s.isDirectory(), () => false),
};
```
`electron/adapters/driven/git/watcher.ts`:
```ts
import { watch } from 'node:fs';
import path from 'node:path';
import type { GitDirWatcher } from '../../../core/git';
import { git } from './runner';

export const nodeGitDirWatcher: GitDirWatcher = {
  async gitDirs(workspacePath) {
    const [gitDir, common] = (await git(workspacePath, ['rev-parse', '--git-dir', '--git-common-dir'])).trim().split('\n').map(dir => path.resolve(workspacePath, dir));
    return { gitDir, common };
  },
  watch: (common, onChange) => watch(common, { recursive: true }, (_event, filename) => onChange((filename?.toString() ?? '').split(path.sep).join('/'))),
};
```

- [ ] **Step 4: Export the new names from `electron/core/git/index.ts`** — add `export type { GitRunner, WorkspaceFiles, StateRepository, WatchHandle, GitDirWatcher, PRRunner, Cloner, GitStatePublisher } from './ports';`, `export { Store } from './store';`, `export { WorkspaceLifecycle } from './workspace-lifecycle';`, `export { removalFingerprint } from './git';` (Tasks 5-6).

### Task 5: `WorkspaceLifecycle` (rule 3 core) (TDD)

- [ ] **Step 1: Write `tests/git/workspace-lifecycle.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceLifecycle } from '../../electron/core/git';

const quiet = () => { const logged: string[] = []; return { logged, log: (m: string) => { logged.push(m); } }; };

test('listeners of one phase run independently; non-blocking failures are logged only', async () => {
  const { logged, log } = quiet();
  const lifecycle = new WorkspaceLifecycle(log);
  const ran: string[] = [];
  lifecycle.onAfterRemove('view state', async () => { ran.push('view state'); throw new Error('db locked'); });
  lifecycle.onAfterRemove('activity', () => { ran.push('activity'); });
  lifecycle.onAfterRemove('git-state', () => { ran.push('git-state'); });
  await lifecycle.runAfterRemove('w1');
  assert.deepEqual(ran, ['view state', 'activity', 'git-state']);
  assert.ok(logged.some(m => m.includes('view state')));
});

test('a blocking beforeRemove failure rejects after every listener ran; a non-blocking one does not', async () => {
  const { log } = quiet();
  const lifecycle = new WorkspaceLifecycle(log);
  const ran: string[] = [];
  lifecycle.onBeforeRemove('views', async () => { ran.push('views'); throw new Error('views release failed'); });
  lifecycle.onBeforeRemove('terminals', () => { ran.push('terminals'); }, { blocking: true });
  await lifecycle.runBeforeRemove('w1');
  lifecycle.onBeforeRemove('graph', async () => { ran.push('graph'); throw new Error('Could not stop the code graph'); }, { blocking: true });
  await assert.rejects(lifecycle.runBeforeRemove('w1'), /Could not stop the code graph/);
  assert.deepEqual(ran, ['views', 'terminals', 'views', 'terminals', 'graph']);
});
```

- [ ] **Step 2: Run** — FAIL (export missing).

- [ ] **Step 3: Create `electron/core/git/workspace-lifecycle.ts`**

```ts
// Workspace create/remove side effects of other features (back-edges as listeners, not imports). Listeners of a phase
// run independently (Promise.allSettled); only safety-critical beforeRemove listeners are blocking (rule 3).
type Listener = (workspaceId: string) => void | Promise<void>;
type Entry = { name: string; run: Listener; blocking: boolean };

export class WorkspaceLifecycle {
  private readonly created: Entry[] = [];
  private readonly before: Entry[] = [];
  private readonly after: Entry[] = [];
  private readonly failed: Entry[] = [];
  constructor(private readonly log: (message: string, error: unknown) => void = (message, error) => console.error(message, error)) {}

  onCreated(name: string, run: Listener) { this.created.push({ name, run, blocking: false }); }
  /** blocking: a rejection aborts the removal (after every beforeRemove listener ran). */
  onBeforeRemove(name: string, run: Listener, options: { blocking?: boolean } = {}) { this.before.push({ name, run, blocking: options.blocking ?? false }); }
  onAfterRemove(name: string, run: Listener) { this.after.push({ name, run, blocking: false }); }
  onRemoveFailed(name: string, run: Listener) { this.failed.push({ name, run, blocking: false }); }

  async runCreated(id: string) { await this.run(this.created, id, 'created'); }
  async runBeforeRemove(id: string) { const blocking = await this.run(this.before, id, 'beforeRemove'); if (blocking) throw blocking.error; }
  async runAfterRemove(id: string) { await this.run(this.after, id, 'afterRemove'); }
  async runRemoveFailed(id: string) { await this.run(this.failed, id, 'removeFailed'); }

  private async run(entries: Entry[], id: string, phase: string): Promise<{ error: unknown } | undefined> {
    const results = await Promise.allSettled(entries.map(entry => Promise.resolve().then(() => entry.run(id))));
    let blocking: { error: unknown } | undefined;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') return;
      this.log(`Workspace ${phase} listener "${entries[i].name}" failed:`, result.reason);
      if (entries[i].blocking && !blocking) blocking = { error: result.reason };
    });
    return blocking;
  }
}
```

- [ ] **Step 4: Run** — PASS.

### Task 6: Pure `GitService` with fingerprint, stale consent, branch exists, status buffer (TDD)

- [ ] **Step 1: Write `tests/fakes/git.ts`**

```ts
// Fake adapters for electron/core/git: scripted git, in-memory state, path-only files, manual .git watcher.
import type { GitDirWatcher, GitRunner, StateRepository, WatchHandle, WorkspaceFiles } from '../../electron/core/git';
import type { Hasher } from '../../electron/core/shared/ports';
import type { State } from '../../shared/contracts/git';

export type GitCall = { cwd: string; args: string[]; options?: { timeout?: number; maxBuffer?: number } };
/** `script` returns stdout, or undefined to fail the call like a git error. */
export function scriptedGit(script: (cwd: string, args: string[]) => string | undefined): GitRunner & { calls: GitCall[] } {
  const calls: GitCall[] = [];
  const run = (async (cwd, args, options) => {
    calls.push({ cwd, args, options });
    const out = script(cwd, args);
    if (out === undefined) throw new Error('Git operation failed. Check the repository, branch, and worktree on disk. No force operation was attempted.');
    return out;
  }) as GitRunner & { calls: GitCall[] };
  run.calls = calls;
  return run;
}
export function memoryState(initial: State): StateRepository & { saved: State[] } {
  let current = structuredClone(initial);
  const saved: State[] = [];
  return { saved, async load() { return structuredClone(current); }, async save(state) { current = structuredClone(state); saved.push(structuredClone(state)); } };
}
export const pathOnlyFiles: WorkspaceFiles = { realpath: async p => p, mkdirp: async () => {}, mkdirExclusive: async () => {}, isDirectory: async () => false };
/** Deterministic, non-cryptographic: 64 hex chars. */
export const fakeHasher: Hasher = { sha256: text => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0; return h.toString(16).padStart(8, '0').repeat(8); } };
export function manualWatcher(dirs = { gitDir: '/repo/.git', common: '/repo/.git' }) {
  const handles: { common: string; onChange: (f: string) => void; closed: boolean }[] = [];
  const watcher: GitDirWatcher = {
    gitDirs: async () => dirs,
    watch(common, onChange) {
      const entry = { common, onChange, closed: false };
      handles.push(entry);
      const handle: WatchHandle = { close: () => { entry.closed = true; }, on: () => handle };
      return handle;
    },
  };
  return { watcher, handles, change: (filename: string) => { for (const h of handles) if (!h.closed) h.onChange(filename); } };
}
```

- [ ] **Step 2: Write `tests/git/git.core.test.ts`**

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GitService, Store, WorkspaceLifecycle, removalFingerprint } from '../../electron/core/git';
import { provideHasher, resetCorePorts } from '../../electron/core/shared/ports';
import type { State } from '../../shared/contracts/git';
import { fakeHasher, memoryState, pathOnlyFiles, scriptedGit } from '../fakes/git';

const repoId = '00000000-0000-4000-8000-000000000001', id = '00000000-0000-4000-8000-000000000002';
const wpath = `/data/worktrees/${repoId}/${id}`;
const initial: State = { version: 1, repos: [{ id: repoId, name: 'repo', path: '/repo' }], workspaces: [
  { id: repoId.replace(/1$/, '3'), repoId, name: 'main', branch: 'main', path: '/repo', managed: false, previewUrl: '' },
  { id, repoId, name: 'feature', branch: 'feature', path: wpath, managed: true, previewUrl: '' }] };
beforeEach(() => provideHasher(fakeHasher));
afterEach(() => resetCorePorts());

function service(dirty: { value: string }) {
  const runner = scriptedGit((cwd, args) => {
    const a = args.join(' ');
    if (a === 'worktree list --porcelain -z') return `worktree /repo\0branch refs/heads/main\0\0worktree ${wpath}\0branch refs/heads/feature\0\0`;
    if (a === 'branch --show-current') return cwd === wpath ? 'feature\n' : 'main\n';
    if (a.startsWith('status --porcelain=v1 -z --untracked-files=normal')) return dirty.value;
    if (a.startsWith('for-each-ref --format=%(upstream)')) return '\n';
    if (a.startsWith('worktree remove') || a.startsWith('clean')) return '';
    return undefined;
  });
  const repository = memoryState(initial);
  const lifecycle = new WorkspaceLifecycle(() => {});
  const git = new GitService({ store: new Store('/data', repository), runner, files: pathOnlyFiles, cloner: async () => {}, lifecycle });
  return { git, runner, repository, lifecycle };
}

test('the removal fingerprint changes with any change, the push status or the upstream tip', () => {
  const base = { branch: 'feature', changes: [{ status: '??', path: 'a.txt' }], blockers: [], push: { kind: 'known' as const, upstream: 'origin/feature', ahead: 0, behind: 0 }, merged: null, identity: 'refs/remotes/origin/feature:aaa' };
  provideHasher(fakeHasher);
  const f = removalFingerprint(base);
  assert.match(f, /^[0-9a-f]{64}$/);
  assert.equal(removalFingerprint({ ...base, changes: [...base.changes] }), f);
  assert.notEqual(removalFingerprint({ ...base, changes: [...base.changes, { status: ' M', path: 'b.txt' }] }), f);
  assert.notEqual(removalFingerprint({ ...base, push: { ...base.push, ahead: 1 } }), f);
  assert.notEqual(removalFingerprint({ ...base, identity: 'refs/remotes/origin/feature:bbb' }), f);
});

test('stale consent removes nothing and returns the fresh review', async () => {
  const dirty = { value: '' };
  const { git, runner, repository } = service(dirty);
  const review = await git.reviewRemoval(id);
  dirty.value = '?? appeared.txt\0';
  let before = 0;
  const result = await git.removeWorkspace(id, { discard: true, deleteBranch: false, fingerprint: review.fingerprint });
  assert.ok('stale' in result && result.stale.changes.untracked === 1 && result.stale.changes.paths.includes('appeared.txt'));
  assert.equal(runner.calls.some(c => c.args[0] === 'worktree' && c.args[1] === 'remove'), false);
  assert.equal(repository.saved.length, before);
});

test('a consent without fingerprint is refused', async () => {
  const { git } = service({ value: '' });
  await assert.rejects(git.removeWorkspace(id, { discard: false, deleteBranch: false } as never), /Confirm the removal first/);
});

test('blocking beforeRemove failure aborts the removal and runs removeFailed; afterRemove failures never fail it', async () => {
  const { git, runner, lifecycle } = service({ value: '' });
  const ran: string[] = [];
  lifecycle.onBeforeRemove('terminals', () => { throw new Error('Terminals could not be closed.'); }, { blocking: true });
  lifecycle.onRemoveFailed('views', () => { ran.push('removeFailed'); });
  const review = await git.reviewRemoval(id);
  await assert.rejects(git.removeWorkspace(id, { discard: false, deleteBranch: false, fingerprint: review.fingerprint }), /Terminals could not be closed/);
  assert.deepEqual(ran, ['removeFailed']);
  assert.equal(runner.calls.some(c => c.args[1] === 'remove'), false);

  const ok = service({ value: '' });
  ok.lifecycle.onAfterRemove('view state', async () => { throw new Error('db locked'); });
  ok.lifecycle.onAfterRemove('activity', () => { ran.push('activity'); });
  const fresh = await ok.git.reviewRemoval(id);
  const result = await ok.git.removeWorkspace(id, { discard: false, deleteBranch: false, fingerprint: fresh.fingerprint });
  assert.ok('state' in result && result.state.workspaces.length === 1);
  assert.ok(ran.includes('activity'));
});

test('createWorkspace refuses an existing branch with a clear message', async () => {
  const runner = scriptedGit((_cwd, args) => (args[0] === 'check-ref-format' || args[0] === 'rev-parse' ? 'ok\n' : undefined));
  const git = new GitService({ store: new Store('/data', memoryState(initial)), runner, files: pathOnlyFiles, cloner: async () => {}, lifecycle: new WorkspaceLifecycle(() => {}) });
  await assert.rejects(git.createWorkspace(repoId, 'feature'), /^Error: Branch feature already exists\. Choose another name\.$/);
  assert.equal(runner.calls.some(c => c.args[0] === 'worktree'), false);
});

test('status reads with a 16 MiB buffer', async () => {
  const runner = scriptedGit((_cwd, args) => (args[0] === 'branch' ? 'feature\n' : args[0] === 'status' ? '' : args[0] === 'diff' ? '' : undefined));
  const git = new GitService({ store: new Store('/data', memoryState(initial)), runner, files: pathOnlyFiles, cloner: async () => {}, lifecycle: new WorkspaceLifecycle(() => {}) });
  await git.status(id);
  assert.equal(runner.calls.find(c => c.args[0] === 'status')!.options?.maxBuffer, 16 * 1024 * 1024);
});
```

- [ ] **Step 3: Run** — `npx tsx --test tests/git/git.core.test.ts` → FAIL (constructor/exports).

- [ ] **Step 4: Rewrite `electron/core/git/git.ts`** (logic unchanged unless stated)

1. Imports: delete every `node:*` import, `cloneGit` and the `git` function (moved to `driven/git/runner.ts`). Add:
```ts
import * as path from '../shared/posix-path';
import { sha256 } from '../shared/ports';
import type { Cloner, GitRunner, WorkspaceFiles } from './ports';
import type { WorkspaceLifecycle } from './workspace-lifecycle';
import type { Change } from '../../../shared/contracts/git';
```
2. Add the fingerprint (exported):
```ts
/** Consent identity of a removal review: any change to it invalidates an earlier confirmation (audit 3). */
export function removalFingerprint(r: { branch: string; changes: Change[]; blockers: string[]; push: RemovalReview['push']; merged: string | null; identity: string }): string {
  const changes = r.changes.map(c => JSON.stringify([c.path, c.status, c.originalPath ?? null])).sort();
  return sha256(JSON.stringify({ branch: r.branch, changes, blockers: r.blockers, push: r.push, merged: r.merged, identity: r.identity }));
}
```
3. Constructor:
```ts
export interface GitServiceDeps { store: Store; runner: GitRunner; files: WorkspaceFiles; cloner: Cloner; lifecycle: WorkspaceLifecycle; terminalCount?: (id: string) => number }
export class GitService {
  readonly store: Store;
  private readonly runner: GitRunner; private readonly files: WorkspaceFiles; private readonly cloner: Cloner;
  private readonly lifecycle: WorkspaceLifecycle; private readonly terminalCount: (id: string) => number;
  constructor(deps: GitServiceDeps) {
    this.store = deps.store; this.runner = deps.runner; this.files = deps.files; this.cloner = deps.cloner;
    this.lifecycle = deps.lifecycle; this.terminalCount = deps.terminalCount ?? (() => 0);
  }
```
4. Replace every `git(` call with `this.runner(`; `realpath(` → `this.files.realpath(`; `mkdir(parent, { recursive: true, mode: 0o700 })` → `this.files.mkdirp(parent, 0o700)`; `mkdir(target, { mode: 0o700 })` → `this.files.mkdirExclusive(target, 0o700)`; `isCacheDirectory(root)` → `this.files.isDirectory(path.join(root, CACHE_DIR))`; `randomUUID()` → `globalThis.crypto.randomUUID()`; `cloneGit(input, target, parent)` → `this.cloner(input, target, parent)`; `mergedInto(repo.path, w.branch, git)` → `mergedInto(repo.path, w.branch, (cwd, args) => this.runner(cwd, args))`; `reviewPushStatus(args => git(w.path, args), branch)` → `reviewPushStatus(args => this.runner(w.path, args), branch)`.
5. `createWorkspace`: after `await this.runner(repo.path, ['rev-parse', '--verify', 'HEAD']);` insert
```ts
      const exists = await this.runner(repo.path, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]).then(() => true, () => false);
      if (exists) throw new Error(`Branch ${branch} already exists. Choose another name.`);
```
and after `await this.store.save(state)` succeeds: `await this.lifecycle.runCreated(id);` (before `return state`).
6. `removalReview`: keep the whole body; destructure `const { push, identity } = branch ? await reviewPushStatus(…) : { push: …, identity: 'detached' };` and return
```ts
    const review = { branch: w.branch, blockers, push, terminals: this.terminalCount(id), merged,
      changes: { tracked: changes.length - untracked, untracked, paths: changes.slice(0, 20).map(c => c.path) } };
    return { ...review, fingerprint: removalFingerprint({ branch: w.branch, changes, blockers, push, merged, identity }) };
```
7. `removeWorkspace` body after the repo check:
```ts
      const parsedConsent = removalConsentSchema.safeParse(consent);
      if (!parsedConsent.success) throw new Error('Confirm the removal first.');
      const { discard, deleteBranch, fingerprint } = parsedConsent.data;
      // Re-read ownership, files, branch and merge state instead of trusting a renderer's earlier result.
      const review = await this.removalReview(id);
      if (review.blockers.length) throw new Error(review.blockers.join(' '));
      if (review.fingerprint !== fingerprint) return { stale: review };
      const dirty = review.changes.tracked + review.changes.untracked > 0;
      if (dirty && !discard) throw new Error('This worktree has uncommitted changes. Confirm discarding them to remove it.');
      if (deleteBranch && !review.merged) throw new Error(`${w.branch} is not merged, so it was not deleted. Nothing was removed.`);
      try { await this.lifecycle.runBeforeRemove(id); } catch (error) { await this.lifecycle.runRemoveFailed(id); throw error; }
      try {
        if (await this.files.isDirectory(path.join(w.path, CACHE_DIR))) await this.runner(w.path, ['clean', '-f', '-d', '-x', '-q', '--', CACHE_DIR + '/']);
        await this.runner(repo.path, ['worktree', 'remove', ...(discard ? ['--force'] : []), '--', w.path]);
      } catch {
        await this.lifecycle.runRemoveFailed(id);
        throw new Error('Git could not remove the worktree. If files changed since the review, check again and confirm.');
      }
      state.workspaces = state.workspaces.filter(x => x.id !== id);
      await this.store.save(state);
      let result: RemovalResult = { state };
      if (deleteBranch) {
        try { await this.runner(repo.path, ['branch', '-D', w.branch]); } catch {
          result = { state, warning: `The worktree was removed, but deleting branch ${w.branch} failed. The branch was kept.` };
        }
      }
      await this.lifecycle.runAfterRemove(id);
      return result;
```
8. `status`: `this.runner(w.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxBuffer: 16 * 1024 * 1024 })`; the line counts use `const lines = (cwd: string, args: string[]) => this.runner(cwd, args, { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });` passed to `readGitLines(w.path, changes, lines)`, `originMainBase(w.path, lines)`, `readGitLines(w.path, changes, lines, base)`.
9. `repoSnapshot`/`inspectFile` stay (they move to repo-map in plan 05e); replace `realpath(w.path)` with `this.files.realpath(w.path)`.

- [ ] **Step 5: Contract and renderer for the fingerprint** — in `shared/contracts/git.ts`: `RemovalReview` gains
`/** Consent identity of this review (sha256 hex); a removal with another value is refused as stale. */ fingerprint: string;`,
`removalConsentSchema = z.object({ discard: z.boolean(), deleteBranch: z.boolean(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).strict()`,
`RemovalResult = { state: State; warning?: string } | { stale: RemovalReview }`.
`src/features/git/demo.ts` `reviewRemoval`: add `fingerprint: '0'.repeat(64)` to the returned review.
`src/features/git/RemoveWorktreeForm.tsx`: prop `onRemoved: (result: Extract<RemovalResult, { state: unknown }>) => void`, and replace line 36 with:
```tsx
      const result = await api.removeWorkspace(workspace.id, { discard: dirty && discard, deleteBranch: Boolean(review!.merged) && deleteBranch, fingerprint: review!.fingerprint });
      if ('stale' in result) {
        ++sequence.current; setReview(result.stale); setDiscard(false); setDeleteBranch(false);
        setError('New changes appeared since you reviewed. Review again.');
        return;
      }
      onRemoved(result);
```

- [ ] **Step 6: Run** — `npx tsx --test tests/git/git.core.test.ts tests/git/runner.test.ts` → PASS.

### Task 7: Pure `GitStateService` (TDD)

- [ ] **Step 1: Write `tests/git/git-state.core.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitStateService } from '../../electron/core/git';
import type { GitStatus, Workspace, WorkspaceGitState } from '../../shared/contracts/git';
import { manualWatcher } from '../fakes/git';

const id = '00000000-0000-4000-8000-000000000002';
const workspace = (wid: string): Workspace => ({ id: wid, repoId: wid, name: 'w', branch: 'main', path: '/repo', managed: false, previewUrl: '' });
const status = (changes: GitStatus['changes']): GitStatus => ({ branch: 'main', changes, lines: { kind: 'available', added: 0, deleted: 0, binaryFiles: 0 }, uncommitted: { kind: 'available', added: 0, deleted: 0, binaryFiles: 0 }, base: 'HEAD' });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function setup() {
  let current = status([]), statusCalls = 0;
  const events: WorkspaceGitState[] = [];
  const w = manualWatcher();
  const service = new GitStateService({ workspace: async wid => workspace(wid), status: async () => { statusCalls++; return current; } },
    { resolve: async (_cwd, branch) => ({ kind: 'none', branch, repository: 'o/a', checkedAt: 0 }) },
    s => events.push(s), () => true, { debounceMs: 20, pollMs: 60_000, prPollMs: 60_000 },
    { watcher: w.watcher, runner: async () => 'https://github.com/o/a\n' });
  return { service, events, w, calls: () => statusCalls, set: (s: GitStatus) => { current = s; } };
}

test('watcher events are debounced into one refresh', async () => {
  const s = setup();
  try {
    await s.service.get(id);
    assert.equal(s.calls(), 1);
    s.w.change('index'); s.w.change('index'); s.w.change('HEAD');
    await sleep(80);
    assert.equal(s.calls(), 2);
    s.w.change('objects/ab/cdef'); s.w.change('index.lock');
    await sleep(80);
    assert.equal(s.calls(), 2, 'objects and lock files are ignored');
  } finally { s.service.dispose(); }
});

test('the revision bumps only when status, error or PR changed', async () => {
  const s = setup();
  try {
    const first = await s.service.get(id);
    const same = await s.service.refresh(id);
    assert.equal(same.revision, first.revision);
    s.set(status([{ status: ' M', path: 'a.ts' }]));
    const changed = await s.service.refresh(id);
    assert.equal(changed.revision, first.revision + 1);
    assert.equal(s.events.length, 2);
  } finally { s.service.dispose(); }
});

test('forget closes the watcher and stops reporting', async () => {
  const s = setup();
  try {
    await s.service.get(id);
    s.service.forget(id);
    assert.ok(s.w.handles.every(h => h.closed));
    s.w.change('index'); await sleep(60);
    assert.equal(s.calls(), 1);
  } finally { s.service.dispose(); }
});
```

- [ ] **Step 2: Run** — FAIL (constructor arity / node imports).

- [ ] **Step 3: Edit `electron/core/git/git-state.ts`**

- Imports: delete `node:fs`, `node:path` and `git`; add `import * as path from '../shared/posix-path';`, `import type { GitDirWatcher, GitRunner, GitStatePublisher, WatchHandle } from './ports';`.
- `Tracked.timer` and `timers`: `ReturnType<typeof setTimeout>` / `ReturnType<typeof setInterval>[]` instead of `NodeJS.Timeout`.
- `watchers` map type: `Map<string, { ids: Set<string>; watcher: WatchHandle }>` (the existing test reaches into `.watcher.emit('error', …)`; the adapter returns the real `FSWatcher`, so that keeps working).
- Constructor: `(private git: Pick<GitService, 'workspace' | 'status'>, private pullRequests: Pick<PullRequestService, 'resolve'>, private emit: GitStatePublisher, private visible: () => boolean = () => true, options: GitStateOptions = {}, private ports: { watcher: GitDirWatcher; runner: GitRunner })`.
- `track()`: `[gitDir, common] = …git(… rev-parse …)…` → `({ gitDir, common } = await this.ports.watcher.gitDirs(w.path));` inside the same try/catch.
- `watch()`: `watcher = watch(common, { recursive: true }, (_event, filename) => this.changed(common, ids, filename?.toString() ?? ''))` → `watcher = this.ports.watcher.watch(common, filename => this.changed(common, ids, filename));` (same try/catch, same `watcher.on('error', …)`).
- `changed()`: `const name = filename;` (already POSIX); `path.join` is the posix helper.
- `compute()`: `git(t.path, ['config', '--get', 'remote.origin.url'])` → `this.ports.runner(t.path, ['config', '--get', 'remote.origin.url'])`.

- [ ] **Step 4: Run** — `npx tsx --test tests/git/git-state.core.test.ts` → PASS.

### Task 8: Compatibility wiring, IPC handlers, main

- [ ] **Step 1: Create `electron/app/wiring/git.ts`**

```ts
// Git core + real adapters under the names and signatures the rest of the app and the existing tests use.
import { cloneGit } from '../../adapters/driven/git/clone';
import { ghRunner } from '../../adapters/driven/git/gh';
import { git } from '../../adapters/driven/git/runner';
import { nodeGitDirWatcher } from '../../adapters/driven/git/watcher';
import { nodeHasher } from '../../adapters/driven/fs/hash';
import { nodeWorkspaceFiles } from '../../adapters/driven/fs/workspace-files';
import { sqliteStateRepository } from '../../adapters/driven/sqlite/state-repository';
import { GitService as CoreGitService, GitStateService as CoreGitStateService, PullRequestService as CorePullRequestService, Store as CoreStore,
  WorkspaceLifecycle, originMainBase as coreOriginMainBase, readGitLines as coreReadGitLines, type GitStateOptions, type GitStatePublisher, type LineRunner, type PRRunner } from '../../core/git';
import type { Change } from '../../../shared/contracts/git';
import { provideHasher } from '../../core/shared/ports';

provideHasher(nodeHasher);

export { git, WorkspaceLifecycle };
export { parseStatus, parseNumstat } from '../../core/git';

export class Store extends CoreStore { constructor(directory: string) { super(directory, sqliteStateRepository(directory)); } }

export class GitService extends CoreGitService {
  /** hooks: legacy test hook pair, registered as a blocking beforeRemove listener and a removeFailed listener. */
  constructor(store: CoreStore, terminalCount: (id: string) => number = () => 0,
    hooks?: { beforeRemove(id: string): Promise<void>; removeFailed(id: string): void }, lifecycle = new WorkspaceLifecycle()) {
    if (hooks) { lifecycle.onBeforeRemove('hooks', hooks.beforeRemove, { blocking: true }); lifecycle.onRemoveFailed('hooks', hooks.removeFailed); }
    super({ store, runner: git, files: nodeWorkspaceFiles, cloner: cloneGit, lifecycle, terminalCount });
  }
}

export class GitStateService extends CoreGitStateService {
  constructor(service: ConstructorParameters<typeof CoreGitStateService>[0], pullRequests: ConstructorParameters<typeof CoreGitStateService>[1],
    emit: GitStatePublisher, visible?: () => boolean, options?: GitStateOptions) {
    super(service, pullRequests, emit, visible, options, { watcher: nodeGitDirWatcher, runner: git });
  }
}

export class PullRequestService extends CorePullRequestService { constructor(execute: PRRunner = ghRunner, now = Date.now) { super(execute, now); } }

const lineRunner: LineRunner = (cwd, args) => git(cwd, args, { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
export const readGitLines = (cwd: string, changes: Change[], runner: LineRunner = lineRunner, base = 'HEAD') => coreReadGitLines(cwd, changes, runner, base);
export const originMainBase = (cwd: string, runner: LineRunner = lineRunner) => coreOriginMainBase(cwd, runner);
```
(Make sure `electron/core/git/index.ts` exports `GitStateOptions`, `LineRunner`, `readGitLines`, `originMainBase`, `parseStatus`, `parseNumstat`.)

Note: `readGitLines` previously ran `git` without the error wrapper; both variants are caught inside `readGitLines`, so results are identical.

- [ ] **Step 2: Create `electron/adapters/driving/ipc/git.ts`**

```ts
import type { Handlers } from '../../../../shared/contracts/define';
import type { gitContract, State } from '../../../../shared/contracts/git';
import type { GitService, GitStateService } from '../../../core/git';

export function gitHandlers(d: {
  git: GitService; gitState: GitStateService;
  pickFolder(title: string): Promise<string | null>;
  cloneRepository(url: string, destination: string): Promise<State>;
}): Handlers<typeof gitContract> {
  return {
    pickRepository: async () => { const folder = await d.pickFolder('Open a trusted Git repository'); return folder === null ? null : d.git.openRepository(folder); },
    openRepository: p => d.git.openRepository(p),
    pickCloneParent: () => d.pickFolder('Choose a parent folder for the new clone'),
    // Validate values in the service with fixed errors (no Zod payload echo).
    cloneRepository: (url, destination) => d.cloneRepository(url, destination),
    createWorkspace: (id, branch) => d.git.createWorkspace(id, branch),
    reviewRemoval: id => d.git.reviewRemoval(id),
    removeWorkspace: (id, consent) => d.git.removeWorkspace(id, consent),
    gitState: id => d.gitState.get(id),
    refreshGitState: id => d.gitState.refresh(id, true),
  };
}
```

- [ ] **Step 3: `electron/main.ts`**

- Import `GitService, GitStateService, PullRequestService, Store, WorkspaceLifecycle` from `./app/wiring/git` (replace the core imports) and `gitHandlers` from `./adapters/driving/ipc/git`.
- Replace the `new GitService(store, …, { beforeRemove…, removeFailed… })` block with:
```ts
const lifecycle = new WorkspaceLifecycle();
const git = new GitService(store, id => terminals.countWorkspace(id), undefined, lifecycle);
// Close the workspace's terminals and stop its code graph (.codegraph cache) before the folder is cleaned and removed.
lifecycle.onBeforeRemove('terminals', id => terminals.closeWorkspace(id), { blocking: true });
lifecycle.onBeforeRemove('views', id => views.release(id), { blocking: true }); // split into views (non-blocking) + stinggraph release in plan 05d
lifecycle.onRemoveFailed('views', id => views.reopen(id));
lifecycle.onAfterRemove('git-state', id => gitState.forget(id));
lifecycle.onAfterRemove('view state', id => viewState.forget(id)); // stale view state must not block a completed removal (logged)
lifecycle.onAfterRemove('activity', id => activity.forgetWorkspace(id));
```
(`views`/`gitState`/`viewState` are referenced lazily inside the listeners, so declaration order is unchanged.)
- Replace `registerContract(ipc, gitContract, { … })` with:
```ts
  registerContract(ipc, gitContract, gitHandlers({
    git, gitState,
    pickFolder: async title => { const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title }); return result.canceled ? null : result.filePaths[0]; },
    cloneRepository: async (url, destination) => {
      if (cloning) throw new Error('A clone is already in progress. Wait for it to finish.');
      cloning = true;
      try { return await git.cloneRepository(url, destination); } finally { cloning = false; }
    },
  }));
```

### Task 9: Existing tests — import paths and fingerprint consent

- [ ] **Step 1: Import paths** — run `npm run typecheck 2>&1 | grep "tests/"`; in every listed test file point `git`, `GitService`, `Store`, `GitStateService`, `readGitLines`, `parseNumstat` (git-lines), `parseStatus` imports at `../../electron/app/wiring/git` (or `../app/wiring/git` relative equivalent). This covers at least `tests/git/{git,git-state,git-lines,clone,worktree-removal}.test.ts`, `tests/app/database.test.ts`, `tests/activity/activity-history.test.ts`, `tests/views/{view-state,stinggraph-api}.test.ts`, `tests/stinggraph/*.test.ts`, `tests/repo-map/repo-map.test.ts`.

- [ ] **Step 2: Consent fingerprints (approved replacement)** — add this helper after the imports of `tests/git/git.test.ts` and `tests/git/worktree-removal.test.ts`:

```ts
const consent = async (service: GitService, id: string, choice: { discard: boolean; deleteBranch: boolean }) =>
  ({ ...choice, fingerprint: (await service.reviewRemoval(id)).fingerprint });
```
and rewrite the second argument of these 16 calls from `X` to `await consent(<service>, <id>, X)` (same service and id as the call):
`tests/git/git.test.ts:44, 58, 62`; `tests/git/worktree-removal.test.ts:44, 59, 72, 74, 87, 104, 128, 132, 142, 158, 169, 172, 176`.
Unchanged (they reject before the consent is read): `git.test.ts:32, 43`, `worktree-removal.test.ts:43`.
Add one new test to `tests/git/git.test.ts`:
```ts
test('a removal consent without the review fingerprint is refused and removes nothing', async () => {
  const f = await fixture();
  try {
    const first = await f.service.openRepository(f.repo);
    const w = (await f.service.createWorkspace(first.repos[0].id, 'no-fingerprint')).workspaces[1];
    await assert.rejects(f.service.removeWorkspace(w.id, { discard: true, deleteBranch: false } as never), /Confirm the removal first/);
    await access(w.path);
  } finally { await f.cleanup(); }
});
test('stale consent: a file created after the review keeps the worktree; a fresh review removes it', async () => {
  const f = await fixture();
  try {
    const first = await f.service.openRepository(f.repo);
    const w = (await f.service.createWorkspace(first.repos[0].id, 'stale-consent')).workspaces[1];
    const { fingerprint } = await f.service.reviewRemoval(w.id);
    await writeFile(path.join(w.path, 'late.txt'), 'new work');
    const stale = await f.service.removeWorkspace(w.id, { discard: true, deleteBranch: false, fingerprint });
    assert.ok('stale' in stale && stale.stale.changes.paths.includes('late.txt'));
    assert.equal(await readFile(path.join(w.path, 'late.txt'), 'utf8'), 'new work');
    await f.service.removeWorkspace(w.id, await consent(f.service, w.id, { discard: true, deleteBranch: false }));
    await assert.rejects(access(w.path));
  } finally { await f.cleanup(); }
});
test('an existing branch is refused before worktree add', async () => {
  const f = await fixture();
  try {
    const state = await f.service.openRepository(f.repo);
    await git(f.repo, ['branch', 'taken']);
    await assert.rejects(f.service.createWorkspace(state.repos[0].id, 'taken'), /Branch taken already exists\. Choose another name\./);
    assert.equal((await f.store.load()).workspaces.length, 1);
  } finally { await f.cleanup(); }
});
test('a failing worktree add reports git’s reason', async () => {
  const f = await fixture();
  try {
    const state = await f.service.openRepository(f.repo);
    const parent = path.join(f.store.directory, 'worktrees', state.repos[0].id);
    await mkdir(parent, { recursive: true }); await chmod(parent, 0o500);
    try {
      await assert.rejects(f.service.createWorkspace(state.repos[0].id, 'blocked'),
        (e: Error) => /^Git operation failed: .*(denied|could not|cannot).*\. Check the repository, branch, and worktree on disk\./i.test(e.message));
    } finally { await chmod(parent, 0o700); }
  } finally { await f.cleanup(); }
});
test('status succeeds with more than 4 MiB of output', async () => {
  const f = await fixture();
  try {
    const state = await f.service.openRepository(f.repo);
    const dir = path.join(f.repo, 'many'); await mkdir(dir);
    for (let i = 0; i < 22000; i++) await writeFile(path.join(dir, `${'x'.repeat(200)}-${i}.txt`), '');
    const status = await f.service.status(state.workspaces[0].id);
    assert.ok(status.changes.length >= 22000);
  } finally { await f.cleanup(); }
});
```
Add `chmod` to the existing `node:fs/promises` import line of `tests/git/git.test.ts` (import edit only).

- [ ] **Step 3: e2e check** — in `tests/git/worktree-removal.mjs`, directly after `await cancel(); await access(worktree.path); check('cancel preserves worktree and branch');` insert:

```js
    await openRemoval('feature/remove');
    await writeFile(path.join(worktree.path, 'stale.txt'), 'appeared after review');
    await removeButton().click();
    await dialog().getByText('New changes appeared since you reviewed. Review again.').waitFor();
    const staleText = await dialog().innerText();
    await access(worktree.path);
    check('changes after the review refuse removal and reload the review', staleText.includes('stale.txt') && await discardButton().isDisabled());
    await cancel(); await rm(path.join(worktree.path, 'stale.txt'));
```

- [ ] **Step 4: Ledger** — append rows for: the 16 consent calls (old `X` → new `await consent(service, id, X)`; "same choice, now with the fresh review fingerprint the renderer sends; every assertion unchanged; plus a new test that consent without fingerprint is refused"); the new tests in `git.test.ts`; the new e2e check.

### Task 10: Switch git importers to `index.ts`, verify, commit

- [ ] **Step 1:** In files outside `electron/core/git/` (main, adapters, other core features, wiring), import git core names from `electron/core/git` (index), except `electron/core/repo-map/*` → `core/git` imports (none remain after Task 3) and `core/git/git.ts` → `core/repo-map/repo-map.ts` (stays a direct import until plan 05e).

- [ ] **Step 2: Purity check**

Run: `grep -rn "from 'node:\|from 'electron'\|require(" electron/core/git electron/core/shared`
Expected: no output.

- [ ] **Step 3: Full checks**

Run: `npm run check 2>&1 | tail -n 12 && npm run test:e2e -- worktree-removal add-project pull-requests desktop repo-map`
Expected: `# fail 0`; 5 suites PASS.

- [ ] **Step 4: Commit**

```bash
git add -A electron shared src tests docs/plans/2026-11-23-test-edit-ledger.md
git status --short
git commit -m "refactor(git): extract git core behind ports; one git runner; removal consent fingerprint"
```

## Self-review

- Spec coverage (04 git row): core files + `workspace-lifecycle.ts`; ports `GitRunner`, `WorkspaceFiles`, `StateRepository`, `GitDirWatcher`, `PRRunner`, `Cloner`, `GitStatePublisher`; adapters `git/{runner,watcher,gh,clone,git-exclude}`, `fs/workspace-files`, `sqlite/state-repository`; driving `ipc/git.ts`; fakes; core tests `git.core`, `git-state.core`, `workspace-lifecycle`. Audit 3 (T6, T9 incl. e2e), 6 (T3), error detail (T3), branch exists (T6, T9), status buffer (T6, T9).
- Left for later plans on purpose: `repoSnapshot`/`inspectFile` (05e), stinggraph release split (05d), `CloneLock`/dialogs port (06), rule-3 cases with the stinggraph release (05d) and compose order (06).
