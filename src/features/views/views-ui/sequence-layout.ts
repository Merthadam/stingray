// Geometry of a sequence diagram (SequenceDiagram.tsx): lifeline columns, one row per message, activation bars, fragment
// frames, notes. Pure and deterministic; text is measured by character count (an average sans glyph, on the wide side),
// so no DOM is needed. Message, fragment and note text wraps to 2 lines (rows grow); the full text is on hover.
// Body coordinates start at 0 under the (separately drawn, sticky) participant header.
import type { SequenceData, SequenceFragment, SequenceMessage, SequenceNote, SequenceParticipant } from '../../../../shared/contracts/views';
import { sequenceEvents } from '../../../../shared/views/sequence-events';

export const SEQ = {
  headerHeight: 66,   // participant boxes / actor figures
  explanationHeight: 30, // participant explanations, 2 lines under the boxes (only when one has an explanation)
  line: 14,           // each extra line of a wrapped label
  top: 18, bottom: 30, side: 20,
  row: 38,            // message: label above, arrow at ARROW_Y
  arrowY: 27,
  selfRow: 48,        // self message: label beside a loop
  selfWidth: 30, selfDrop: 16,
  noteHeight: 26, noteGap: 10, noteMax: 300,
  fragmentHead: 30, branchHead: 28, fragmentFoot: 12, fragmentPad: 16, nestPad: 10,
  barWidth: 10, barNest: 5, minBar: 16,
  minGap: 36, labelPad: 18,
  charWidth: 6.6,     // 11px sans (message labels, notes, fragment labels)
  headerChar: 7.4,    // 12px participant labels, semibold
  subtitleChar: 6.1,  // 10px participant subtitles and explanations
  minBox: 104, maxBox: 230, boxPad: 30,
  maxLabel: 56,       // characters per line of a wrapped label
};
export const UNCERTAIN = ' (uncertain)';

export interface LaidParticipant { participant: SequenceParticipant; x: number; width: number; label: string; subtitle: string | null;
  explanation: string[] } // x = lifeline; explanation: up to 2 wrapped lines under the box
export interface LaidMessage {
  message: SequenceMessage; row: number;
  y: number;                   // arrow
  x1: number; x2: number;      // arrow from / to (self: the loop starts and ends at x1)
  lines: string[];             // the label wrapped to 2 lines (none when blank); the renderer appends UNCERTAIN when !certain
  labelX: number;              // label anchor: middle of the arrow, or the start of a self message's label
  top: number; bottom: number; // hover band
}
export interface LaidActivation { participant: string; x: number; y: number; height: number }
export interface LaidFragment { fragment: SequenceFragment; x: number; y: number; width: number; height: number; depth: number;
  lines: string[]; branches: { label: string; lines: string[]; y: number }[] } // lines: `[label]` wrapped
export interface LaidNote { note: SequenceNote; x: number; y: number; width: number; height: number; lines: string[] }
export interface SequenceLayout {
  width: number; height: number; // body (under the header)
  headerHeight: number;
  participants: LaidParticipant[]; messages: LaidMessage[]; activations: LaidActivation[]; fragments: LaidFragment[]; notes: LaidNote[];
}

export const textWidth = (text: string, char = SEQ.charWidth) => Math.ceil(text.length * char);
export const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
/** Keeps the end (a file path's name). */
const clipStart = (text: string, max: number) => text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
/** `text` word-wrapped at `max` characters, at most `maxLines` lines (the last one ends in … when cut; a word longer than a
 * line breaks); [] for blank text. */
export function wrapLines(text: string, max: number, maxLines = 2): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let w = word; w;) {
      if (line && line.length + 1 + w.length > max) { lines.push(line); line = ''; continue; }
      const part = w.slice(0, max - (line ? line.length + 1 : 0));
      line = line ? `${line} ${part}` : part; w = w.slice(part.length);
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = clip(`${kept[maxLines - 1]} ${lines[maxLines]}`, max);
  return kept;
}
const widest = (lines: string[], char = SEQ.charWidth) => Math.max(0, ...lines.map(l => textWidth(l, char)));
const messageLines = (m: SequenceMessage) => wrapLines(m.label, SEQ.maxLabel);
const labelWidth = (m: SequenceMessage) => {
  const lines = messageLines(m);
  return m.certain ? widest(lines) : Math.max(widest(lines.slice(0, -1)), textWidth((lines.at(-1) ?? '') + UNCERTAIN));
};
const extra = (lines: string[]) => Math.max(0, lines.length - 1) * SEQ.line; // height of a label's lines after the first
const noteLines = (n: SequenceNote) => wrapLines(n.text, Math.floor((SEQ.noteMax - 20) / SEQ.charWidth));
const noteWidth = (n: SequenceNote) => Math.min(SEQ.noteMax, widest(noteLines(n)) + 20);
const fragmentLines = (label: string) => wrapLines(`[${label}]`, SEQ.maxLabel);
export const tabWidth = (kind: string) => textWidth(kind) + 18;

