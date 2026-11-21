// A symbol's docstring summary, shown as the "explanation" of symbol-backed view nodes and groups. Pure.
import type { GraphSymbol } from './rules/types';

export const MAX_EXPLANATION = 300;

/** First paragraph of a docstring (up to a blank line or the first JSDoc `@tag`), comment markers and quotes stripped,
 * whitespace collapsed, capped at MAX_EXPLANATION with an ellipsis; null when nothing is left. */
export function docstringSummary(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim()
    .replace(/^[rRuUbB]{0,2}("""|''')([\s\S]*?)\1$/, '$2')
    .replace(/^\/\*\*?/, '').replace(/\*\/$/, '');
  const paragraph: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().replace(/^(\*(?!\/)|\/\/[/!]?|#+)/, '').trim();
    if (t.startsWith('@')) break;
    if (!t) { if (paragraph.length) break; continue; }
    paragraph.push(t);
  }
  const summary = paragraph.join(' ').replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  return summary.length > MAX_EXPLANATION ? summary.slice(0, MAX_EXPLANATION - 1).trimEnd() + '…' : summary;
}

/** `{ explanation }` for spreading into a node or group, or nothing (so symbols without a docstring render as before). */
export function explanationOf(symbol: GraphSymbol | null | undefined): { explanation?: string } {
  const explanation = docstringSummary(symbol?.docstring);
  return explanation ? { explanation } : {};
}
