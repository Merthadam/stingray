// A symbol's docstring summary, shown as the "explanation" of symbol-backed view nodes and groups. Pure.
import type { GraphSymbol } from './rules/types';

export const MAX_EXPLANATION = 300;

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
  const sentenceEnd = lines.findIndex((t, i) => i >= start && /[.!?]["')\]]?$/.test(t));
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