export function sequenceLayout(data: SequenceData): SequenceLayout {
  const S = SEQ, events = sequenceEvents(data);
  const columns = [...data.participants].sort((a, b) => a.column - b.column);
  const col = new Map(columns.map((p, i) => [p.id, i]));
  const actors = new Set(columns.filter(p => p.kind === 'actor').map(p => p.id));
  const n = columns.length;
  const boxChars = Math.floor((S.maxBox - S.boxPad) / S.headerChar), subtitleChars = Math.floor((S.maxBox - S.boxPad) / S.subtitleChar);
  const width = columns.map(p => Math.min(S.maxBox, Math.max(S.minBox, textWidth(p.label, S.headerChar) + S.boxPad,
    textWidth(p.subtitle ?? '', S.subtitleChar) + S.boxPad)));

  // Columns: each lifeline as far right as its box, the labels of the arrows ending at it and the notes around it need.
  const half = width.map(w => w / 2);
  const need: { a: number; b: number; dist: number }[] = [];
  for (const m of data.messages) {
    const a = col.get(m.from), b = col.get(m.to);
    if (a === undefined || b === undefined) continue;
    if (a !== b) need.push({ a: Math.min(a, b), b: Math.max(a, b), dist: labelWidth(m) + 2 * S.labelPad + S.barWidth });
    else if (a + 1 < n) need.push({ a, b: a + 1, dist: S.selfWidth + 8 + labelWidth(m) + S.labelPad + half[a + 1] });
  }
  for (const note of data.notes) {
    const c = col.get(note.participant), w = noteWidth(note) / 2;
    if (c === undefined) continue;
    half[c] = Math.max(half[c], w);
    if (c + 1 < n) need.push({ a: c, b: c + 1, dist: w + half[c + 1] + S.minGap / 2 });
  }
  const maxDepth = events.reduce((d, e) => e.type === 'open' ? Math.max(d, e.depth + 1) : d, 0);
  const x: number[] = [];
  for (let i = 0; i < n; i++) {
    x[i] = i === 0 ? S.side + S.fragmentPad + maxDepth * S.nestPad + half[0]
      : Math.max(x[i - 1] + half[i - 1] + half[i] + S.minGap, ...need.filter(c => c.b === i).map(c => x[c.a] + c.dist));
  }
  const center = (id: string) => x[col.get(id) ?? -1] ?? x[0] ?? 0;

  // Rows, activations and fragments in reading order.
  type Bar = { participant: string; level: number; start: number; nest: number };
  type Open = { fragment: SequenceFragment; y: number; depth: number; min: number; max: number; lines: string[]; branches: LaidFragment['branches'] };
  const messages: LaidMessage[] = [], activations: LaidActivation[] = [], fragments: LaidFragment[] = [], notes: LaidNote[] = [];
  const stack: Bar[] = [], open: Open[] = [];
  let y = S.top, lastArrow = S.top;
  const barX = (b: Bar) => center(b.participant) + b.nest * S.barNest;
  const end = (at: number) => {
    const b = stack.pop()!;
    activations.push({ participant: b.participant, x: barX(b) - S.barWidth / 2, y: b.start - 4, height: Math.max(S.minBar, at - b.start + 8) });
  };
  const push = (participant: string, level: number, start: number) =>
    stack.push({ participant, level, start, nest: stack.filter(b => b.participant === participant).length });
  const bar = (participant: string) => [...stack].reverse().find(b => b.participant === participant);
  // The side of `participant`'s innermost bar facing `toward`.
  const edge = (participant: string, toward: number) => {
    const b = bar(participant), c = b ? barX(b) : center(participant);
    return c + (b ? Math.sign(toward - c) * S.barWidth / 2 : 0);
  };
  const reach = (min: number, max: number) => { for (const f of open) { f.min = Math.min(f.min, min); f.max = Math.max(f.max, max); } };

  for (const e of events) {
    if (e.type === 'open') {
      const lines = e.fragment.label && e.fragment.label !== e.fragment.kind ? fragmentLines(e.fragment.label) : [];
      open.push({ fragment: e.fragment, y, depth: e.depth, min: Infinity, max: -Infinity, lines, branches: [] });
      y += S.fragmentHead + extra(lines);
    } else if (e.type === 'branch') {
      const lines = fragmentLines(e.label);
      [...open].reverse().find(f => f.fragment === e.fragment)?.branches.push({ label: e.label, lines, y: y + 2 });
      y += S.branchHead + extra(lines);
    } else if (e.type === 'note') {
      const lines = noteLines(e.note), w = noteWidth(e.note), c = center(e.note.participant), h = S.noteHeight + extra(lines);
      notes.push({ note: e.note, x: c - w / 2, y: y + 2, width: w, height: h, lines });
      reach(c - w / 2, c + w / 2);
      y += h + S.noteGap;
    } else if (e.type === 'close') {
      const f = open.pop()!;
      if (f.min > f.max) { f.min = x[0] ?? S.side; f.max = f.min; }
      const left = f.min - S.fragmentPad;
      const labels = Math.max(tabWidth(f.fragment.kind) + widest(f.lines) + 16, ...f.branches.map(b => widest(b.lines) + 16));
      const right = Math.max(f.max + S.fragmentPad, left + labels);
      fragments.push({ fragment: f.fragment, x: left, y: f.y + 2, width: right - left, height: y + 4 - f.y, depth: f.depth, lines: f.lines, branches: f.branches });
      for (const parent of open) { parent.min = Math.min(parent.min, left - S.nestPad + S.fragmentPad); parent.max = Math.max(parent.max, right + S.nestPad - S.fragmentPad); }
      y += S.fragmentFoot;
    } else {
      const m = e.message, L = m.level, self = m.from === m.to || m.kind === 'self', lines = messageLines(m);
      // A wrapped label pushes the arrow down (it sits under the label); a self message's label sits beside its loop.
      const arrow = y + (self ? 12 : S.arrowY + extra(lines)), height = self ? S.selfRow : S.row + extra(lines);
      let x1: number, x2: number;
      // A self message loops from the caller's bar out to the right and back into the callee's (nested) bar.
      const from = self ? Infinity : center(m.to), to = self ? Infinity : center(m.from);
      if (m.kind === 'return') {
        while (stack.length && stack[stack.length - 1].level > L + 1) end(lastArrow); // the callee's own calls ended before
        x1 = edge(m.from, from);
        while (stack.length && stack[stack.length - 1].level > L) end(arrow);
        x2 = edge(m.to, to);
      } else {
        while (stack.length && stack[stack.length - 1].level > L) end(lastArrow);
        if (stack[stack.length - 1]?.participant !== m.from) push(m.from, L, arrow);
        x1 = edge(m.from, from);
        // The trigger enters the entry function, whose own calls have the trigger's level (0) too.
        push(m.to, actors.has(m.from) ? L : L + 1, arrow + (self ? S.selfDrop : 0));
        x2 = edge(m.to, to);
      }
      const labelX = self ? x1 + S.selfWidth + 8 : (x1 + x2) / 2;
      messages.push({ message: m, row: e.row, y: arrow, x1, x2, lines, labelX, top: y, bottom: y + height });
      reach(Math.min(x1, x2) - S.barWidth, self ? labelX + labelWidth(m) : Math.max(x1, x2) + S.barWidth);
      lastArrow = self ? arrow + S.selfDrop : arrow;
      y += height;
    }
  }
  while (stack.length) end(Math.max(lastArrow, y - S.row / 2));

  const right = Math.max(n ? x[n - 1] + half[n - 1] : 0, ...fragments.map(f => f.x + f.width), ...notes.map(nt => nt.x + nt.width),
    ...messages.map(m => m.message.from === m.message.to || m.message.kind === 'self' ? m.labelX + labelWidth(m.message) : 0));
  // Room for an explanation: the box, or up to the neighbouring lifelines' midpoints.
  const room = (i: number) => Math.max(width[i], Math.min(i ? x[i] - x[i - 1] : S.maxBox, i < n - 1 ? x[i + 1] - x[i] : S.maxBox) - 16);
  const explained = columns.map((participant, i) => participant.explanation ? wrapLines(participant.explanation, Math.floor(room(i) / S.subtitleChar)) : []);
  return {
    width: Math.ceil(right + S.side), height: Math.ceil(y + S.bottom),
    headerHeight: S.headerHeight + (explained.some(l => l.length) ? S.explanationHeight : 0),
    participants: columns.map((participant, i) => ({ participant, x: x[i], width: width[i], label: clip(participant.label, boxChars),
      subtitle: participant.subtitle === null ? null : clipStart(participant.subtitle, subtitleChars), explanation: explained[i] })),
    messages, activations, fragments, notes,
  };
}

