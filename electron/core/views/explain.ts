// `explain:` entries of a view file: prose for nodes and groups (also ones without a symbol, e.g. tables or LangGraph steps)
// that overrides their docstring explanation. Each entry may carry a fingerprint of the code it was written for: one hash
// per piece (the target's own body, each direct in-repo callee, or `drawn:<id>` for targets without a symbol). `check`
// recomputes it and flags explanations whose code changed since ("may be outdated: X changed"). `stingray-views check
// --restamp` writes the current fingerprints back into the file.
import { sha256 } from '../shared/ports';
import type { DiagramGroup, DiagramNode, ExplainChanges, ExplainDiagnostic, ExplanationStatus, SymbolRef, UnresolvedLink, ViewResult, ViewWarning } from '../../../shared/contracts/views';
import type { ComputeDeps } from './compute';
import { MAX_PIECES, type ExplainEntry } from './rules/schema';
import type { GraphSymbol } from './rules/types';

export type ReadSource = (file: string) => Promise<string | null>;
type Target = DiagramNode | DiagramGroup;

const hash = (text: string) => sha256(text).slice(0, 12);
const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Fingerprint of a symbol's own body (lines line..endLine; callees are not included), ignoring trailing whitespace and
 * line endings; null when the end line is unknown or past the end of the file. */
export function bodyFingerprint(source: string, symbol: Pick<SymbolRef, 'line' | 'endLine'>): string | null {
  const lines = source.split(/\r\n|\r|\n/);
  if (!symbol.endLine || symbol.endLine < symbol.line || symbol.endLine > lines.length) return null;
  return hash(lines.slice(symbol.line - 1, symbol.endLine).map(l => l.trimEnd()).join('\n'));
}

/** Fingerprint of a node or group without a symbol, as drawn: label, kind, subtitle, detail and fields (label, type, badges),
 * so e.g. a table's changes when its columns do. A group's also covers its member nodes and nested groups, as drawn. */
export function drawnFingerprint(t: Target, nodes: DiagramNode[] = [], groups: DiagramGroup[] = [], seen = new Set<string>()): string {
  const n = t as Partial<DiagramNode>, group = n.kind === undefined;
  if (group) seen.add(t.id);
  const members = group ? [...nodes.filter(m => m.group === t.id).map(m => drawnFingerprint(m)),
    ...groups.filter(g => g.parent === t.id && !seen.has(g.id)).map(g => drawnFingerprint(g, nodes, groups, seen))].sort() : [];
  return hash(JSON.stringify([squash(t.label), squash(n.kind ?? 'group'), squash(n.subtitle), squash(n.detail),
    (n.fields ?? []).map(f => [squash(f.label), squash(f.type), f.badges.map(squash)]), ...(members.length ? [members] : [])]));
}

/** Nodes/groups an `explain:` key names: node id, group id, alias (rule node aliases; a table's name or model class), then
 * symbol name (every node and group linked to it). The first kind that matches wins. */
export function explainTargets(key: string, nodes: DiagramNode[], groups: DiagramGroup[]): Target[] {
  const tiers: (() => Target[])[] = [
    () => nodes.filter(n => n.id === key),
    () => groups.filter(g => g.id === key),
    () => nodes.filter(n => n.aliases?.includes(key) || (n.kind === 'table' && (n.label === key || n.subtitle === key))),
    () => [...nodes, ...groups].filter(t => t.symbol?.name === key),
  ];
  for (const tier of tiers) { const found = tier(); if (found.length) return found; }
  return [];
}

export interface PieceDeps { read: ReadSource; callees?: ComputeDeps['callees']; fileSymbols?: ComputeDeps['fileSymbols'] }
/** `pieces` null with `why`: the entry cannot be checked; null without `why`: the code graph did not answer (unchecked). */
export interface Pieces { pieces: Record<string, string> | null; skipped: string[]; files: string[]; why?: string }

