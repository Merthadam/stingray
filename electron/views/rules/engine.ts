// Rule engine: runs a resolved view's tree-sitter rules over the scoped files, merges the emitted nodes/edges/fields/groups,
// adds the optional graph step and reports per-rule diagnostics. Pure: files and the code graph come in through interfaces,
// repository code is only parsed, never executed.
import path from 'node:path';
import { Language, Parser, Query, type Node, type QueryMatch } from 'web-tree-sitter';
import type { DiagramEdge, DiagramField, DiagramGroup, DiagramNode, FlowchartDiagnostic, GraphStepDiagnostic, LayersDiagnostic, RuleDiagnostic, SequenceData, SequenceDiagnostic, SourceRef, SymbolRef, UnresolvedLink, ViewWarning } from '../../../shared/contracts/views';
import { GRAMMAR_FILES, initTreeSitter } from './grammars';
import { LangGraphRouters } from '../sets/langgraph-routers';
import { explanationOf, symbolRef } from '../explanation';
import { runGraphStep } from './graph-steps';
import { runFlowchart } from '../flowchart';
import { runSequence } from '../sequence';
import { runLayers } from './layers';
import { inScope } from './schema';
import { renderTemplate, templateCaptures } from './template';
import type { Emit, Evaluate, EvaluateInput, GraphApi, RunGraphStep, SourcedRule } from './types';

export const LIMITS = {
  files: 5000, fileBytes: 1024 * 1024, matchesPerRule: 5000, matchesPerView: 20000, nodes: 2000, edges: 5000,
  queryMsPerFile: 200, totalMs: 20000, warningsPerRule: 20, unresolved: 50,
};
const IMPLICIT = ['file', 'line', 'function', 'class', 'stem'];

const languages = new Map<string, Promise<Language>>();
/** One Language per grammar file for the process lifetime (loading compiles the wasm). */
function loadLanguage(file: string): Promise<Language> {
  let lang = languages.get(file);
  if (!lang) {
    lang = initTreeSitter().then(() => Language.load(file));
    lang.catch(() => languages.delete(file));
    languages.set(file, lang);
  }
  return lang;
}

interface NodeAcc {
  id: string; label: string | null; kind: string | null; subtitle: string | null; group: string | null;
  role: 'start' | 'end' | null; order: number | null; detail: string | null; source: SourceRef | null;
  symbolName: string | null; symbol: SymbolRef | null; fields: DiagramField[]; aliases: Set<string>; explanation?: string | null;
}
interface PendingEdge {
  rule: string; from: string; to: string; kind: string; label: string | null; certain: boolean; style: 'solid' | 'dashed';
  create: 'none' | 'from' | 'to' | 'both'; source: SourceRef;
}
interface PendingField { rule: string; node: string; field: DiagramField }
interface Compiled { sourced: SourcedRule; name: string; query: Query; diag: RuleDiagnostic; done: boolean }

const ruleName = (r: SourcedRule) => `${r.source}#${r.rule.id}`;

/** All templates of an emit, for capture validation and the cartesian product of quantified captures. */
function emitTemplates(emit: Emit): string[] {
  const values = Object.values('node' in emit ? emit.node : 'edge' in emit ? emit.edge : 'field' in emit ? emit.field : emit.group);
  return values.flatMap(v => typeof v === 'string' ? [v] : Array.isArray(v) ? v : []);
}

/** Location of a query compile error inside the YAML file (queryLine is where the query text starts). */
function queryError(r: SourcedRule, error: Error & { index?: number }): ViewWarning {
  const before = typeof error.index === 'number' ? r.rule.query.slice(0, error.index) : '';
  const rows = before.split('\n');
  const where = typeof error.index === 'number' ? ` (query line ${rows.length}, column ${rows.at(-1)!.length + 1})` : '';
  return { file: r.file, line: r.queryLine === null ? r.line : r.queryLine + rows.length - 1, message: `Query error: ${error.message}${where}` };
}

