// YAML view files (.stingray/views/<slug>.yaml) and rule files (.stingray/rules/<name>.yaml): parsing and validation.
// Errors carry the YAML file and 1-based line so agents can fix them from `stingray-views check` output.
import path from 'node:path';
import { LineCounter, isMap, isScalar, parseDocument, type Document } from 'yaml';
import { z } from 'zod';
import type { ViewKind, ViewLayout } from '../../../src/views';
import { GRAMMAR_FILES } from './grammars';
import type { Emit, GraphStep, Rule, RuleSourceName, Scope, SourcedRule } from './types';

export const SLUG = /^[a-z0-9-]{1,64}$/;
export const KINDS: ViewKind[] = ['tables', 'flow', 'timeline', 'graph'];
export const MAX_USE = 8, MAX_RULES = 50, MAX_QUERY_BYTES = 8 * 1024;

// Globs run on the main thread (path.matchesGlob compiles to backtracking regexes), so repo-controlled patterns are
// limited to forms that match in linear-ish time: no braces/extglobs, at most 2 `*` per segment and 3 `**` segments.
// (4 stars in one segment against a 200-char name already takes seconds.)
export const safeGlob = (glob: string) => {
  if (/[{}()!+@\\]/.test(glob)) return false;
  const segments = glob.split('/');
  return segments.filter(s => s === '**').length <= 3 && segments.every(s => s === '**' || (s.match(/\*/g)?.length ?? 0) <= 2);
};
const GLOB_ERROR = 'Unsupported glob: use * (at most 2 per path segment), ** (at most 3), ? and [...]; no {}, (), !, +, @ or \\';
const glob = z.string().min(1).max(256).refine(safeGlob, { error: GLOB_ERROR });
const globs = z.array(glob).max(20);
const names = z.array(z.string().min(1).max(200)).max(500);
const template = z.string().max(1000);
const templates = z.array(template).max(20);

/** Whether a worktree-relative POSIX path is inside a scope (default: everything). */
export const inScope = (file: string, scope: Partial<Scope> | undefined) =>
  (scope?.include ?? ['**/*']).some(g => path.posix.matchesGlob(file, g)) && !(scope?.exclude ?? []).some(g => path.posix.matchesGlob(file, g));

const emitSchema = z.strictObject({
  node: z.strictObject({
    id: template, label: template.optional(), kind: template.optional(), subtitle: template.optional(), group: template.optional(),
    role: template.optional(), order: template.optional(), detail: template.optional(), symbol: template.optional(), aliases: templates.optional(),
  }).optional(),
  edge: z.strictObject({
    from: template, to: template, kind: template.optional(), label: template.optional(), style: z.enum(['solid', 'dashed']).optional(),
    certain: z.boolean().optional(), create: z.enum(['none', 'from', 'to', 'both']).optional(),
  }).optional(),
  field: z.strictObject({
    node: template, id: template, label: template.optional(), type: template.optional(), badges: templates.optional(), detail: template.optional(),
  }).optional(),
  group: z.strictObject({ id: template, label: template.optional() }).optional(),
}).refine(e => Object.keys(e).length === 1, { error: 'emit needs exactly one of node, edge, field or group' });

export const ruleSchema = z.strictObject({
  id: z.string().regex(SLUG, { error: 'Rule id must be 1-64 characters a-z, 0-9 or "-"' }),
  language: z.string().refine(l => Object.hasOwn(GRAMMAR_FILES, l), { error: issue => `Unknown language "${issue.input}"; supported: ${Object.keys(GRAMMAR_FILES).join(', ')}` }),
  files: globs.optional(),
  query: z.string().min(1).refine(q => Buffer.byteLength(q) <= MAX_QUERY_BYTES, { error: 'Query is larger than 8 KiB' }),
  within: z.strictObject({ function: glob.optional(), class: glob.optional() }).optional(),
  emit: emitSchema,
});

const rulesSchema = z.array(ruleSchema).max(MAX_RULES).superRefine((rules, ctx) => {
  const seen = new Set<string>();
  rules.forEach((r, i) => {
    if (seen.has(r.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `Duplicate rule id "${r.id}"` });
    seen.add(r.id);
  });
});

const graphSchema = z.strictObject({
  start: z.array(z.strictObject({ symbol: z.string().min(1).max(200), file: z.string().min(1).max(500).optional() })).min(1).max(10),
  follow: z.array(z.enum(['calls', 'imports', 'inherits', 'references'])).min(1).max(4),
  direction: z.enum(['out', 'in', 'both']).default('out'),
  depth: z.int().min(1).max(6).default(3),
  include: globs.optional(),
  exclude: globs.optional(),
  helpers: z.enum(['show', 'collapse', 'hide']).default('collapse'),
});

const point = z.strictObject({ x: z.number(), y: z.number() }); // zod 4 numbers reject Infinity/NaN
/** Node positions keyed by DiagramNode.id (shared with the local view state). */
export const positionsSchema = z.record(z.string().min(1).max(300), point)
  .refine(p => Object.keys(p).length <= 1000, { error: 'At most 1000 positions' });
export const layoutSchema = z.strictObject({ positions: positionsSchema.optional() });

