// `kind: sequence` views (docs/sequence-view-spec.md): resolve the entry (function or HTTP route), walk it (walk.ts), then
// turn the trace into lifelines, rows, fragments and notes. Pure apart from reading files through the FileProvider.
import * as path from '../../shared/posix-path';
import { matchesGlob } from '../../shared/ports';
import type { DiagramNode, SequenceData, SequenceDiagnostic, SequenceFragment, SequenceMessage, SequenceNote, SequenceParticipant, ViewWarning } from '../../../../shared/contracts/views';
import type { Node } from 'web-tree-sitter';
import type { FileProvider, GraphApi, GraphLayers, GraphSymbol, LinkSet, SequenceStep } from '../rules/types';
import { FUNCTION_KINDS, at, createLoader, type ParseText } from '../flowchart';
import { named } from '../flowchart/cfg';
import { explanationOf, symbolRef } from '../explanation';
import { fileImports } from './externals';
import { authLinks } from './auth-links';
import { eventLinks } from './event-links';
import { ipcLinks, ipcRoutes, type IpcRoute } from './ipc-links';
import { langgraphLinks } from './langgraph-links';
import { typedMember } from './members';
import { httpLinks, ruleLinks, type LinkProvider, type RuleLink } from './links';
import { SEQUENCE_LIMITS, SequenceWalker, type End, type TraceEvent } from './walk';

const LINK_PROVIDERS: Record<LinkSet, LinkProvider> = { http: httpLinks, auth: authLinks, langgraph: langgraphLinks, events: eventLinks, ipc: ipcLinks };

export interface SequenceOutput {
  sequence: SequenceData;
  nodes: DiagramNode[];       // the participants, mirrored (edges: none)
  warnings: ViewWarning[];
  diagnostic: SequenceDiagnostic;
  truncated: boolean;
}

type Granularity = 'service' | 'module' | 'file' | 'class';
type Lifeline = Omit<SequenceParticipant, 'column'>;

export async function runSequence(step: SequenceStep, graph: GraphApi, files: FileProvider, parse: ParseText,
  inScope: (file: string) => boolean, exclude: string[] = [], rules: RuleLink[] = [], halted: () => boolean = () => false): Promise<SequenceOutput> {
  const warnings: ViewWarning[] = [];
  const diagnostic: SequenceDiagnostic = { start: null, depth: step.depth, participants: step.participants === 'auto' ? 'file' : step.participants,
    functions: 0, messages: 0, links: {}, truncated: false, error: null };
  const fail = (error: string): SequenceOutput =>
    ({ sequence: { participants: [], messages: [], fragments: [], notes: [] }, nodes: [], warnings, diagnostic: { ...diagnostic, error }, truncated: false });

  const loader = createLoader(files, parse, 'sequence');
  try {
    const matches = (globs: string[], file: string) => globs.some(g => matchesGlob(file, g));
    const followable = (file: string) => (step.include ? matches(step.include, file) : inScope(file)) && !matches(step.exclude ?? [], file);
    const importsOf = async (file: string) => { const t = await loader.tree(file); return t ? fileImports(t.rootNode) : new Map<string, string>(); };
    const env = { graph, tree: loader.tree, imports: importsOf, files, followable, memo: new Map<string, unknown>(), halted };
    const entry = step.start.ipc !== undefined ? await resolveIpc(step, env) : resolveStart(step, graph);
    if ('error' in entry) return fail(entry.error);
    diagnostic.start = entry.start;

    const body = await loader.load(entry.symbol);
    if ('error' in body) {
      warnings.push({ file: entry.symbol.file, line: entry.symbol.line, message: body.error });
      return fail(body.error);
    }
    const providers = [...step.links.map(l => LINK_PROVIDERS[l]), ...ruleLinks(rules)];
    const walker = new SequenceWalker(step, graph, loader.load, providers, followable, importsOf, { tree: loader.tree, files, halted, memo: env.memo });
    await walker.entry(entry.symbol, body.constructs, entry.caller);

    const lifelines = new Lifelines(step, graph, walker.events);
    const out = finalize(walker.events, lifelines, step, new Set(exclude));
    const truncated = walker.truncated || out.truncated;
    if (truncated) warnings.push({ file: null, line: null, message: `Sequence stopped at ${out.sequence.messages.length} messages, ${out.sequence.participants.length} participants or ${walker.functions} functions — lower the depth or exclude files` });
    const links: Record<string, number> = {};
    for (const m of out.sequence.messages) if (m.link) links[m.link] = (links[m.link] ?? 0) + 1;
    const nodes = out.sequence.participants.map((p): DiagramNode => ({
      id: p.id, label: p.label, kind: p.kind, subtitle: p.subtitle, group: null, fields: [], source: p.source, symbol: p.symbol, role: null,
      order: p.column, detail: null, ...(p.explanation ? { explanation: p.explanation } : {}),
    }));
    return {
      sequence: out.sequence, nodes, warnings, truncated,
      diagnostic: { ...diagnostic, participants: lifelines.granularity, functions: walker.functions, messages: out.sequence.messages.length, links, truncated },
    };
  } finally { loader.dispose(); }
}