// CodeGraph's qualified name is file-relative (e.g. "Store::get"), so the file is part of the key.
const pieceKey = (s: SymbolRef | GraphSymbol) => `${s.file}::${s.qualifiedName || s.name}`;
const MAX_KEY = 500; // the schema's limit on piece keys
const CONSTRUCTORS = new Set(['__init__', 'constructor']);
const CALLABLE = new Set(['function', 'method', 'component']); // CodeGraph node kinds that have a body worth hashing

/** The pieces of code an entry's targets stand for, keyed by qualified name (or `drawn:<id>` for targets without a symbol):
 * each target's own body plus its direct callable callees (one level; a class callee stands for its constructor). Two
 * symbols with the same key share it (their hashes folded in order). `pieces` is null, with `why`, when a target's own body
 * cannot be hashed or there are more than MAX_PIECES; null without `why` when a graph lookup returned null (unknown, so
 * never "calls nothing"). Callees that cannot be hashed are left out and listed in `skipped` (their files still in `files`). */
export async function collectPieces(targets: Target[], nodes: DiagramNode[], groups: DiagramGroup[], deps: PieceDeps): Promise<Pieces> {
  const pieces = new Map<string, string>(), skipped = new Set<string>(), files = new Set<string>(), hashed = new Set<string>();
  const uncomputable = (why?: string): Pieces => ({ pieces: null, skipped: [], files: [], ...(why ? { why } : {}) });
  const add = (key: string, fp: string) => { const prev = pieces.get(key); pieces.set(key, prev === undefined ? fp : hash(`${prev}\n${fp}`)); };
  for (const t of targets) {
    if (!t.symbol) { pieces.set(`drawn:${t.id}`, drawnFingerprint(t, nodes, groups)); continue; }
    if (hashed.has(t.symbol.id)) continue; // two nodes linked to one symbol
    const source = await deps.read(t.symbol.file);
    if (source === null) return uncomputable(`${t.symbol.file} could not be read (missing, too large or unreadable)`);
    const fp = bodyFingerprint(source, t.symbol);
    if (fp === null) return uncomputable(t.symbol.endLine ? `${t.symbol.file} is shorter than the code graph says (re-index)` : `the code graph has no end line for ${t.symbol.name}`);
    if (pieceKey(t.symbol).length > MAX_KEY) return uncomputable(`the name of ${t.symbol.name} is too long to fingerprint`);
    add(pieceKey(t.symbol), fp);
    hashed.add(t.symbol.id);
    files.add(t.symbol.file);
  }
  const ids = new Set(targets.flatMap(t => (t.symbol ? [t.symbol.id] : [])));
  const callees = ids.size && deps.callees ? await deps.callees([...ids]) : new Map<string, GraphSymbol[]>();
  if (!callees) return uncomputable();
  for (const id of ids) for (const callee of callees.get(id) ?? []) {
    let fn: GraphSymbol | undefined = callee;
    if (callee.kind === 'class') {
      if (!callee.endLine || !deps.fileSymbols) continue;
      const symbols = await deps.fileSymbols(callee.file);
      if (!symbols) return uncomputable();
      const inside = symbols.filter(s => s.kind === 'method' && CONSTRUCTORS.has(s.name) && s.line >= callee.line && s.line <= callee.endLine!);
      // The class's own constructor, not a nested class's; by line range when the graph has no qualified names.
      fn = callee.qualifiedName ? inside.find(s => s.qualifiedName === `${callee.qualifiedName}::${s.name}`) : inside[0];
    }
    if (!fn || !CALLABLE.has(fn.kind) || hashed.has(fn.id)) continue; // no constructor, not callable, recursion, or already there
    hashed.add(fn.id);
    files.add(fn.file);
    const source = await deps.read(fn.file), fp = source === null ? null : bodyFingerprint(source, fn);
    if (fp === null || pieceKey(fn).length > MAX_KEY) { skipped.add(pieceKey(fn)); continue; }
    add(pieceKey(fn), fp);
    if (pieces.size > MAX_PIECES) return uncomputable('it calls too many functions to fingerprint');
  }
  if (pieces.size > MAX_PIECES) return uncomputable('it calls too many functions to fingerprint');
  return { pieces: Object.fromEntries([...pieces].sort(([a], [b]) => (a < b ? -1 : 1))), skipped: [...skipped].sort(), files: [...files].sort() };
}

