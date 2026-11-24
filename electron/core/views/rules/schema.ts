// YAML view files (.stingray/views/<slug>.yaml) and rule files (.stingray/rules/<name>.yaml): parsing and validation.
// Errors carry the YAML file and 1-based line so agents can fix them from `stingray-views check` output.
import * as path from '../../shared/posix-path';
import { matchesGlob } from '../../shared/ports';
import { LineCounter, isMap, isScalar, parseDocument, type Document, type Pair } from 'yaml';
import { z } from 'zod';
import { VIEW_KINDS, positionsSchema, type ViewKind, type ViewLayout } from '../../../../shared/contracts/views';
import { GRAMMAR_FILES } from '../../shared/grammar-files';
import { LINK_SETS, SEQUENCE_PARTICIPANTS, type Emit, type FlowchartStep, type GraphStep, type LayersStep, type Rule, type RuleSourceName, type Scope, type SequenceStep, type SourcedRule } from './types';

export const SLUG = /^[a-z0-9-]{1,64}$/;
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
  (scope?.include ?? ['**/*']).some(g => matchesGlob(file, g)) && !(scope?.exclude ?? []).some(g => matchesGlob(file, g));

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
  query: z.string().min(1).refine(q => new TextEncoder().encode(q).length <= MAX_QUERY_BYTES, { error: 'Query is larger than 8 KiB' }),
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

const flowchartSchema = z.strictObject({
  start: z.strictObject({ symbol: z.string().min(1).max(200), file: z.string().min(1).max(500).optional() }),
  depth: z.int().min(0).max(4).default(1),
  include: globs.optional(),
  exclude: globs.optional(),
  hide: z.array(z.string().min(1).max(200)).max(100).optional(),
});

const sequenceSchema = z.strictObject({
  start: z.strictObject({ symbol: z.string().min(1).max(200).optional(), route: z.string().min(1).max(300).optional(), file: z.string().min(1).max(500).optional() })
    .refine(s => (s.symbol === undefined) !== (s.route === undefined), { error: 'start needs exactly one of symbol or route' }),
  trigger: z.string().min(1).max(200).optional(),
  actor: z.string().min(1).max(80).default('User'),
  depth: z.int().min(0).max(6).default(3),
  participants: z.enum(SEQUENCE_PARTICIPANTS).default('auto'),
  internal: z.enum(['collapse', 'show']).default('collapse'),
  returns: z.boolean().default(true),
  links: z.array(z.enum(LINK_SETS)).max(LINK_SETS.length).default([...LINK_SETS]).transform(l => [...new Set(l)]),
  externals: z.record(z.string().min(1).max(100), z.string().min(1).max(80)).refine(e => Object.keys(e).length <= 50, { error: 'At most 50 externals' }).default({}),
  include: globs.optional(),
  exclude: globs.optional(),
});

const layersSchema = z.strictObject({
  depth: z.int().min(1).max(4).default(1),
  expand: z.array(z.string().min(1).max(200)).max(50).optional(),
});

export const layoutSchema = z.strictObject({ positions: positionsSchema.optional() });

export const FINGERPRINT = /^[0-9a-f]{12}$/, MAX_EXPLAIN = 200, MAX_PIECES = 200;
// An unquoted all-digit fingerprint reads as a YAML number.
const pieceHash = z.string({ error: 'fingerprint must be a quoted string of 12 hex characters, e.g. fingerprint: "012345678901"' })
  .regex(FINGERPRINT, { error: 'fingerprint must be 12 hex characters (written by stingray-views check --restamp)' });
const pieceMap = z.record(z.string().min(1).max(500), pieceHash)
  .refine(m => Object.keys(m).length <= MAX_PIECES, { error: `fingerprint has at most ${MAX_PIECES} pieces` });
/** A map of piece key → hash (written by --restamp), or one hash (the old format: the own body only). A union would report
 * only "Invalid input", so the shape is picked by the value's type to keep the specific messages. */
const fingerprintSchema = z.unknown().transform((v, ctx) => {
  const parsed = (typeof v === 'object' && v !== null && !Array.isArray(v) ? pieceMap : pieceHash).safeParse(v);
  if (parsed.success) return parsed.data;
  for (const { message, path } of parsed.error.issues) ctx.addIssue({ code: 'custom', message, path });
  return z.NEVER;
});
/** `explain:` entries keyed by node id, alias, group id or symbol name: prose that overrides the docstring explanation.
 * Entries are objects so planning keys (e.g. a future `note:`) can be added next to `text` later. */
export const explainSchema = z.record(z.string().min(1).max(300), z.strictObject({
  text: z.string().trim().min(1).max(500),
  fingerprint: fingerprintSchema.optional(),
})).refine(e => Object.keys(e).length <= MAX_EXPLAIN, { error: `At most ${MAX_EXPLAIN} explain entries` });

