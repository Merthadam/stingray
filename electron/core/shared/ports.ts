// Ports every core feature may use. Filled once per process by electron/app (wiring, worker and CLI entries) and by
// tests (fakes); nothing else calls provide*/resetCorePorts (enforced by tests/architecture/import-boundaries.test.ts).
import type { Language, Parser, Query } from 'web-tree-sitter';

export interface Hasher { /** sha256 of UTF-8 text as 64 lowercase hex characters. */ sha256(text: string): string }
export interface GlobMatcher { /** POSIX glob match of a worktree-relative path (path.posix.matchesGlob semantics). */ matches(file: string, glob: string): boolean }
export interface SyntaxParser {
  /** Load the grammar wasm at an absolute path (initializing the runtime once per process). */
  loadLanguage(file: string): Promise<Language>;
  /** A parser set to `language`; the caller deletes it. */
  parser(language: Language): Parser;
  /** Compile a query; throws on invalid query source. */
  query(language: Language, source: string): Query;
}

let hasher: Hasher | undefined, glob: GlobMatcher | undefined, syntax: SyntaxParser | undefined;
const missing = (port: string) => new Error(`${port} port not provided; wire it in electron/app.`);
export function provideHasher(value: Hasher) { hasher = value; }
export function provideGlobMatcher(value: GlobMatcher) { glob = value; }
export function provideSyntaxParser(value: SyntaxParser) { syntax = value; }
export function sha256(text: string): string { if (!hasher) throw missing('Hasher'); return hasher.sha256(text); }
export function matchesGlob(file: string, pattern: string): boolean { if (!glob) throw missing('GlobMatcher'); return glob.matches(file, pattern); }
export function syntaxParser(): SyntaxParser { if (!syntax) throw missing('SyntaxParser'); return syntax; }
/** Tests only: forget every provided port. */
export function resetCorePorts() { hasher = undefined; glob = undefined; syntax = undefined; }

/** Key/value rows of the app database's settings table (synchronous: read on every graph open). */
export interface SettingsRepository { get(key: string): string | undefined; set(key: string, value: string): void }
