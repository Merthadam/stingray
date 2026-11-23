// Reading order of a sequence diagram (kind: sequence), shared by the text printer (views-text.ts) and the SVG layout
// (views-ui/sequence-layout.ts) so both nest fragments, branches and notes the same way. Pure.
import type { SequenceData, SequenceFragment, SequenceMessage, SequenceNote } from '../contracts/views';

/** `depth` = fragments open around the event (an open/close/branch line counts its own fragment's parents only). */
export type SequenceEvent =
  | { type: 'open'; fragment: SequenceFragment; depth: number }
  | { type: 'branch'; fragment: SequenceFragment; label: string; depth: number }
  | { type: 'message'; message: SequenceMessage; row: number; depth: number }
  | { type: 'note'; note: SequenceNote; depth: number }
  | { type: 'close'; fragment: SequenceFragment; depth: number };

/** Fragments as a tree (`parent`), each arm holding its rows [arm.first, next arm.first - 1], its child fragments (by their
 * first row) and the notes placed in it (`note.fragment`/`note.arm`; notes without go to the top level). Arms without rows
 * (only notes: `first` = the next arm's first, or `fragment.last + 1` for the last) are still drawn. Inside an arm, a note
 * after row r comes after row r's message and before a fragment opening at r + 1. Fragments past the last message are
 * dropped; ones with an unknown parent count as top level. */
export function sequenceEvents({ messages, fragments, notes }: SequenceData): SequenceEvent[] {
  const ids = new Set(fragments.map(f => f.id));
  const notesIn = new Map<string, SequenceNote[]>(); // "<fragment id>#<arm>", "" = top level
  for (const n of notes) {
    const f = n.fragment && ids.has(n.fragment) ? fragments.find(x => x.id === n.fragment)! : null;
    const key = f ? `${f.id}#${Math.min(Math.max(0, n.arm ?? 0), f.branches.length)}` : '';
    notesIn.set(key, [...notesIn.get(key) ?? [], n]);
  }
  const events: SequenceEvent[] = [];
  const range = (from: number, to: number, parent: string | null, key: string, depth: number) => {
    const items: { at: number; emit: () => void }[] = [];
    const children = fragments.filter(f => (f.parent !== null && ids.has(f.parent) ? f.parent : null) === parent && f.first >= from && f.first <= to && f.first < messages.length);
    for (const f of children) items.push({ at: f.first - 0.25, emit: () => fragment(f, depth) });
    for (const note of notesIn.get(key) ?? []) items.push({ at: note.after + 0.5, emit: () => events.push({ type: 'note', note, depth }) });
    for (let row = from; row <= Math.min(to, messages.length - 1); row++) {
      if (children.some(f => row >= f.first && row <= f.last)) continue;
      const message = messages[row];
      items.push({ at: row, emit: () => events.push({ type: 'message', message, row, depth }) });
    }
    items.sort((a, b) => a.at - b.at).forEach(i => i.emit()); // stable: notes keep their order
  };
  const fragment = (f: SequenceFragment, depth: number) => {
    const arms = [{ label: f.label, first: f.first }, ...f.branches];
    events.push({ type: 'open', fragment: f, depth });
    arms.forEach((arm, i) => {
      if (i) events.push({ type: 'branch', fragment: f, label: arm.label, depth });
      range(arm.first, Math.min(f.last, (arms[i + 1]?.first ?? f.last + 1) - 1), f.id, `${f.id}#${i}`, depth + 1);
    });
    events.push({ type: 'close', fragment: f, depth });
  };
  range(0, messages.length - 1, null, '', 0);
  return events;
}