/** A participant can fold into its caller when another (non-actor) participant calls it. */
export const collapsible = (data: SequenceData, id: string) => data.messages.some(m => m.to === id && m.from !== id && m.kind !== 'return'
  && data.participants.find(p => p.id === m.from)?.kind !== 'actor');

/** The diagram with `collapsed` participants folded into their callers' lifelines (spec: "collapse a participant"): the messages
 * they send are drawn from the caller, calls between the two vanish (like `internal: collapse`), notes move with them.
 * Fragments left without a message are dropped; their notes go to the nearest kept enclosing fragment. */
export function collapseParticipants(data: SequenceData, collapsed: ReadonlySet<string>): SequenceData {
  const folding = new Set([...collapsed].filter(id => collapsible(data, id)));
  if (!folding.size) return data;
  const actors = new Set(data.participants.filter(p => p.kind === 'actor').map(p => p.id));
  // Per call level: the lifeline of the function running there and the one it is drawn on.
  const actual: string[] = [], shown: string[] = [];
  const messages: SequenceMessage[] = [], before: number[] = []; // before[row] = messages kept before that row
  const noteOn = new Map<SequenceNote, string | null>();
  const place = (row: number) => data.notes.filter(n => n.after === row).forEach(n => {
    const i = actual.lastIndexOf(n.participant);
    noteOn.set(n, i >= 0 ? shown[i] : folding.has(n.participant) ? null : n.participant);
  });
  place(-1);
  data.messages.forEach((m, row) => {
    before[row] = messages.length;
    const L = m.level;
    let from = m.from, to = m.to;
    if (m.kind === 'return') {
      if (actual[L + 1] === m.from) from = shown[L + 1];
      if (actual[L] === m.to) to = shown[L];
      actual.length = shown.length = L + 1;
    } else if (actors.has(m.from)) {
      actual.length = shown.length = 0; actual[L] = shown[L] = m.to; // the trigger enters the entry, which calls at the same level
    } else {
      if (actual[L] !== m.from) actual[L] = shown[L] = m.from;
      actual.length = shown.length = L + 1;
      from = shown[L];
      actual[L + 1] = m.to; shown[L + 1] = to = folding.has(m.to) ? from : m.to;
    }
    // A call or return between a folded participant and its caller vanishes.
    if (from !== to || (from === m.from && to === m.to)) messages.push({ ...m, id: `m${messages.length}`, from, to, kind: from === to && m.kind !== 'return' ? 'self' : m.kind });
    place(row);
  });
  before[data.messages.length] = messages.length;
  const after = (r: number) => before[Math.min(r + 1, data.messages.length)] - 1;
  const moved = data.fragments.map(f => ({ ...f, first: before[Math.min(f.first, data.messages.length)], last: after(f.last),
    branches: f.branches.map(b => ({ ...b, first: before[Math.min(b.first, data.messages.length)] })) }));
  const fragments = moved.filter(f => f.first <= f.last);
  const kept = new Set(fragments.map(f => f.id)), byId = new Map(moved.map(f => [f.id, f]));
  const notes = data.notes.flatMap(n => {
    const participant = noteOn.get(n);
    if (!participant) return [];
    let fragment = n.fragment ?? null, arm = n.arm;
    if (fragment && !kept.has(fragment)) {
      const at = byId.get(fragment)?.first ?? 0;
      do fragment = byId.get(fragment)?.parent ?? null; while (fragment && !kept.has(fragment));
      const f = fragment ? byId.get(fragment)! : null;
      arm = f ? [f.first, ...f.branches.map(b => b.first)].reduce((a, first, i) => first <= at ? i : a, 0) : undefined;
    }
    return [{ ...n, participant, after: after(n.after), fragment, arm }];
  });
  return { participants: data.participants.filter(p => !folding.has(p.id)), messages, fragments, notes };
}
