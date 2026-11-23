// A symbol's docstring summary, shown as the "explanation" of symbol-backed view nodes and groups. Pure.
import type { SymbolRef } from '../../shared/contracts/views';
import type { GraphSymbol } from './rules/types';

// The full first paragraph: the UI clamps it to 3 lines with the full text in the tooltip/Inspector; text output cuts at 300.
export const MAX_EXPLANATION = 2000;
// A line ending in one of these abbreviations does not end a sentence.
const ABBREVIATION_END = /\b(e\.g|i\.e|etc|vs|cf|approx)\.$/i;

/** First paragraph of a docstring (up to a blank line or the first JSDoc `@tag`), comment markers and quotes stripped,
 * whitespace collapsed, capped at MAX_EXPLANATION with an ellipsis; null when nothing is left. Without any blank line
 * the paragraph ends at the first line ending a sentence: CodeGraph drops the blank lines of JSDoc and `//` comments. */
export function docstringSummary(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim()
    .replace(/^[rRuUbB]{0,2}("""|''')([\s\S]*?)\1$/, '$2')
    .replace(/^\/\*\*?/, '').replace(/\*\/$/, '');
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().replace(/^(\*(?!\/)|\/\/[/!]?|#+)/, '').trim();
    if (t.startsWith('@')) break;
    lines.push(t);
  }
  while (lines.length && !lines.at(-1)) lines.pop();
  const start = lines.findIndex(Boolean);
  const blank = lines.indexOf('', start + 1);
  const sentenceEnd = lines.findIndex((t, i) => i >= start && /[.!?]["')\]]?$/.test(t) && !ABBREVIATION_END.test(t));
  const end = blank >= 0 ? blank : sentenceEnd >= 0 ? sentenceEnd + 1 : lines.length;
  const summary = (start < 0 ? [] : lines.slice(start, end)).join(' ').replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  return summary.length > MAX_EXPLANATION ? summary.slice(0, MAX_EXPLANATION - 1).trimEnd() + '…' : summary;
}

/** `{ explanation }` for spreading into a node or group, or nothing (so symbols without a docstring render as before). */
export function explanationOf(symbol: GraphSymbol | null | undefined): { explanation?: string } {
  const explanation = docstringSummary(symbol?.docstring);
  return explanation ? { explanation } : {};
}

/** The SymbolRef of a node or group; keeps the body's end line, which `explain:` fingerprints hash up to. */
export const symbolRef = (s: GraphSymbol): SymbolRef =>
  ({ id: s.id, name: s.name, kind: s.kind, file: s.file, line: s.line, ...(s.endLine ? { endLine: s.endLine } : {}),
    ...(s.qualifiedName ? { qualifiedName: s.qualifiedName } : {}) });