const NO_CHANGES: ExplainChanges = { changed: [], added: [], removed: [] };

/** Status of a stored fingerprint against the current pieces: none → unstamped, a string → legacy (old format, own body
 * only), a map → view when equal, else stale with the changed, added and removed piece keys (sorted). Pure. */
export function compareFingerprint(stored: ExplainEntry['fingerprint'], current: Record<string, string>): { status: ExplanationStatus; changes: ExplainChanges } {
  if (stored === null) return { status: 'unstamped', changes: NO_CHANGES };
  if (typeof stored === 'string') return { status: 'legacy', changes: NO_CHANGES };
  const keys = (m: Record<string, string>) => Object.keys(m).sort();
  const changes = {
    changed: keys(current).filter(k => Object.hasOwn(stored, k) && stored[k] !== current[k]),
    added: keys(current).filter(k => !Object.hasOwn(stored, k)),
    removed: keys(stored).filter(k => !Object.hasOwn(current, k)),
  };
  return { status: changes.changed.length || changes.added.length || changes.removed.length ? 'stale' : 'view', changes };
}

const MAX_NAMES = 3;

/** The reason of a stale entry, e.g. `may be outdated: SessionStore::get_user changed; new call audit.log; no longer calls
 * cache.get`. Names drop their file path unless two would read the same; at most 3 per category. `labelOf` gives the label
 * of a `drawn:<id>` piece's node or group (default: the id). Pure. */
export function describeChanges(changes: ExplainChanges, labelOf: (id: string) => string = id => id): string {
  const shown = (keys: string[]) => keys.slice(0, MAX_NAMES);
  const short = (k: string) => k.startsWith('drawn:') ? `"${labelOf(k.slice(6))}"` : k.includes('::') ? k.slice(k.indexOf('::') + 2) : k;
  const drawn = changes.changed.filter(k => k.startsWith('drawn:')), code = changes.changed.filter(k => !k.startsWith('drawn:'));
  const all = [...shown(code), ...shown(drawn), ...shown(changes.added), ...shown(changes.removed)].map(short);
  const name = (k: string) => (k.startsWith('drawn:') || all.filter(s => s === short(k)).length === 1 ? short(k) : k);
  const list = (keys: string[]) => shown(keys).map(name).join(', ') + (keys.length > MAX_NAMES ? ` (+${keys.length - MAX_NAMES} more)` : '');
  const parts = [
    ...(code.length ? [`${list(code)} changed`] : []),
    ...(drawn.length ? [`${list(drawn)} changed (as drawn)`] : []),
    ...(changes.added.length ? [`new call${changes.added.length > 1 ? 's' : ''} ${list(changes.added)}`] : []),
    ...(changes.removed.length ? [`no longer calls ${list(changes.removed)}`] : []),
  ];
  return `may be outdated: ${parts.join('; ')}`;
}

const LEGACY_REASON = 'old fingerprint format (own body only)', ADVICE = ' — review it and run stingray-views check --restamp';
const summaryHash = (pieces: Record<string, string>) => hash(Object.entries(pieces).map(([k, v]) => `${k}=${v}`).sort().join('\n'));

/** Apply `explain:` entries to a computed view. `verify` (the code graph is ready, so symbol links are complete) enables the
 * fingerprint check; without it entries apply unchecked (old-format fingerprints still report `legacy`). Stale, legacy and
 * unstamped entries add warnings (first), unresolved keys add `diagnostics.unresolved` links (rule "explain"). */