const FUNCTION_PARENTS = new Set(['variable_declarator', 'public_field_definition', 'field_definition', 'pair', 'assignment', 'assignment_expression']);
/** Name of a definition node when it is a function/method or class (per the generic tree-sitter naming conventions). */
function definitionName(node: Node, want: 'function' | 'class'): string | null {
  const type = node.type;
  if (type.includes('call') || type.endsWith('_body')) return null;
  const isFunction = type.includes('function') || type.includes('method') || type === 'arrow_function' || type === 'lambda';
  if (want === 'function' ? !isFunction : !type.includes('class') || isFunction) return null;
  const name = node.childForFieldName('name');
  if (name) return name.text;
  // Anonymous functions take the name they are assigned to: `const f = () => ...`, `{ f: function () {} }`.
  const parent = node.parent;
  if (want === 'function' && parent && FUNCTION_PARENTS.has(parent.type)) {
    const target = parent.childForFieldName('name') ?? parent.childForFieldName('key') ?? parent.childForFieldName('left');
    if (target) return target.text;
  }
  return null;
}
function enclosing(node: Node | null): { function: string; class: string } {
  let fn: string | null = null, cls: string | null = null;
  for (let n = node; n && (fn === null || cls === null); n = n.parent) {
    fn ??= definitionName(n, 'function');
    cls ??= definitionName(n, 'class');
  }
  return { function: fn ?? '', class: cls ?? '' };
}