type IpcEnv = Parameters<typeof ipcRoutes>[0];
type Caller = { symbol: GraphSymbol; label: string; link: string; source: { file: string; line: number } };

/** `start.ipc` ("createWorkspace" = renderer or member name, or "git.createWorkspace" = channel): the main-side handler is the
 * entry; with a trigger, the first renderer call site is the caller the trigger reaches. */
async function resolveIpc(step: SequenceStep, env: IpcEnv): Promise<{ symbol: GraphSymbol; start: string; caller?: Caller } | { error: string }> {
  const wanted = step.start.ipc!.trim(), file = step.start.file, where = file ? ` in ${file}` : '';
  const found = (await ipcRoutes(env)).filter(r => (r.channel === wanted || r.renderer === wanted || r.channel.endsWith('.' + wanted)) && (!file || r.file === file || r.handler.file === file));
  if (!found.length) return { error: `start ipc not found: ${wanted}${where}` };
  if (found.length > 1) return { error: `ambiguous start ipc ${wanted}: ${file ? 'several in that file' : 'add a file or use the channel'} (${found.map(r => `${r.channel} ${at(r.handler)}`).join(', ')})` };
  const route = found[0], handler = route.handler, start = `${route.channel} -> ${handler.name} (${at(handler)})`;
  if (!step.trigger) return { symbol: handler, start };
  const sites = await rendererCalls(route, env);
  if (!sites.length) return { symbol: handler, start };
  const more = sites.length > 1 ? ` (+${sites.length - 1} more)` : '';
  return { symbol: handler, start: `${start} from ${sites[0].symbol.name} (${sites[0].source.file}:${sites[0].source.line})${more}`, caller: sites[0] };
}

/** Renderer call sites of a route: `x.<renderer>(…)` in the followable files outside handler files, not on `this`/`self`, and
 * not resolving into the repo (code graph, then type annotations). The caller is the innermost function around the call,
 * else the file. */
async function rendererCalls(route: IpcRoute, env: IpcEnv): Promise<Caller[]> {
  const handlerFiles = new Set((await ipcRoutes(env)).map(r => r.file));
  const { files } = await env.files.list(f => /\.[cm]?[jt]sx?$/.test(f) && env.followable(f) && !handlerFiles.has(f));
  const out: Caller[] = [];
  for (const file of files) {
    if (env.halted()) break;
    if (!(await env.files.read(file))?.includes(route.renderer)) continue;
    const tree = await env.tree(file);
    const sites: Node[] = [];
    const visit = (n: Node) => {
      const fn = n.type === 'call_expression' ? n.childForFieldName('function') : null;
      if (fn?.type === 'member_expression' && fn.childForFieldName('property')?.text === route.renderer && !/^(?:this|self)$/.test(fn.childForFieldName('object')?.text ?? '')) sites.push(n);
      named(n).forEach(visit);
    };
    if (tree) visit(tree.rootNode);
    for (const site of sites) {
      const line = site.startPosition.row + 1, callee = site.childForFieldName('function')!.text.replace(/\s+/g, '');
      const around = env.graph.fileSymbols(file).filter(s => FUNCTION_KINDS.has(s.kind) && s.line <= line && line <= (s.endLine ?? s.line)).sort((a, b) => b.line - a.line)[0];
      if (around && [...env.graph.symbols(env.graph.outgoing([around.id], ['calls']).filter(r => r.line === line).map(r => r.to)).values()].some(s => s.name === route.renderer)) continue;
      if (await typedMember({ callee: route.renderer, line, awaited: false, outer: true, chained: false, path: callee }, file, env)) continue;
      const symbol = around ?? { id: `file:${file}`, name: path.basename(file), kind: 'file', file, line: 1 };
      out.push({ symbol, label: route.channel, link: 'ipc', source: { file, line } });
    }
  }
  return out;
}