export async function applyExplain(result: ViewResult, entries: ExplainEntry[],
  options: { verify: boolean; readSource?: ReadSource; callees?: ComputeDeps['callees']; fileSymbols?: ComputeDeps['fileSymbols'] }): Promise<ViewResult> {
  const nodes = result.nodes.map(n => ({ ...n })), groups = result.groups.map(g => ({ ...g })), file = result.file ?? '';
  const sources = new Map<string, Promise<string | null>>();
  const read = (f: string) => sources.get(f) ?? sources.set(f, options.readSource ? options.readSource(f) : Promise.resolve(null)).get(f)!;
  const labelOf = (id: string) => [...nodes, ...groups].find(t => t.id === id)?.label ?? id;
  const warnings: ViewWarning[] = [], unresolved: UnresolvedLink[] = [], diagnostics: ExplainDiagnostic[] = [];
  const targetsOf = entries.map(e => explainTargets(e.key, nodes, groups));
  // One callee lookup per compute (all entries' symbols) and one symbol lookup per file.
  const ids = [...new Set(targetsOf.flat().flatMap(t => (t.symbol ? [t.symbol.id] : [])))];
  const allCallees = options.verify && options.callees && ids.length ? options.callees(ids) : null;
  const symbolsOf = new Map<string, ReturnType<NonNullable<ComputeDeps['fileSymbols']>>>(), fileSymbols = options.fileSymbols;
  const pieceDeps: PieceDeps = { read, callees: allCallees ? () => allCallees : undefined,
    fileSymbols: fileSymbols && (f => symbolsOf.get(f) ?? symbolsOf.set(f, fileSymbols(f)).get(f)!) };
  for (const [i, e] of entries.entries()) {
    const targets = targetsOf[i];
    const current: Pieces = options.verify && targets.length
      ? await collectPieces(targets, nodes, groups, pieceDeps)
      : { pieces: null, skipped: [], files: [] };
    const files = current.pieces ? current.files : [...new Set(targets.flatMap(t => (t.symbol ? [t.symbol.file] : [])))].sort();
    const diagnostic: ExplainDiagnostic = { key: e.key, line: e.line, matches: targets.length, fingerprint: current.pieces && summaryHash(current.pieces),
      pieces: current.pieces, skipped: current.skipped, status: null, changes: NO_CHANGES, files };
    diagnostics.push(diagnostic);
    if (!targets.length) { unresolved.push({ rule: 'explain', value: e.key, file, line: e.line ?? 0 }); continue; }
    // A legacy or missing stamp needs no code; an entry whose code cannot be hashed cannot be checked.
    const { status, changes } = current.pieces ? compareFingerprint(e.fingerprint, current.pieces)
      : typeof e.fingerprint === 'string' ? { status: 'legacy' as const, changes: NO_CHANGES }
      : { status: e.fingerprint === null || current.why ? 'unstamped' as const : 'view' as const, changes: NO_CHANGES };
    const reason = status === 'stale' ? describeChanges(changes, labelOf) : status === 'legacy' ? LEGACY_REASON : status === 'unstamped' ? current.why : undefined;
    Object.assign(diagnostic, { status, changes });
    for (const t of targets) Object.assign(t, { explanation: e.text, explanationStatus: status }, reason ? { explanationReason: reason } : {});
    const message = status === 'stale' ? `explanation for "${e.key}" ${reason}${ADVICE}`
      : status === 'legacy' ? `explanation for "${e.key}" uses the old fingerprint format (own body only)${ADVICE}`
      : status !== 'unstamped' ? null
      : !current.why ? `explanation for "${e.key}" has no fingerprint — run stingray-views check --restamp to stamp it`
      : e.fingerprint === null ? `explanation for "${e.key}" has no fingerprint and cannot be checked: ${current.why}`
      : `explanation for "${e.key}" cannot be checked: ${current.why}`;
    if (message) warnings.push({ file, line: e.line, message });
  }
  return {
    ...result, nodes, groups, warnings: [...warnings, ...result.warnings],
    diagnostics: result.diagnostics && { ...result.diagnostics, unresolved: [...result.diagnostics.unresolved, ...unresolved], explain: diagnostics },
  };
}