export const viewSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  kind: z.enum(KINDS),
  scope: z.strictObject({ include: globs.default(['**/*']), exclude: globs.default([]) }).default({ include: ['**/*'], exclude: [] }),
  use: z.array(z.string().regex(SLUG, { error: 'Set names are 1-64 characters a-z, 0-9 or "-"' })).max(MAX_USE).optional(),
  rules: rulesSchema.optional(),
  graph: graphSchema.optional(),
  include: names.optional(),   // node ids/labels always kept
  exclude: names.optional(),   // node ids/labels always dropped (wins over include)
  layout: layoutSchema.optional(),
}).refine(v => v.use?.length || v.rules?.length || v.graph, { error: 'A view needs at least one of use, rules or graph' });

export const ruleFileSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().regex(SLUG, { error: 'Rule file name must be 1-64 characters a-z, 0-9 or "-"' }),
  description: z.string().max(500).optional(),
  rules: rulesSchema.min(1),
});

/** A YAML problem located in a file (worktree-relative; null for builtin sets) at a 1-based line (null when unknown). */
export class YamlError extends Error {
  constructor(readonly file: string | null, readonly line: number | null, message: string) { super(message); this.name = 'YamlError'; }
}

type PathKey = string | number;
interface Located { doc: Document; lines: LineCounter; file: string | null }

/** 1-based line of the node at `keys`, or of its nearest existing parent. */
function lineAt(src: Located, keys: readonly PropertyKey[]): number | null {
  for (let n = keys.length; n >= 0; n--) {
    const node = src.doc.getIn(keys.slice(0, n) as PathKey[], true) as { range?: [number, number, number] } | undefined;
    if (node?.range) return src.lines.linePos(node.range[0]).line;
  }
  return null;
}

function parseYaml(text: string, file: string | null): Located & { value: unknown } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true, prettyErrors: false });
  const error = doc.errors[0];
  if (error) throw new YamlError(file, lines.linePos(error.pos[0]).line, `Invalid YAML: ${error.message}`);
  let value: unknown;
  try { value = doc.toJS({ maxAliasCount: 50 }); } catch (e) { throw new YamlError(file, null, `Invalid YAML: ${(e as Error).message}`); }
  return { doc, lines, file, value };
}

function validate<S extends z.ZodType>(schema: S, src: Located & { value: unknown }): z.infer<S> {
  const parsed = schema.safeParse(src.value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  // Point unknown keys at the key itself rather than at the enclosing object.
  if (issue.code === 'unrecognized_keys') {
    const map = issue.path.length ? src.doc.getIn(issue.path as PathKey[], true) : src.doc.contents;
    const pair = isMap(map) ? map.items.find(p => isScalar(p.key) && p.key.value === issue.keys[0]) : undefined;
    const range = (pair?.key as { range?: [number, number, number] } | undefined)?.range;
    if (range) throw new YamlError(src.file, src.lines.linePos(range[0]).line, issueText(issue));
  }
  throw new YamlError(src.file, lineAt(src, issue.path), issueText(issue));
}

const issueText = (issue: z.ZodError['issues'][number]) => issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;

function sourced(src: Located, rules: z.infer<typeof ruleSchema>[], source: RuleSourceName): SourcedRule[] {
  return rules.map((rule, i) => {
    const query = src.doc.getIn(['rules', i, 'query'], true) as { type?: string; range?: [number, number, number] } | undefined;
    // Block scalars (`query: |`) start their text on the line after the indicator.
    const block = query?.type === 'BLOCK_LITERAL' || query?.type === 'BLOCK_FOLDED';
    const queryLine = query?.range ? src.lines.linePos(query.range[0]).line + (block ? 1 : 0) : null;
    return { source, file: src.file, line: lineAt(src, ['rules', i]), queryLine, rule: { ...rule, emit: rule.emit as Emit } as Rule };
  });
}

export interface ViewDefinition {
  name: string;
  description: string;
  kind: ViewKind;
  scope: Scope;
  use: { name: string; line: number | null }[];
  rules: SourcedRule[];       // inline rules (source "view")
  graph: GraphStep | null;
  include: string[];
  exclude: string[];
  layout: ViewLayout | null;
}

/** Parse and validate a view file. Throws YamlError. */
export function parseViewYaml(text: string, file: string): ViewDefinition {
  const src = parseYaml(text, file);
  const v = validate(viewSchema, src);
  return {
    name: v.name, description: v.description ?? '', kind: v.kind, scope: v.scope,
    use: [...new Set(v.use ?? [])].map(name => ({ name, line: lineAt(src, ['use', (v.use ?? []).indexOf(name)]) })),
    rules: sourced(src, v.rules ?? [], 'view'),
    graph: v.graph ?? null, include: v.include ?? [], exclude: v.exclude ?? [],
    layout: v.layout ? { positions: v.layout.positions ?? {} } : null,
  };
}

/** Parse and validate a rule file (or builtin set) whose name must be `name`. Throws YamlError. */
export function parseRuleFileYaml(text: string, file: string | null, name: string, source: RuleSourceName): { description: string; rules: SourcedRule[] } {
  const src = parseYaml(text, file);
  const r = validate(ruleFileSchema, src);
  if (r.name !== name) throw new YamlError(file, lineAt(src, ['name']), `name: must equal the file name "${name}"`);
  return { description: r.description ?? '', rules: sourced(src, r.rules, source) };
}