/** The entry function: `start.symbol` (optionally in `start.file`) or the handler of `start.route` ("POST /auth/login"). */
function resolveStart(step: SequenceStep, graph: GraphApi): { symbol: GraphSymbol; start: string; caller?: Caller } | { error: string } {
  const { symbol: name, route, file } = step.start;
  const where = file ? ` in ${file}` : '';
  if (route !== undefined) {
    // Route nodes are named "METHOD /path".
    const wanted = route.trim().replace(/\s+/g, ' ').replace(/^\w+/, m => m.toUpperCase());
    const routes = graph.findSymbols(wanted, file).filter(s => s.kind === 'route');
    if (!routes.length) return { error: `start route not found: ${wanted}${where}` };
    if (routes.length > 1) return { error: `ambiguous start route ${wanted}: ${file ? 'several in that file' : 'add a file'} (${routes.map(at).join(', ')})` };
    const handlers = graph.symbols(graph.outgoing([routes[0].id], ['references']).map(r => r.to));
    const handler = [...handlers.values()].find(s => FUNCTION_KINDS.has(s.kind));
    if (!handler) return { error: `start route ${wanted} has no handler function in the code graph` };
    return { symbol: handler, start: `${wanted} -> ${handler.name} (${at(handler)})` };
  }
  const found = graph.findSymbols(name!, file);
  const functions = found.filter(s => FUNCTION_KINDS.has(s.kind));
  if (!found.length) return { error: `start symbol not found: ${name}${where}` };
  if (!functions.length) return { error: `start symbol ${name} is a ${found[0].kind}, not a function or method` };
  if (functions.length > 1) return { error: `ambiguous start symbol ${name}: ${file ? 'several in that file' : 'add a file'} (${functions.map(at).join(', ')})` };
  return { symbol: functions[0], start: `${functions[0].name} (${at(functions[0])})` };
}

/** Lifeline of each message end at the view's granularity (`auto`: services when the reached files span ≥ 2, else
 * modules when they span ≥ 2, else files). */
class Lifelines {
  readonly granularity: Granularity;
  private layers: GraphLayers | null = null;
  private classes = new Map<string, GraphSymbol[]>();

  constructor(private step: SequenceStep, private graph: GraphApi, events: TraceEvent[]) {
    const wanted = step.participants;
    if (wanted === 'service' || wanted === 'module' || wanted === 'auto') this.layers = graph.layers();
    let g: Granularity = wanted === 'auto' ? 'file' : wanted;
    if (wanted === 'auto' && this.layers) {
      const files = new Set(events.flatMap(e => e.t === 'msg' || e.t === 'ret' ? [e.from, e.to] : e.t === 'note' ? [e.at] : [])
        .flatMap(end => 'symbol' in end ? [end.symbol.file] : []));
      const units = (key: (a: { service: string; module: string }) => string) =>
        new Set([...files].flatMap(f => { const a = this.layers!.assignments[f]; return a ? [key(a)] : []; })).size;
      g = units(a => a.service) >= 2 ? 'service' : units(a => `${a.service}/${a.module}`) >= 2 ? 'module' : 'file';
    }
    if ((g === 'service' || g === 'module') && !this.layers) g = 'file';
    this.granularity = g;
  }

