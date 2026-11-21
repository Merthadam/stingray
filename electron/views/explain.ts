// `explain:` entries of a view file: prose for nodes and groups (also ones without a symbol, e.g. tables or LangGraph steps)
// that overrides their docstring explanation. Each entry may carry a fingerprint of the code it was written for; `check`
// recomputes it and flags explanations whose code changed since ("may be outdated"). `stingray-views check --restamp`
// writes the current fingerprints back into the file.
import { createHash } from 'node:crypto';
import type { DiagramGroup, DiagramNode, ExplainDiagnostic, ExplanationStatus, SymbolRef, UnresolvedLink, ViewResult, ViewWarning } from '../../src/views';
import type { ExplainEntry } from './rules/schema';

export type ReadSource = (file: string) => Promise<string | null>;
type Target = DiagramNode | DiagramGroup;

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Fingerprint of a symbol's own body (lines line..endLine; callees are not included), ignoring trailing whitespace and
 * line endings; null when the end line is unknown or past the end of the file. */
export function bodyFingerprint(source: string, symbol: SymbolRef): string | null {
  const lines = source.split(/\r\n|\r|\n/);
  if (!symbol.endLine || symbol.endLine < symbol.line || symbol.endLine > lines.length) return null;
  return hash(lines.slice(symbol.line - 1, symbol.endLine).map(l => l.trimEnd()).join('\n'));
}

/** Fingerprint of a node or group without a symbol, as drawn: label, kind, subtitle, detail and fields (label, type, badges),
 * so e.g. a table's changes when its columns do. */
export function drawnFingerprint(t: Target): string {
  const n = t as Partial<DiagramNode>;
  return hash(JSON.stringify([squash(t.label), squash(n.kind ?? 'group'), squash(n.subtitle), squash(n.detail),
    (n.fields ?? []).map(f => [squash(f.label), squash(f.type), f.badges.map(squash)])]));
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

/** Apply `explain:` entries to a computed view. `verify` (the code graph is ready, so symbol links are complete) enables the
 * fingerprint check; without it entries apply unchecked. Stale and unstamped entries add warnings (first), unresolved keys
 * add `diagnostics.unresolved` links (rule "explain"). */
export async function applyExplain(result: ViewResult, entries: ExplainEntry[], options: { verify: boolean; readSource?: ReadSource }): Promise<ViewResult> {
  const nodes = result.nodes.map(n => ({ ...n })), groups = result.groups.map(g => ({ ...g })), file = result.file ?? '';
  const sources = new Map<string, Promise<string | null>>();
  const read = (f: string) => sources.get(f) ?? sources.set(f, options.readSource ? options.readSource(f) : Promise.resolve(null)).get(f)!;
  const fingerprint = async (t: Target) => {
    if (!t.symbol) return drawnFingerprint(t);
    const source = await read(t.symbol.file);
    return source === null ? null : bodyFingerprint(source, t.symbol);
  };
  const warnings: ViewWarning[] = [], unresolved: UnresolvedLink[] = [], diagnostics: ExplainDiagnostic[] = [];
  for (const e of entries) {
    const targets = explainTargets(e.key, nodes, groups);
    const current = options.verify && targets.length ? await fingerprint(targets[0]) : null;
    diagnostics.push({ key: e.key, line: e.line, matches: targets.length, fingerprint: current });
    if (!targets.length) { unresolved.push({ rule: 'explain', value: e.key, file, line: e.line ?? 0 }); continue; }
    const status: ExplanationStatus = !e.fingerprint ? 'unstamped' : current !== null && current !== e.fingerprint ? 'stale' : 'view';
    for (const t of targets) Object.assign(t, { explanation: e.text, explanationStatus: status });
    if (status === 'stale') warnings.push({ file, line: e.line,
      message: `explanation for "${e.key}" may be outdated (code changed since it was written) — review it and run stingray-views check --restamp` });
    if (status === 'unstamped') warnings.push({ file, line: e.line, message: `explanation for "${e.key}" has no fingerprint — run stingray-views check --restamp to stamp it` });
  }
  return {
    ...result, nodes, groups, warnings: [...warnings, ...result.warnings],
    diagnostics: result.diagnostics && { ...result.diagnostics, unresolved: [...result.diagnostics.unresolved, ...unresolved], explain: diagnostics },
  };
}
