// Geometry of a sequence diagram (SequenceDiagram.tsx): lifeline columns, one row per message, activation bars, fragment
// frames, notes. Pure and deterministic; text is measured by character count (monospace labels), so no DOM is needed.
// Body coordinates start at 0 under the (separately drawn, sticky) participant header.
import type { SequenceData, SequenceFragment, SequenceMessage, SequenceNote, SequenceParticipant } from '../views';
import { sequenceEvents } from '../sequence-events';

export const SEQ = {
  headerHeight: 66,   // participant boxes / actor figures
  top: 18, bottom: 30, side: 20,
  row: 38,            // message: label above, arrow at ARROW_Y
  arrowY: 27,
  selfRow: 48,        // self message: label beside a loop
  selfWidth: 30, selfDrop: 16,
  noteHeight: 26, noteGap: 10, noteMax: 300,
  fragmentHead: 30, branchHead: 28, fragmentFoot: 12, fragmentPad: 16, nestPad: 10,
  barWidth: 10, barNest: 5, minBar: 16,
  minGap: 36, labelPad: 18,
  charWidth: 6.6,     // 11px monospace (message labels, notes, fragment labels)
  headerChar: 7.4,    // 12px participant labels, semibold
  minBox: 104, maxBox: 230, boxPad: 30,
  maxLabel: 56,
};
export const UNCERTAIN = ' (uncertain)';

export interface LaidParticipant { participant: SequenceParticipant; x: number; width: number; label: string } // x = lifeline
export interface LaidMessage {
  message: SequenceMessage; row: number;
  y: number;                   // arrow
  x1: number; x2: number;      // arrow from / to (self: the loop starts and ends at x1)
  label: string;               // clipped; the renderer appends UNCERTAIN when !certain
  labelX: number;              // label anchor: middle of the arrow, or the start of a self message's label
  top: number; bottom: number; // hover band
}
export interface LaidActivation { participant: string; x: number; y: number; height: number }
export interface LaidFragment { fragment: SequenceFragment; x: number; y: number; width: number; height: number; depth: number; branches: { label: string; y: number }[] }
export interface LaidNote { note: SequenceNote; x: number; y: number; width: number; height: number; text: string }
export interface SequenceLayout {
  width: number; height: number; // body (under the header)
  participants: LaidParticipant[]; messages: LaidMessage[]; activations: LaidActivation[]; fragments: LaidFragment[]; notes: LaidNote[];
}

export const textWidth = (text: string, char = SEQ.charWidth) => Math.ceil(text.length * char);
export const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
const labelWidth = (m: SequenceMessage) => textWidth(clip(m.label, SEQ.maxLabel) + (m.certain ? '' : UNCERTAIN));
const noteText = (n: SequenceNote) => clip(n.text, Math.floor((SEQ.noteMax - 20) / SEQ.charWidth));
export const tabWidth = (kind: string) => textWidth(kind) + 18;

export function sequenceLayout(data: SequenceData): SequenceLayout {
  const S = SEQ, events = sequenceEvents(data);
  const columns = [...data.participants].sort((a, b) => a.column - b.column);
  const col = new Map(columns.map((p, i) => [p.id, i]));
  const n = columns.length;
  const boxChars = Math.floor((S.maxBox - S.boxPad) / S.headerChar);
  const width = columns.map(p => Math.min(S.maxBox, Math.max(S.minBox, textWidth(p.label, S.headerChar) + S.boxPad)));

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
    const c = col.get(note.participant), w = Math.min(S.noteMax, textWidth(noteText(note)) + 20) / 2;
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
  type Open = { fragment: SequenceFragment; y: number; depth: number; min: number; max: number; branches: { label: string; y: number }[] };
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
    if (e.type === 'open') { open.push({ fragment: e.fragment, y, depth: e.depth, min: Infinity, max: -Infinity, branches: [] }); y += S.fragmentHead; }
    else if (e.type === 'branch') { [...open].reverse().find(f => f.fragment === e.fragment)?.branches.push({ label: e.label, y: y + 2 }); y += S.branchHead; }
    else if (e.type === 'note') {
      const w = Math.min(S.noteMax, textWidth(noteText(e.note)) + 20), c = center(e.note.participant);
      notes.push({ note: e.note, x: c - w / 2, y: y + 2, width: w, height: S.noteHeight, text: noteText(e.note) });
      reach(c - w / 2, c + w / 2);
      y += S.noteHeight + S.noteGap;
    } else if (e.type === 'close') {
      const f = open.pop()!;
      if (f.min > f.max) { f.min = x[0] ?? S.side; f.max = f.min; }
      const left = f.min - S.fragmentPad;
      const labels = Math.max(tabWidth(f.fragment.kind) + textWidth(`[${clip(f.fragment.label, S.maxLabel)}]`) + 16,
        ...f.branches.map(b => textWidth(`[${clip(b.label, S.maxLabel)}]`) + 16));
      const right = Math.max(f.max + S.fragmentPad, left + labels);
      fragments.push({ fragment: f.fragment, x: left, y: f.y + 2, width: right - left, height: y + 4 - f.y, depth: f.depth, branches: f.branches });
      for (const parent of open) { parent.min = Math.min(parent.min, left - S.nestPad + S.fragmentPad); parent.max = Math.max(parent.max, right + S.nestPad - S.fragmentPad); }
      y += S.fragmentFoot;
    } else {
      const m = e.message, L = m.level, self = m.from === m.to || m.kind === 'self';
      const arrow = y + (self ? 12 : S.arrowY);
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
        push(m.to, L + 1, arrow + (self ? S.selfDrop : 0));
        x2 = edge(m.to, to);
      }
      const label = clip(m.label, S.maxLabel);
      const labelX = self ? x1 + S.selfWidth + 8 : (x1 + x2) / 2;
      messages.push({ message: m, row: e.row, y: arrow, x1, x2, label, labelX, top: y, bottom: y + (self ? S.selfRow : S.row) });
      reach(Math.min(x1, x2) - S.barWidth, self ? labelX + labelWidth(m) : Math.max(x1, x2) + S.barWidth);
      lastArrow = self ? arrow + S.selfDrop : arrow;
      y += self ? S.selfRow : S.row;
    }
  }
  while (stack.length) end(Math.max(lastArrow, y - S.row / 2));

  const right = Math.max(n ? x[n - 1] + half[n - 1] : 0, ...fragments.map(f => f.x + f.width), ...notes.map(nt => nt.x + nt.width),
    ...messages.map(m => m.message.from === m.message.to || m.message.kind === 'self' ? m.labelX + labelWidth(m.message) : 0));
  return {
    width: Math.ceil(right + S.side), height: Math.ceil(y + S.bottom),
    participants: columns.map((participant, i) => ({ participant, x: x[i], width: width[i], label: clip(participant.label, boxChars) })),
    messages, activations, fragments, notes,
  };
}