  of(end: End): Lifeline {
    if ('actor' in end) return { id: 'actor', label: this.step.actor, kind: 'actor', subtitle: null, source: null, symbol: null };
    if ('external' in end) return { id: `ext:${end.external}`, label: end.external, kind: 'external', subtitle: 'external', source: null, symbol: null };
    const s = end.symbol, first = { source: { file: s.file, line: s.line }, symbol: symbolRef(s), ...explanationOf(s) };
    const assigned = this.layers?.assignments[s.file];
    if (assigned && (this.granularity === 'service' || this.granularity === 'module')) {
      const service = this.layers!.services.find(x => x.id === assigned.service);
      const serviceLabel = service?.label ?? assigned.service;
      if (this.granularity === 'service') return { id: `p:service:${assigned.service}`, label: serviceLabel, kind: 'participant', subtitle: 'service', ...first };
      const module = service?.modules.find(m => m.id === assigned.module);
      return { id: `p:module:${assigned.service}/${assigned.module}`, label: assigned.module === '(root)' ? serviceLabel : module?.label ?? assigned.module,
        kind: 'participant', subtitle: `module of ${serviceLabel}`, ...first };
    }
    if (this.granularity === 'class') {
      const cls = this.enclosingClass(s);
      if (cls) return { id: `p:class:${s.file}#${cls.name}`, label: cls.name, kind: 'participant', subtitle: null, ...first };
    }
    // The file path is in the participant's source (inspector), not on the lifeline.
    return { id: `p:file:${s.file}`, label: path.basename(s.file), kind: 'participant', subtitle: null, ...first };
  }

  /** Innermost class whose lines contain the function. */
  private enclosingClass(s: GraphSymbol): GraphSymbol | null {
    let classes = this.classes.get(s.file);
    if (!classes) this.classes.set(s.file, classes = this.graph.fileSymbols(s.file).filter(c => c.kind === 'class' && c.endLine !== undefined));
    return classes.filter(c => c.line <= s.line && s.line <= c.endLine!).sort((a, b) => b.line - a.line)[0] ?? null;
  }
}

interface OpenFragment { kind: SequenceFragment['kind']; source: SequenceFragment['source']; detail: string | null; order: number; parent: number | null;
  arms: { label: string; first: number; notes: number }[] }
/** A kept fragment's id and the index of each kept arm by its index in the walk (-1: arm dropped). */
interface KeptFragment { id: string; arms: number[] }

/** Trace -> rows: lifelines (actor, repo units, externals; each in first-appearance order), `internal` folding, caps,
 * view `exclude`, fragments that kept a message (arms without messages or notes dropped), notes after the row they follow. */
