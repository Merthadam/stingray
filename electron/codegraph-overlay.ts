// Shared-base code graphs (setting codegraph.sharedBase, off by default): one CodeGraph index per repo at origin/main in
// Stingray's data dir, plus one stinggraph overlay per Stingray-managed worktree holding the files its commits changed
// since the merge-base, read together as a merged view. Design and limits: stinggraph docs/stingray-overlay-*.md.
// Everything here throws on failure; codegraph.ts then falls back to the full per-worktree index.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExtractionResult, Overlay, OverlayConflicts, OverlayFile } from '@colbymchenry/codegraph';

type CodeGraphLibrary = typeof import('@colbymchenry/codegraph');
/** Where a managed worktree's shared base lives; null/absent means the full per-worktree index. */
export interface SharedBaseTarget { repoId: string; repoPath: string; dataDir: string }

export const BASE_REF = 'origin/main';
// Beyond this an overlay update stops paying off against a full index (stinggraph findings §9, §11).
export const MAX_OVERLAY_FILES = 300;

const run = promisify(execFile);
export async function gitOut(cwd: string, args: string[], env: Record<string, string> = {}) {
  const { stdout } = await run('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env },
  });
  return stdout;
}

const repoDir = (t: SharedBaseTarget) => path.join(t.dataDir, 'codegraph', t.repoId);
export const baseRoot = (t: SharedBaseTarget) => path.join(repoDir(t), 'base');
export const overlayPath = (t: SharedBaseTarget, workspaceId: string) => path.join(repoDir(t), 'overlays', `${workspaceId}.db`);

async function lsTree(cwd: string, commit: string) {
  const blobs = new Map<string, string>();
  for (const line of (await gitOut(cwd, ['ls-tree', '-r', '-z', commit])).split('\0')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(line);
    if (m) blobs.set(m[2]!, m[1]!);
  }
  return blobs;
}

const baseRuns = new Map<string, Promise<string>>(); // repoId -> latest base update; one base writer per repo
/** Bring the repo's base index to the latest fetched origin/main and return that commit. Serialized per repo. */
export function ensureBase(lib: CodeGraphLibrary, t: SharedBaseTarget): Promise<string> {
  const next = (baseRuns.get(t.repoId) ?? Promise.resolve('')).catch(() => '').then(() => updateBase(lib, t));
  baseRuns.set(t.repoId, next);
  return next;
}

