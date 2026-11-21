// Reading order of a sequence diagram (kind: sequence), shared by the text printer (views-text.ts) and the SVG layout
// (views-ui/sequence-layout.ts) so both nest fragments, branches and notes the same way. Pure.
import type { SequenceData, SequenceFragment, SequenceMessage, SequenceNote } from './views';

/** `depth` = fragments open around the event (an open/close/branch line counts its own fragment's parents only). */
export type SequenceEvent =
  | { type: 'open'; fragment: SequenceFragment; depth: number }
  | { type: 'branch'; fragment: SequenceFragment; label: string; depth: number }
  | { type: 'message'; message: SequenceMessage; row: number; depth: number }
  | { type: 'note'; note: SequenceNote; depth: number }
  | { type: 'close'; fragment: SequenceFragment; depth: number };

/** Per row: fragments opening (outer first), branches starting, the message, notes after it, fragments closing (inner first).
 * A branch with no message of its own (first > last: e.g. an `else` holding only an error note) is drawn when its fragment
 * closes, and the notes after that row go into it. Fragments starting past the last message are dropped; ones ending past it
 * or after their parent close with the innermost fragment around them. */
export function sequenceEvents({ messages, fragments, notes }: SequenceData): SequenceEvent[] {
  const byId = new Map(fragments.map(f => [f.id, f]));
  const nesting = (f: SequenceFragment, seen = new Set<string>()): number => {
    const parent = f.parent ? byId.get(f.parent) : undefined;
    return parent && !seen.has(parent.id) ? 1 + nesting(parent, seen.add(f.id)) : 0;
  };
  const outerFirst = (a: SequenceFragment, b: SequenceFragment) => nesting(a) - nesting(b) || (b.last - b.first) - (a.last - a.first);
  const events: SequenceEvent[] = [], open: SequenceFragment[] = [];
  const notesAfter = (row: number) => notes.filter(n => n.after === row).forEach(note => events.push({ type: 'note', note, depth: open.length }));
  notesAfter(-1);
  messages.forEach((message, row) => {
    for (const fragment of fragments.filter(f => f.first === row && f.last >= row).sort(outerFirst)) {
      events.push({ type: 'open', fragment, depth: open.length });
      open.push(fragment);
    }
    for (const fragment of open) for (const b of fragment.branches) {
      if (b.first === row && row > fragment.first) events.push({ type: 'branch', fragment, label: b.label, depth: open.indexOf(fragment) });
    }
    events.push({ type: 'message', message, row, depth: open.length });
    const empty = (f: SequenceFragment) => f.branches.filter(b => b.first > f.last);
    let noted = false;
    const note = () => { if (!noted) notesAfter(row); noted = true; };
    if (!open.some(f => f.last <= row && empty(f).length)) note();
    while (open.length && open[open.length - 1].last <= row) {
      const fragment = open[open.length - 1];
      for (const b of empty(fragment)) events.push({ type: 'branch', fragment, label: b.label, depth: open.length - 1 });
      if (empty(fragment).length) note();
      open.pop();
      events.push({ type: 'close', fragment, depth: open.length });
    }
    note();
  });
  while (open.length) events.push({ type: 'close', fragment: open.pop()!, depth: open.length });
  return events;
}