function finalize(events: TraceEvent[], lifelines: Lifelines, step: SequenceStep, exclude: Set<string>) {
  const participants: SequenceParticipant[] = [], byId = new Map<string, SequenceParticipant>();
  const messages: SequenceMessage[] = [], notes: SequenceNote[] = [], drawn = new Set<number>();
  const fragments: (SequenceFragment & { order: number; parentOrder: number | null })[] = [], open: OpenFragment[] = [];
  const parentOf = new Map<number, number | null>(); // every fragment opened, kept or not
  const within: { order: number; arm: number }[][] = []; // per note: the fragments open around it, innermost first
  const keptArms = new Map<number, number[]>();
  let truncated = false, opened = 0;
  const lifeline = (end: End): SequenceParticipant | null => {
    const l = lifelines.of(end);
    if (exclude.has(l.id) || exclude.has(l.label)) return null;
    let p = byId.get(l.id);
    if (!p) {
      if (participants.length >= SEQUENCE_LIMITS.participants) { truncated = true; return null; }
      byId.set(l.id, p = { ...l, column: participants.length });
      participants.push(p);
    }
    return p;
  };
  const scope = () => open.map(f => ({ order: f.order, arm: f.arms.length - 1 })).reverse();
  const room = () => messages.length < SEQUENCE_LIMITS.messages || ((truncated = true), false);
  const add = (m: Omit<SequenceMessage, 'id'>) => messages.push({ id: `m${messages.length}`, ...m });
  const close = () => {
    const f = open.pop()!, end = { first: messages.length, notes: notes.length };
    const arms = f.arms.filter((a, i) => { const next = f.arms[i + 1] ?? end; return next.first > a.first || next.notes > a.notes; });
    const last = messages.length - 1;
    if (!arms.length || arms[0].first > last) return;
    keptArms.set(f.order, f.arms.map(a => arms.indexOf(a)));
    let label = arms[0].label;
    if (label === 'else' && f.arms[0] !== arms[0]) label = `not ${f.arms[0].label}`;
    const kind = f.kind === 'alt' && arms.length === 1 ? 'opt' : f.kind;
    // The condition's code names the first arm only: with it dropped, the label is another arm's (or its negation).
    const detail = f.detail && arms[0] === f.arms[0] ? { detail: f.detail } : {};
    fragments.push({ id: '', kind, label, first: arms[0].first, last, branches: arms.slice(1).map(a => ({ label: a.label, first: a.first })),
      parent: null, source: f.source, ...detail, order: f.order, parentOrder: f.parent });
  };

  for (const e of events) {
    switch (e.t) {
      case 'msg': {
        if (!room()) break;
        const from = lifeline(e.from), to = from && lifeline(e.to);
        if (!from || !to) break;
        const self = from.id === to.id && e.kind === 'call';
        if (self && step.internal === 'collapse') break;
        drawn.add(e.id);
        add({ from: from.id, to: to.id, kind: self ? 'self' : e.kind, label: e.label, detail: e.detail, level: e.level, certain: e.certain, link: e.link, source: e.source, symbol: e.symbol,
          ...(e.explanation ? { explanation: e.explanation } : {}) });
        break;
      }
      case 'ret': {
        if (!drawn.has(e.call) || !room()) break;
        const from = lifeline(e.from), to = from && lifeline(e.to);
        if (!from || !to || from.id === to.id) break;
        add({ from: from.id, to: to.id, kind: 'return', label: e.label, detail: null, level: e.level, certain: true, link: null, source: e.source, symbol: null });
        break;
      }
      case 'note': {
        // Only raises of the entry and of functions whose call is drawn (handlers, other participants' functions; self
        // calls with internal: show): a collapsed helper's guard raise is noise.
        if (e.entered !== null && !drawn.has(e.entered)) break;
        const p = lifeline(e.at);
        if (!p) break;
        notes.push({ id: `n${notes.length}`, participant: p.id, after: messages.length - 1, text: e.text, kind: 'error', source: e.source, detail: e.detail });
        within.push(scope());
        break;
      }
      case 'open':
        parentOf.set(opened, open.at(-1)?.order ?? null);
        open.push({ kind: e.kind, source: e.source, detail: e.detail, order: opened++, parent: open.at(-1)?.order ?? null, arms: [{ label: e.label, first: messages.length, notes: notes.length }] });
        break;
      case 'branch':
        open.at(-1)!.arms.push({ label: e.label, first: messages.length, notes: notes.length });
        break;
      case 'close': close(); break;
    }
  }
  // A walk stopped at a cap leaves fragments open.
  while (open.length) close();
  // Actor, then the repo's lifelines, then external systems, each in first-appearance order.
  const rank = (p: SequenceParticipant) => p.kind === 'actor' ? 0 : p.kind === 'external' ? 2 : 1;
  participants.sort((a, b) => rank(a) - rank(b) || a.column - b.column).forEach((p, i) => { p.column = i; });
  // Fragments in opening order (outer before inner); a parent that was dropped hands its children to its own parent.
  fragments.sort((a, b) => a.order - b.order);
  const ids = new Map(fragments.map((f, i) => [f.order, `f${i}`]));
  const result: SequenceFragment[] = fragments.map(({ order, parentOrder, ...f }) => {
    let p = parentOrder;
    while (p !== null && !ids.has(p)) p = parentOf.get(p) ?? null;
    return { ...f, id: ids.get(order)!, parent: p === null ? null : ids.get(p)! };
  });
  const kept: Map<number, KeptFragment> = new Map(fragments.map(f => [f.order, { id: ids.get(f.order)!, arms: keptArms.get(f.order)! }]));
  notes.forEach((n, i) => {
    const at = within[i].find(w => kept.has(w.order));
    if (at) Object.assign(n, { fragment: kept.get(at.order)!.id, arm: kept.get(at.order)!.arms[at.arm] });
  });
  // The same error twice in a row at one place (a guard raise and the final raise of a handler) reads as one note.
  const distinct = notes.filter((n, i) => {
    const p = notes[i - 1];
    return !p || p.participant !== n.participant || p.after !== n.after || p.text !== n.text || p.fragment !== n.fragment || p.arm !== n.arm;
  }).map((n, i) => ({ ...n, id: `n${i}` }));
  return { sequence: { participants, messages, fragments: result, notes: distinct }, truncated };
}