async function updateBase(lib: CodeGraphLibrary, t: SharedBaseTarget) {
  const commit = (await gitOut(t.repoPath, ['rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`]).catch(() => '')).trim();
  if (!commit) throw new Error(`${BASE_REF} not found in ${t.repoPath}`);
  const root = baseRoot(t), dbPath = lib.getDatabasePath(root);
  if (existsSync(dbPath)) {
    const conn = lib.DatabaseConnection.open(dbPath, { readOnly: true });
    try { if (lib.getBaseInfo(conn.getDb())?.baseCommit === commit) return commit; } finally { conn.close(); }
  }
  // A plain checkout of origin/main, written through a private index: the repo's index and worktree list stay untouched.
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root)) if (entry !== '.codegraph') rmSync(path.join(root, entry), { recursive: true, force: true });
  const env = { GIT_INDEX_FILE: path.join(repoDir(t), 'base.index') };
  await gitOut(t.repoPath, ['read-tree', commit], env);
  await gitOut(t.repoPath, ['checkout-index', '-a', '-f', `--prefix=${root}${path.sep}`], env);
  const fresh = !lib.CodeGraph.isInitialized(root);
  const cg = fresh ? await lib.CodeGraph.init(root) : await lib.CodeGraph.open(root);
  try {
    if (fresh) { const result = await cg.indexAll(); if (!result.success) throw new Error(`base index failed: ${result.errors[0]?.message ?? 'unknown error'}`); }
    else await cg.sync();
  } finally { cg.close(); }
  const conn = lib.DatabaseConnection.open(dbPath);
  try {
    lib.setGitBlobIds(conn.getDb(), await lsTree(t.repoPath, commit));
    lib.setBaseInfo(conn.getDb(), { baseCommit: commit, baseRef: BASE_REF }); // last: marks the base complete
  } finally { conn.close(); }
  return commit;
}

/** git diff --name-status -M between two commits, as overlay ownership rows. */
async function changedFiles(root: string, from: string, to: string): Promise<OverlayFile[]> {
  const [fromBlobs, toBlobs] = await Promise.all([lsTree(root, from), lsTree(root, to)]);
  const fields = (await gitOut(root, ['diff', '--name-status', '-z', '-M', from, to])).split('\0');
  const files: OverlayFile[] = [];
  for (let i = 0; i < fields.length - 1;) {
    const code = fields[i++]![0], a = fields[i++]!;
    if (code === 'R' || code === 'C') {
      const b = fields[i++]!;
      files.push(code === 'R' ? { path: b, status: 'renamed', oldPath: a, blobId: toBlobs.get(b), baseBlobId: fromBlobs.get(a) } : { path: b, status: 'added', blobId: toBlobs.get(b) });
    } else if (code === 'D') files.push({ path: a, status: 'deleted', baseBlobId: fromBlobs.get(a) });
    else if (code === 'A') files.push({ path: a, status: 'added', blobId: toBlobs.get(a) });
    else files.push({ path: a, status: 'modified', blobId: toBlobs.get(a), baseBlobId: fromBlobs.get(a) }); // M, T
  }
  return files;
}

export interface BuiltOverlay { path: string; head: string; mergeBase: string; files: string[] }

/**
 * Build the worktree's overlay for its HEAD from git (content via git show) next to the current one; installOverlay
 * swaps it in. projectRoot is the worktree: the resolver reads its module config (tsconfig, package.json) from disk.
 * shortcut: rebuilds the whole overlay on every commit; upgrade to upserting only the changed files' delta when
 * long-lived branches make rebuilds slow.
 */
export async function buildOverlay(lib: CodeGraphLibrary, t: SharedBaseTarget, workspaceId: string, root: string, baseCommit: string): Promise<BuiltOverlay> {
  const head = (await gitOut(root, ['rev-parse', 'HEAD'])).trim();
  const mergeBase = (await gitOut(root, ['merge-base', baseCommit, head])).trim();
  const branch = (await gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const changes = await changedFiles(root, mergeBase, head);
  if (changes.length > MAX_OVERLAY_FILES) throw new Error(`${changes.length} files changed since ${BASE_REF} (limit ${MAX_OVERLAY_FILES})`);
  const target = overlayPath(t, workspaceId) + '.new';
  removeDb(target);
  const overlay = lib.createOverlay(target, lib.getDatabasePath(baseRoot(t)), { worktreeId: workspaceId, branch, baseCommit: mergeBase, headCommit: mergeBase });
  try {
    const frameworksFor = lib.detectOverlayFrameworks(root);
    const entries: { file: OverlayFile; extraction: ExtractionResult }[] = [];
    for (const file of changes) {
      // Non-source and deleted files still get an ownership row (conflicts), with nothing extracted.
      const source = file.status !== 'deleted' && lib.detectLanguage(file.path) !== 'unknown';
      entries.push({ file, extraction: source
        ? await lib.extractFile(file.path, await gitOut(root, ['show', `${head}:${file.path}`]), undefined, frameworksFor(file.path))
        : { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 } });
    }
    if (entries.length) await overlay.upsertFiles(entries, root);
    overlay.setHeadCommit(head); // last: marks the overlay complete
  } catch (error) { overlay.close(); removeDb(target); throw error; }
  overlay.close();
  return { path: target, head, mergeBase, files: changes.flatMap(c => (c.oldPath ? [c.path, c.oldPath] : [c.path])) };
}

const removeDb = (file: string) => { for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true }); };

/** Replace the worktree's overlay with a built one and open it. Close the previous Overlay first. */
export function installOverlay(lib: CodeGraphLibrary, t: SharedBaseTarget, workspaceId: string, built: BuiltOverlay): Overlay {
  const final = overlayPath(t, workspaceId);
  removeDb(final);
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(built.path + suffix)) renameSync(built.path + suffix, final + suffix);
  return lib.openOverlay(final, lib.getDatabasePath(baseRoot(t)));
}

/** File/symbol conflicts between the given worktrees' overlays and main-moved files; null without a base. */
export function overlayConflicts(lib: CodeGraphLibrary, t: SharedBaseTarget, workspaceIds: string[]): OverlayConflicts | null {
  const dbPath = lib.getDatabasePath(baseRoot(t));
  if (!existsSync(dbPath)) return null;
  return lib.findConflicts(dbPath, workspaceIds.map(id => overlayPath(t, id)).filter(file => existsSync(file)));
}
