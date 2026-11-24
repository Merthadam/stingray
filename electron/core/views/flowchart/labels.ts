// Flowchart labels (docs/flowchart-view-spec.md §Labels): code text tidied into short phrases. Pure; the untidied code
// always stays in the node's `detail`, so tidying never hides what the code says.

// Room for up to three wrapped lines in a card; the full code text stays in `detail` (inspector).
export const MAX_LABEL = 90;

export const truncate = (text: string, max = MAX_LABEL) => text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;

/** "send_reset_email" / "sendResetEmail" / "HTTPServer" -> "send reset email" / "send reset email" / "http server". */
export const splitWords = (name: string) => name
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .split(/[_\s$]+/).filter(Boolean).map(w => w.toLowerCase()).join(' ');

const OPERATORS: Record<string, string> = { '=>': '', '===': 'is', '==': 'is', '!==': 'is not', '!=': 'is not', '&&': 'and', '||': 'or', '??': 'or', '!': 'not' };
const TOKEN = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|([A-Za-z_$][\w$]*)|(\d+(?:\.\d+)?)|(=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|[<>+\-*/%!])|\s+|./gs;

/** Code text as words: identifiers split, `self.`/`this.`/`await` dropped, operators spelled out, punctuation removed. */
export function words(code: string): string {
  const out: string[] = [];
  for (const [, str, ident, num, op] of code.replace(/\b(self|this)\s*\??\./g, '').matchAll(TOKEN)) {
    if (str) out.push(str);
    else if (ident) { if (ident !== 'await') out.push(splitWords(ident) || ident); }
    else if (num) out.push(num);
    else if (op) { if (OPERATORS[op] !== '') out.push(OPERATORS[op] ?? op); } // `=>` of an inline callback: dropped
  }
  return out.join(' ').trim();
}

/** Strip balanced outer parentheses: "((a) && b)" -> "(a) && b". */
function unwrap(code: string): string {
  let s = code.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0, closesEarly = false;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) { closesEarly = true; break; }
    }
    if (closesEarly) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

const NULLISH = '(?:None|null|undefined)';
/** [pattern, label template, flips the answer]: the condition is true exactly when the label's answer is No if flipped. */
const DECISIONS: [RegExp, (x: string) => string, boolean][] = [
  [new RegExp(`^(.+?)\\s+is\\s+not\\s+${NULLISH}$`, 's'), x => `has ${x}?`, false],
  [new RegExp(`^(.+?)\\s*!==?\\s*${NULLISH}$`, 's'), x => `has ${x}?`, false],
  [new RegExp(`^(.+?)\\s+is\\s+${NULLISH}$`, 's'), x => `has ${x}?`, true],
  [new RegExp(`^(.+?)\\s*===?\\s*${NULLISH}$`, 's'), x => `has ${x}?`, true],
  [/^len\((.+)\)\s*==\s*0$/s, x => `${x} empty?`, false],
  [/^(.+)\.length\s*===?\s*0$/s, x => `${x} empty?`, false],
  [/^len\((.+)\)\s*(?:>|!=)\s*0$/s, x => `${x} empty?`, true],
  [/^(.+)\.length\s*(?:>|!==?)\s*0$/s, x => `${x} empty?`, true],
  [/^len\((.+)\)$/s, x => `${x} empty?`, true],      // truthy length = not empty
  [/^(.+)\.length$/s, x => `${x} empty?`, true],
];

/** `code` with bracketed and quoted parts blanked out, so operator tests only see its top level; `balanced`: every
 * bracket closes inside `code`. */
function scan(code: string): { top: string; balanced: boolean } {
  let top = '', depth = 0, quote: string | null = null, balanced = true;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; top += ' '; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; top += ' '; continue; }
    if ('([{'.includes(ch)) depth++;
    top += depth ? ' ' : ch;
    if (')]}'.includes(ch)) { if (depth === 0) balanced = false; depth = Math.max(0, depth - 1); }
  }
  return { top, balanced: balanced && depth === 0 };
}
const topLevel = (code: string) => scan(code).top;
/** A single operand: `len(a) != len(b)` must not read as "len(a) … empty?". */
const operand = (code: string) => { const { top, balanced } = scan(code); return balanced && !/[=<>]|\b(?:is|in)\b/.test(top); };
const BOOLEAN = /\b(?:and|or)\b|&&|\|\||\?\?/;

/** Decision label for a condition. `negated`: the condition is true when the label's answer is No (its branch is "No"). */
export function decisionLabel(condition: string): { label: string; negated: boolean } {
  let s = unwrap(condition).replace(/^await\s+/, ''), negated = false;
  for (;;) {
    const not = /^not\s+/.exec(s) ?? /^!(?!=)/.exec(s);
    if (!not) break;
    // `not a or b` / `!a && b` / `!a === b`: the negation binds to the first operand only, so it cannot flip the answer.
    const rest = topLevel(s.slice(not[0].length));
    if (BOOLEAN.test(rest) || (not[0] === '!' && /[=<>+\-*/%]|\?(?!\.)/.test(rest))) break;
    s = unwrap(s.slice(not[0].length));
    negated = !negated;
  }
  if (BOOLEAN.test(topLevel(s))) return { label: truncate(`${words(s)}?`), negated };
  for (const [pattern, label, flips] of DECISIONS) {
    const m = pattern.exec(s);
    if (m && operand(m[1])) return { label: truncate(label(words(m[1]))), negated: negated !== flips };
  }
  return { label: truncate(`${words(s)}?`), negated };
}

/** Action/call label: the callee name in words, receiver already dropped by the adapter. */
export const callLabel = (callee: string) => truncate(splitWords(callee) || callee);

/** Loop label: "more <items>?" for for-each loops over a name, else the condition (while/for(;;)). */
export function loopLabel(loop: { over: string | null; cond: string | null }): { label: string; negated: boolean } {
  if (loop.over !== null) {
    const name = /^[\w$.?]+$/.test(loop.over.trim()) ? loop.over.trim().split(/\??\./).at(-1)! : '';
    return { label: truncate(`more ${(name && /^[A-Za-z_$]/.test(name) && splitWords(name)) || 'items'}?`), negated: false };
  }
  return loop.cond ? decisionLabel(loop.cond) : { label: 'repeat?', negated: false };
}

/** End label: the returned value, or "done" for a bare return / None / null / undefined. */
export function endLabel(value: string | null): string {
  const v = value?.trim().replace(/;$/, '') ?? '';
  return !v || /^(None|null|undefined)$/.test(v) ? 'done' : truncate(words(v) || v);
}

/** Error label: "ValueError: no name" for `raise ValueError("no name")` / `throw new Error('no name')`, "re-raise" for bare `raise`. */
export function errorLabel(value: string | null): string {
  const v = value?.trim().replace(/;$/, '') ?? '';
  if (!v) return 're-raise';
  const m = /^(?:new\s+)?([\w$.]+)\s*\(\s*(?:f?(["'`])((?:(?!\2).)*)\2)?[^]*\)$/s.exec(v);
  if (m) return truncate(m[3] ? `${m[1].split('.').at(-1)}: ${m[3]}` : m[1].split('.').at(-1)!);
  return truncate(v);
}

/** Case label: the pattern code; `_` / `default` / none -> "other". */
export const caseLabel = (pattern: string | null) => !pattern || /^(_|default)$/.test(pattern.trim()) ? 'other' : truncate(pattern.trim().replace(/\s+/g, ' '));