export const viewSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  kind: z.enum(VIEW_KINDS),
  scope: z.strictObject({ include: globs.default(['**/*']), exclude: globs.default([]) }).default({ include: ['**/*'], exclude: [] }),
  use: z.array(z.string().regex(SLUG, { error: 'Set names are 1-64 characters a-z, 0-9 or "-"' })).max(MAX_USE).optional(),
  rules: rulesSchema.optional(),
  graph: graphSchema.optional(),
  flowchart: flowchartSchema.optional(),
  layers: layersSchema.optional(),
  sequence: sequenceSchema.optional(),
  include: names.optional(),   // node ids/labels always kept
  exclude: names.optional(),   // node ids/labels always dropped (wins over include)
  layout: layoutSchema.optional(),
  explain: explainSchema.optional(),
}).superRefine((v, ctx) => {
  if (v.kind === 'flowchart' && !v.flowchart) ctx.addIssue({ code: 'custom', path: ['kind'], message: 'kind: flowchart needs a flowchart: section' });
  if (v.flowchart && v.kind !== 'flowchart') ctx.addIssue({ code: 'custom', path: ['flowchart'], message: 'flowchart: needs kind: flowchart' });
  // v1: a flowchart is computed from its entry function alone; mixing with rules/graph steps can come later.
  if (v.flowchart) for (const key of ['use', 'rules', 'graph'] as const) {
    if (v[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: `${key}: cannot be combined with flowchart:` });
  }
  if (v.layers && v.kind !== 'graph') ctx.addIssue({ code: 'custom', path: ['layers'], message: 'needs kind: graph' });
  if (v.kind === 'sequence' && !v.sequence) ctx.addIssue({ code: 'custom', path: ['kind'], message: 'kind: sequence needs a sequence: section' });
  if (v.sequence && v.kind !== 'sequence') ctx.addIssue({ code: 'custom', path: ['sequence'], message: 'sequence: needs kind: sequence' });
  if (v.kind === 'sequence') {
    for (const key of ['use', 'graph', 'flowchart', 'layers'] as const) {
      if (v[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: `${key}: cannot be combined with kind: sequence` });
    }
    // Rules of a sequence only teach it extra hops (docs/sequence-view-spec.md §Links).
    (v.rules ?? []).forEach((r, i) => {
      if (!r.emit.edge || r.emit.edge.kind !== 'link') ctx.addIssue({ code: 'custom', path: ['rules', i, 'emit'], message: 'rules of a sequence view must emit edge: { from, to, kind: link }' });
    });
  }
  if (!v.flowchart && !v.layers && !v.sequence && !v.use?.length && !v.rules?.length && !v.graph) ctx.addIssue({ code: 'custom', path: [], message: 'A view needs at least one of use, rules, graph, flowchart, layers or sequence' });
});

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

/** The `explain:` pair whose key reads as `key` (YAML keys like `123:` are numbers in the document). */
export function explainPair(doc: Document, key: string): Pair | undefined {
  const map = doc.get('explain', true);
  return isMap(map) ? map.items.find(p => isScalar(p.key) && String(p.key.value) === key) as Pair | undefined : undefined;
}
const keyLine = (src: Located, pair: Pair | undefined) => {
  const range = (pair?.key as { range?: [number, number, number] } | undefined)?.range;
  return range ? src.lines.linePos(range[0]).line : null;
};

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
  flowchart: FlowchartStep | null;
  layers: LayersStep | null;
  sequence: SequenceStep | null;
  include: string[];
  exclude: string[];
  layout: ViewLayout | null;
  explain: ExplainEntry[];
}

/** One `explain:` entry; `line` is the 1-based line of its key in the view file. */
export interface ExplainEntry { key: string; text: string; fingerprint: string | Record<string, string> | null; line: number | null }

/** Parse and validate a view file. Throws YamlError. */
export function parseViewYaml(text: string, file: string): ViewDefinition {
  const src = parseYaml(text, file);
  const v = validate(viewSchema, src);
  return {
    name: v.name, description: v.description ?? '', kind: v.kind, scope: v.scope,
    use: [...new Set(v.use ?? [])].map(name => ({ name, line: lineAt(src, ['use', (v.use ?? []).indexOf(name)]) })),
    rules: sourced(src, v.rules ?? [], 'view'),
    graph: v.graph ?? null, flowchart: v.flowchart ?? null, layers: v.layers ?? null, sequence: v.sequence ?? null, include: v.include ?? [], exclude: v.exclude ?? [],
    layout: v.layout ? { positions: v.layout.positions ?? {} } : null,
    explain: Object.entries(v.explain ?? {}).map(([key, e]) => ({ key, text: e.text, fingerprint: e.fingerprint ?? null, line: keyLine(src, explainPair(src.doc, key)) })),
  };
}

/** Parse and validate a rule file (or builtin set) whose name must be `name`. Throws YamlError. */
export function parseRuleFileYaml(text: string, file: string | null, name: string, source: RuleSourceName): { description: string; rules: SourcedRule[] } {
  const src = parseYaml(text, file);
  const r = validate(ruleFileSchema, src);
  if (r.name !== name) throw new YamlError(file, lineAt(src, ['name']), `name: must equal the file name "${name}"`);
  return { description: r.description ?? '', rules: sourced(src, r.rules, source) };
}