export function createEvaluate(deps: { runGraphStep: RunGraphStep }): Evaluate {
  return async function evaluate(input: EvaluateInput) {
    const started = performance.now(), deadline = started + LIMITS.totalMs;
    const { view, files, graph, signal } = input;
    const warnings: ViewWarning[] = [], unresolved: UnresolvedLink[] = [];
    let truncated = false, totalMatches = 0, filesScanned = 0, stopped = false;
    const stop = (message: string) => { if (!stopped) warnings.push({ file: null, line: null, message }); stopped = truncated = true; };

    const nodes = new Map<string, NodeAcc>(), aliases = new Map<string, string>(), groups = new Map<string, DiagramGroup>();
    const edges: PendingEdge[] = [], fields: PendingField[] = [];
    const routers = view.rules.some(r => r.source === 'builtin/langgraph') ? new LangGraphRouters(() => {
      if (signal?.aborted || stopped) throw new Error('LangGraph router evaluation aborted');
      if (performance.now() > deadline) throw new Error('LangGraph router evaluation time limit');
    }, LIMITS.matchesPerView) : null;

    // ---- compile rules ----
    const compiled: Compiled[] = [];
    const byLanguage = new Map<string, { lang: Language; rules: Compiled[] }>();
    for (const sourced of view.rules) {
      const { rule } = sourced;
      const diag: RuleDiagnostic = { rule: ruleName(sourced), language: rule.language, filesScanned: 0, matches: 0, emitted: 0, skipped: 0, errors: [], warnings: [], ms: 0 };
      const fail = (message: string, line = sourced.line) => { diag.errors.push({ file: sourced.file, line, message }); };
      const grammar = GRAMMAR_FILES[rule.language];
      let lang: Language | null = null;
      if (!grammar) fail(`Unknown language "${rule.language}"`);
      else try { lang = await loadLanguage(path.join(input.grammarDir, grammar)); } catch (e) { fail(`Grammar for ${rule.language} could not be loaded: ${(e as Error).message}`); }
      let query: Query | null = null;
      if (lang) try { query = new Query(lang, rule.query); } catch (e) { diag.errors.push(queryError(sourced, e as Error)); }
      if (query) {
        const names = query.captureNames;
        const unknown = [...new Set(emitTemplates(rule.emit).flatMap(templateCaptures))].filter(c => !IMPLICIT.includes(c) && !names.includes(c));
        if (unknown.length) { fail(`emit uses captures the query does not define: ${unknown.map(c => '@' + c).join(', ')}`); query.delete(); query = null; }
      }
      const c = { sourced, name: diag.rule, query: query!, diag, done: !query };
      compiled.push(c);
      if (query && lang) {
        const entry = byLanguage.get(rule.language) ?? { lang, rules: [] };
        entry.rules.push(c);
        byLanguage.set(rule.language, entry);
      }
    }

    const ruleWarn = (c: Compiled, w: ViewWarning) => { if (c.diag.warnings.length < LIMITS.warningsPerRule) c.diag.warnings.push(w); };

    // ---- emit ----
    function emitMatch(c: Compiled, match: QueryMatch, file: string) {
      const { emit } = c.sourced.rule;
      const byName = new Map<string, Node[]>();
      for (const cap of match.captures) byName.set(cap.name, [...byName.get(cap.name) ?? [], cap.node]);
      const first = match.captures.reduce<Node | null>((a, cap) => !a || cap.node.startIndex < a.startIndex ? cap.node : a, null);
      const line = (first?.startPosition.row ?? 0) + 1;
      const defs = enclosing(first);
      const within = c.sourced.rule.within;
      if (within?.function !== undefined && !path.posix.matchesGlob(defs.function, within.function)) return;
      if (within?.class !== undefined && !path.posix.matchesGlob(defs.class, within.class)) return;
      const base = new Map<string, string>([['file', file], ['line', String(line)], ['function', defs.function], ['class', defs.class],
        ['stem', path.posix.basename(file).replace(/\.[^.]*$/, '')]]);
      // Quantified captures emit once per node: cartesian product over the captures this emit uses.
      let combos: Map<string, string>[] = [base];
      for (const name of new Set(emitTemplates(emit).flatMap(templateCaptures))) {
        const nodesOf = byName.get(name);
        if (!nodesOf) continue;
        combos = combos.flatMap(values => nodesOf.map(n => new Map(values).set(name, n.text)));
        if (combos.length > LIMITS.matchesPerRule) combos.length = LIMITS.matchesPerRule;
      }
      const source = { file, line };
      for (const values of combos) {
        if (emitOne(c, emit, values, source)) c.diag.emitted++;
        else c.diag.skipped++;
      }
    }

    function emitOne(c: Compiled, emit: Emit, values: Map<string, string>, source: SourceRef): boolean {
      const req = (t: string) => { const v = renderTemplate(t, values); return v ? v : null; };
      const opt = (t: string | undefined) => t === undefined ? null : renderTemplate(t, values) || null;
      const list = (ts: string[] | undefined) => (ts ?? []).map(t => renderTemplate(t, values)).filter((v): v is string => !!v);
      const warn = (message: string) => ruleWarn(c, { file: source.file, line: source.line, message });
      if ('node' in emit) {
        const e = emit.node, id = req(e.id);
        if (id === null) return false;
        const role = opt(e.role), orderText = opt(e.order);
        if (role !== null && role !== 'start' && role !== 'end') warn(`role must be "start" or "end", got "${role}"`);
        const order = orderText === null ? null : Number(orderText);
        if (order !== null && !Number.isFinite(order)) warn(`order must be a number, got "${orderText}"`);
        let n = nodes.get(id);
        if (!n) nodes.set(id, n = { id, label: null, kind: null, subtitle: null, group: null, role: null, order: null, detail: null, source, symbolName: null, symbol: null, fields: [], aliases: new Set() });
        n.label ??= opt(e.label); n.kind ??= opt(e.kind); n.subtitle ??= opt(e.subtitle); n.group ??= opt(e.group);
        n.role ??= role === 'start' || role === 'end' ? role : null;
        n.order ??= order !== null && Number.isFinite(order) ? order : null;
        n.detail ??= opt(e.detail); n.symbolName ??= opt(e.symbol);
        for (const a of list(e.aliases)) { n.aliases.add(a); if (!aliases.has(a)) aliases.set(a, id); }
        return true;
      }
      if ('edge' in emit) {
        const e = emit.edge, from = req(e.from), to = req(e.to);
        if (from === null || to === null) return false;
        const certain = e.certain ?? true;
        edges.push({ rule: c.name, from, to, kind: opt(e.kind) ?? 'edge', label: opt(e.label), certain, style: certain ? e.style ?? 'solid' : 'dashed', create: e.create ?? 'none', source });
        return true;
      }
      if ('field' in emit) {
        const e = emit.field, node = req(e.node), id = req(e.id);
        if (node === null || id === null) return false;
        fields.push({ rule: c.name, node, field: { id, label: opt(e.label) ?? id, type: opt(e.type), badges: list(e.badges), detail: opt(e.detail), source } });
        return true;
      }
      const id = req(emit.group.id);
      if (id === null) return false;
      if (!groups.has(id)) groups.set(id, { id, label: opt(emit.group.label) ?? id, source });
      return true;
    }

    // ---- scan files ----
    const listed = await files.list(f => inScope(f, view.scope));
    if (listed.truncated) { truncated = true; warnings.push({ file: null, line: null, message: `More than ${LIMITS.files} files in scope (or too many files to list); only the first were scanned — narrow the scope` }); }
    const scoped = listed.files.filter(f => inScope(f, view.scope)).slice(0, LIMITS.files);
    const parsers = new Map<string, Parser>();
    for (const file of byLanguage.size ? scoped : []) {
      if (stopped) break;
      if (signal?.aborted) { stop('Evaluation aborted'); break; }
      if (performance.now() > deadline) { stop(`Evaluation stopped after ${LIMITS.totalMs / 1000} s; the diagram is incomplete`); break; }
      const wanted = [...byLanguage].map(([language, { lang, rules }]) =>
        ({ language, lang, rules: rules.filter(c => !c.done && (!c.sourced.rule.files || inScope(file, { include: c.sourced.rule.files, exclude: [] }))) }))
        .filter(w => w.rules.length);
      if (!wanted.length) continue;
      const text = await files.read(file);
      if (text === null || text.length > LIMITS.fileBytes) {
        warnings.push({ file, line: null, message: 'File skipped: unreadable or larger than 1 MiB' });
        continue;
      }
      filesScanned++;
      for (const { language, lang, rules } of wanted) {
        let parser = parsers.get(language);
        if (!parser) { parser = new Parser(); parser.setLanguage(lang); parsers.set(language, parser); }
        const tree = parser.parse(text);
        if (!tree) continue;
        try {
          for (const c of rules) {
            if (stopped) break;
            const t0 = performance.now(), fileDeadline = Math.min(t0 + LIMITS.queryMsPerFile, deadline);
            c.diag.filesScanned++;
            let timedOut = false;
            // Returning true cancels the query (web-tree-sitter 0.25 checks the callback's result).
            const matches = c.query.matches(tree.rootNode, { progressCallback: () => (timedOut = performance.now() > fileDeadline || !!signal?.aborted) });
            if (timedOut) ruleWarn(c, { file, line: null, message: `Query stopped after ${LIMITS.queryMsPerFile} ms on this file` });
            for (const match of matches) {
              if (c.diag.matches >= LIMITS.matchesPerRule) {
                c.done = truncated = true;
                ruleWarn(c, { file: null, line: null, message: `Match cap hit (${LIMITS.matchesPerRule}); later matches ignored` });
                break;
              }
              if (totalMatches >= LIMITS.matchesPerView) { stop(`Match cap hit (${LIMITS.matchesPerView} per view); the diagram is incomplete`); break; }
              c.diag.matches++; totalMatches++;
              emitMatch(c, match, file);
            }
            c.diag.ms += performance.now() - t0;
          }
          if (routers && language === 'python' && !stopped) {
            try { routers.collect(file, tree.rootNode); }
            catch (e) { stop((e as Error).message); }
          }
        } finally { tree.delete(); }
      }
    }
    parsers.forEach(p => p.delete());
    for (const c of compiled) {
      if (c.query) c.query.delete();
      if (c.query && !c.diag.matches && !c.diag.errors.length) c.diag.warnings.unshift({ file: c.sourced.file, line: c.sourced.line, message: 'Rule matched nothing' });
      c.diag.ms = Math.round(c.diag.ms);
    }

    // Enrich before joins: inferred return targets get the same scope, unresolved-link and output limits as rule edges.
    if (routers && !stopped) try {
      for (const call of routers.branches()) {
        for (let i = edges.length - 1; i >= 0; i--) {
          const edge = edges[i];
          if (edge.rule.startsWith('builtin/langgraph#') && edge.kind === 'branch' && edge.from === call.from
            && edge.source.file === call.file && edge.source.line === call.line) edges.splice(i, 1);
        }
        for (const branch of call.branches) {
          if (totalMatches >= LIMITS.matchesPerView) { stop(`Match cap hit (${LIMITS.matchesPerView} per view); the diagram is incomplete`); break; }
          totalMatches++;
          edges.push({ ...branch, from: call.from, rule: 'builtin/langgraph#branch', kind: 'branch', certain: false,
            style: 'dashed', create: 'none', source: { file: call.file, line: call.line } });
        }
      }
    } catch (e) { stop((e as Error).message); }

    // ---- graph step ----
    let graphDiag: GraphStepDiagnostic | null = null;
    const graphEdges: DiagramEdge[] = [];
    if (view.graph) {
      if (!graph) graphDiag = { started: 0, reached: 0, helpers: 0, truncated: false, error: `code graph not ready (${input.graphStatus.state})` };
      else try {
        const out = deps.runGraphStep(view.graph, graph, f => inScope(f, view.scope));
        graphDiag = out.diagnostic;
        if (out.truncated) truncated = true;
        linkSymbols(graph);
        // Rule nodes linked to the same symbol are the same node; the rule node keeps its id and wins per property.
        const bySymbol = new Map([...nodes.values()].filter(n => n.symbol).map(n => [n.symbol!.id, n.id]));
        const ids = new Map<string, string>();
        for (const g of out.nodes) {
          const id = (g.symbol && bySymbol.get(g.symbol.id)) ?? g.id;
          ids.set(g.id, id);
          const n = nodes.get(id);
          if (!n) { nodes.set(id, { ...g, symbolName: null, aliases: new Set(), fields: [...g.fields] }); continue; }
          n.label ??= n.id; n.kind ??= g.kind; n.subtitle ??= g.subtitle; n.group ??= g.group; n.role ??= g.role; n.order ??= g.order; n.detail ??= g.detail;
          n.source ??= g.source; n.symbol ??= g.symbol; n.explanation ??= g.explanation;
          for (const f of g.fields) if (!n.fields.some(x => x.id === f.id)) n.fields.push(f);
        }
        for (const e of out.edges) graphEdges.push({ ...e, from: ids.get(e.from) ?? e.from, to: ids.get(e.to) ?? e.to });
      } catch (e) {
        graphDiag = { started: 0, reached: 0, helpers: 0, truncated: false, error: (e as Error).message };
      }
    }
    // ---- flowchart ----
    /** Parsers for flowchart/sequence function bodies; freed by the caller. */
    const bodyParsers = () => {
      const parsers = new Map<string, Parser>();
      // Same per-file budget as rule queries; returning true cancels the parse (web-tree-sitter 0.25).
      const parseText = async (language: string, text: string) => {
        if (text.length > LIMITS.fileBytes) return null;
        let parser = parsers.get(language);
        if (!parser) {
          const lang = await loadLanguage(path.join(input.grammarDir, GRAMMAR_FILES[language]));
          parser = new Parser(); parser.setLanguage(lang); parsers.set(language, parser);
        }
        const until = Math.min(performance.now() + LIMITS.queryMsPerFile, deadline);
        return parser.parse(text, null, { progressCallback: () => performance.now() > until || !!signal?.aborted });
      };
      return { parseText, dispose: () => parsers.forEach(p => p.delete()) };
    };
    let flowchartDiag: FlowchartDiagnostic | null = null;
    if (view.flowchart) {
      const step = view.flowchart;
      const failed = (error: string): FlowchartDiagnostic => ({ start: null, depth: step.depth, functions: 0, nodes: 0, truncated: false, error });
      if (!graph) flowchartDiag = failed(`code graph not ready (${input.graphStatus.state})`);
      else {
        const { parseText, dispose } = bodyParsers();
        try {
          const out = await runFlowchart(step, graph, files, parseText, f => inScope(f, view.scope));
          flowchartDiag = out.diagnostic;
          warnings.push(...out.warnings);
          if (out.truncated) truncated = true;
          for (const g of out.groups) groups.set(g.id, g);
          for (const n of out.nodes) nodes.set(n.id, { ...n, symbolName: null, aliases: new Set(), fields: [...n.fields] });
          graphEdges.push(...out.edges);
        } catch (e) {
          flowchartDiag = failed((e as Error).message);
        } finally { dispose(); }
      }
    }
    // ---- sequence ----
    let sequenceDiag: SequenceDiagnostic | null = null, sequence: SequenceData | null = null;
    if (view.sequence) {
      const step = view.sequence;
      const failed = (error: string): SequenceDiagnostic => ({ start: null, depth: step.depth, participants: step.participants === 'auto' ? 'file' : step.participants,
        functions: 0, messages: 0, links: {}, truncated: false, error });
      if (!graph) sequenceDiag = failed(`code graph not ready (${input.graphStatus.state})`);
      else {
        const { parseText, dispose } = bodyParsers();
        try {
          // Link rules (schema: rules of a sequence emit only `kind: link` edges) teach the walker extra hops.
          const ruleLinks = edges.filter(e => e.kind === 'link').map(e => ({ rule: e.rule.slice(e.rule.indexOf('#') + 1), from: e.from, to: e.to, label: e.label, certain: e.certain, source: e.source }));
          const out = await runSequence(step, graph, files, parseText, f => inScope(f, view.scope), view.exclude, ruleLinks,
            () => !!signal?.aborted || performance.now() > deadline);
          sequenceDiag = out.diagnostic;
          sequence = out.sequence;
          warnings.push(...out.warnings);
          if (out.truncated) truncated = true;
          for (const n of out.nodes) nodes.set(n.id, { ...n, symbolName: null, aliases: new Set(), fields: [] });
        } catch (e) {
          sequenceDiag = failed((e as Error).message);
        } finally { dispose(); }
      }
      edges.length = 0; // their from/to are symbol names, not nodes: never joined as diagram edges
    }
    // ---- layers ----
    let layersDiag: LayersDiagnostic | null = null;
    if (view.layers) {
      const failed = (error: string): LayersDiagnostic => ({ config: null, depth: view.layers!.depth, services: 0, files: 0, nodes: 0, error });
      if (!graph) layersDiag = failed(`code graph not ready (${input.graphStatus.state})`);
      else try {
        const out = runLayers(view.layers, graph, f => inScope(f, view.scope));
        layersDiag = out.diagnostic;
        warnings.push(...out.warnings);
        for (const g of out.groups) groups.set(g.id, g);
        for (const n of out.nodes) if (!nodes.has(n.id)) nodes.set(n.id, { ...n, symbolName: null, aliases: new Set(), fields: [...n.fields] });
        graphEdges.push(...out.edges);
      } catch (e) { layersDiag = failed((e as Error).message); }
    }
    if (graph) linkSymbols(graph);

    function linkSymbols(g: GraphApi) {
      for (const n of nodes.values()) {
        if (n.symbol || !n.symbolName) continue;
        const local = n.source ? g.findSymbols(n.symbolName, n.source.file) : [];
        const found = local[0] ?? (() => { const all = g.findSymbols(n.symbolName!); return all.length === 1 ? all[0] : undefined; })();
        if (found) { n.symbol = symbolRef(found); Object.assign(n, explanationOf(found)); }
      }
    }

    // ---- joins ----
    const resolve = (key: string) => nodes.has(key) ? key : aliases.get(key) ?? null;
    const missing = (rule: string, value: string, source: SourceRef) => {
      if (unresolved.length < LIMITS.unresolved) unresolved.push({ rule, value, file: source.file, line: source.line });
    };
    const placeholder = (value: string, source: SourceRef) => {
      nodes.set(value, { id: value, label: value, kind: 'placeholder', subtitle: null, group: null, role: null, order: null, detail: null, source, symbolName: null, symbol: null, fields: [], aliases: new Set() });
      return value;
    };
    const edgeList: DiagramEdge[] = [], edgeIds = new Map<string, DiagramEdge[]>();
    const addEdge = (e: DiagramEdge) => {
      const base = `${e.kind}:${e.from}->${e.to}`, same = edgeIds.get(base) ?? [];
      if (same.some(x => x.label === e.label && x.certain === e.certain && x.style === e.style)) return;
      edgeIds.set(base, [...same, e]);
      edgeList.push({ ...e, id: same.length ? `${base}#${same.length + 1}` : base });
    };
    for (const e of edges) {
      let from = resolve(e.from), to = resolve(e.to);
      if (from === null && (e.create === 'from' || e.create === 'both')) from = placeholder(e.from, e.source);
      if (to === null && (e.create === 'to' || e.create === 'both')) to = placeholder(e.to, e.source);
      if (from === null) missing(e.rule, e.from, e.source);
      if (to === null) missing(e.rule, e.to, e.source);
      if (from === null || to === null) continue;
      addEdge({ id: '', from, to, fromField: null, toField: null, kind: e.kind, style: e.style, certain: e.certain, label: e.label, source: e.source });
    }
    graphEdges.forEach(e => { if (nodes.has(e.from) && nodes.has(e.to)) addEdge(e); });
    // After edges, so fields can attach to placeholder nodes.
    for (const { rule, node, field } of fields) {
      const id = resolve(node);
      if (id === null) { missing(rule, node, field.source!); continue; }
      const n = nodes.get(id)!;
      if (!n.fields.some(f => f.id === field.id)) n.fields.push(field);
    }

    // ---- finalize ----
    for (const n of nodes.values()) if (n.group && !groups.has(n.group)) groups.set(n.group, { id: n.group, label: n.group, source: null });
    const include = new Set(view.include), exclude = new Set(view.exclude);
    let finalNodes: DiagramNode[] = [...nodes.values()].map(n => ({
      id: n.id, label: n.label ?? n.id, kind: n.kind ?? 'node', subtitle: n.subtitle, group: n.group, fields: n.fields,
      source: n.source, symbol: n.symbol, role: n.role, order: n.order, detail: n.detail, ...(n.explanation ? { explanation: n.explanation } : {}), ...(n.aliases.size ? { aliases: [...n.aliases] } : {}),
    })).filter(n => !exclude.has(n.id) && !exclude.has(n.label));
    if (finalNodes.length > LIMITS.nodes) {
      const kept = (n: DiagramNode) => include.has(n.id) || include.has(n.label);
      finalNodes = [...finalNodes.filter(kept), ...finalNodes.filter(n => !kept(n))].slice(0, LIMITS.nodes);
      truncated = true;
      warnings.push({ file: null, line: null, message: `More than ${LIMITS.nodes} nodes; the rest were dropped` });
    }
    const kept = new Set(finalNodes.map(n => n.id));
    let finalEdges = edgeList.filter(e => kept.has(e.from) && kept.has(e.to));
    if (finalEdges.length > LIMITS.edges) {
      finalEdges = finalEdges.slice(0, LIMITS.edges);
      truncated = true;
      warnings.push({ file: null, line: null, message: `More than ${LIMITS.edges} edges; the rest were dropped` });
    }
    const ms = Math.round(performance.now() - started);
    return {
      groups: [...groups.values()], nodes: finalNodes, edges: finalEdges, warnings, truncated,
      diagnostics: { rules: compiled.map(c => c.diag), graph: graphDiag, ...(flowchartDiag ? { flowchart: flowchartDiag } : {}), ...(layersDiag ? { layers: layersDiag } : {}),
        ...(sequenceDiag ? { sequence: sequenceDiag } : {}), unresolved, limits: { filesScanned, matches: totalMatches, truncated }, ms },
      stats: { filesScanned, matches: totalMatches, nodes: finalNodes.length, edges: finalEdges.length, ...(sequence ? { messages: sequence.messages.length } : {}) },
      ...(view.sequence ? { sequence } : {}),
    };
  };
}

export const evaluate: Evaluate = createEvaluate({ runGraphStep });
