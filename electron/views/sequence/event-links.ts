// `events` link set: `emit/publish/send/send_task/enqueue('name', …)` with a literal name -> the handlers registered for that
// name (`on('name', handler)`, `subscribe('name', handler)`, `@bus.on('name')`, `@app.task(name='name')`, a Celery task
// whose function is named like the last segment), and `task.delay/apply_async(…)` / `queue.enqueue(fn, …)` -> that task.
// Registrations are found by text patterns over the followable files (literal names only), so hops are `certain: false`;
// calls that resolve into the repo (an own `publish` method) stay plain calls.
import path from 'node:path';
import type { GraphSymbol } from '../rules/types';
import { FUNCTION_KINDS } from '../flowchart';
import { symbolNamed, type Hop, type LinkContext, type LinkProvider } from './links';

const EMIT = new Set(['emit', 'publish', 'send', 'send_task', 'delay', 'apply_async', 'enqueue']);
const DECORATORS = new Set(['task', 'shared_task', 'on', 'subscribe', 'subscriber', 'listener', 'on_event', 'event_handler', 'consumer', 'receiver']);
const TASKS = new Set(['task', 'shared_task']);
const SOURCES = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

/** A handler registered for an event/topic/task name; `task`: a task function named after itself (no explicit name). */
interface Registration { name: string; handler: string; file: string; line: number; task: boolean }

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

function registrations(file: string, text: string): Registration[] {
  const out: Registration[] = [];
  // Python decorators (`@app.task(name="x")`, `@bus.on("x")`, bare `@shared_task`) right above a def.
  for (const m of text.matchAll(/^[ \t]*@([\w.]+)(?:\(([^)]*)\))?[ \t]*\r?\n(?:[ \t]*@[^\n]*\n)*[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)/gm)) {
    const decorator = m[1].split('.').at(-1)!, args = m[2] ?? '', fn = m[3];
    if (!DECORATORS.has(decorator)) continue;
    const literal = /^\s*['"]([^'"]+)['"]/.exec(args)?.[1] ?? /\bname\s*=\s*['"]([^'"]+)['"]/.exec(args)?.[1];
    const line = lineAt(text, m.index + m[0].length);
    if (literal) out.push({ name: literal, handler: fn, file, line, task: false });
    else if (TASKS.has(decorator)) out.push({ name: fn, handler: fn, file, line, task: true });
  }
  // `emitter.on('x', handler)`, `bus.subscribe("x", module.handler)`.
  for (const m of text.matchAll(/\.(?:on|once|subscribe|addListener|add_listener|add_event_handler|consume)\(\s*(['"`])([^'"`\n]+)\1\s*,\s*([\w$.]+)\s*[,)]/g)) {
    out.push({ name: m[2], handler: m[3].split('.').at(-1)!, file, line: lineAt(text, m.index), task: false });
  }
  return out;
}

async function registry(ctx: LinkContext): Promise<Registration[]> {
  const key = 'events:registry';
  if (!ctx.memo.has(key)) ctx.memo.set(key, (async () => {
    const { files } = await ctx.files.list(f => SOURCES.has(path.posix.extname(f)) && ctx.followable(f));
    const out: Registration[] = [];
    for (const file of files) {
      const text = await ctx.files.read(file);
      if (text) out.push(...registrations(file, text));
    }
    return out;
  })());
  return ctx.memo.get(key) as Promise<Registration[]>;
}

/** The function a registration names: the one of that name in its file closest to the registration, else by import. */
async function handlerOf(r: Registration, ctx: LinkContext): Promise<GraphSymbol | null> {
  const local = ctx.graph.findSymbols(r.handler, r.file).filter(s => FUNCTION_KINDS.has(s.kind)).sort((a, b) => Math.abs(a.line - r.line) - Math.abs(b.line - r.line));
  return local[0] ?? await symbolNamed(r.handler, r.file, ctx);
}

export const eventLinks: LinkProvider = {
  name: 'events',
  async hops(fn, call, ctx) {
    if (!call || !EMIT.has(call.callee) || ctx.resolve(call)) return [];
    const args = new RegExp(`\\b${call.callee}\\s*\\(\\s*(?:(['"\`])([^'"\`\\n]+)\\1|([A-Za-z_$][\\w$.]*)\\s*[,)])`).exec(ctx.statement);
    const literal = args?.[2], receiver = call.path.slice(0, -(call.callee.length + 1)).split('.').at(-1) ?? '';
    let label: string, found: Registration[];
    if (call.callee === 'delay' || call.callee === 'apply_async') {
      label = receiver;
      found = (await registry(ctx)).filter(r => r.task && r.handler === receiver);
    } else if (literal !== undefined) {
      label = literal;
      const last = literal.split('.').at(-1);
      found = (await registry(ctx)).filter(r => r.task ? call.callee === 'send_task' && r.name === last : r.name === literal);
    } else if (call.callee === 'enqueue' && args?.[3]) {
      // RQ: `queue.enqueue(count_words, url)`.
      const to = await symbolNamed(args[3].split('.').at(-1)!, fn.file, ctx);
      return to ? [{ to, kind: 'link', label: to.name, link: 'events', certain: false }] : [];
    } else return [];
    const hops: Hop[] = [];
    for (const r of found) {
      const to = await handlerOf(r, ctx);
      if (to && !hops.some(h => h.to.id === to.id)) hops.push({ to, kind: 'link', label, link: 'events', certain: false });
    }
    return hops;
  },
};
