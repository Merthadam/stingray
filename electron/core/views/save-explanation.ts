// "Describe…" in the Views tab: sets or removes one `explain:` entry of a repo view file through the YAML Document API, so
// the file's comments, key order and formatting survive.
import { isMap, parseDocument } from 'yaml';
import { MAX_VIEW_FILE_BYTES } from './view-file';
import { explainPair, parseViewYaml } from './rules/schema';

/** `text` (the view file) with `explain.<key>` set to `{ text, fingerprint }` (no fingerprint when null: unstamped), or
 * removed when `entry` is null (`explain:` itself goes once empty). Throws when the result is not a valid view file. Pure. */
export function withExplanation(text: string, file: string, key: string, entry: { text: string; fingerprint: Record<string, string> | null } | null): string {
  const doc = parseDocument(text);
  const pair = explainPair(doc, key), explain = doc.get('explain', true);
  if (!entry) {
    if (!pair || !isMap(explain)) return text;
    explain.items.splice(explain.items.indexOf(pair), 1);
    if (!explain.items.length) doc.delete('explain');
  } else if (isMap(pair?.value)) {
    pair.value.set('text', entry.text);
    if (entry.fingerprint) pair.value.set('fingerprint', doc.createNode(entry.fingerprint));
    else pair.value.delete('fingerprint');
  } else {
    const value = doc.createNode(entry.fingerprint ? entry : { text: entry.text });
    if (isMap(explain)) explain.set(key, value);
    else doc.set('explain', doc.createNode({ [key]: value }));
  }
  const out = doc.toString({ lineWidth: 0 });
  if (new TextEncoder().encode(out).length > MAX_VIEW_FILE_BYTES) throw new Error('The view file would be larger than 64 KiB.');
  parseViewYaml(out, file); // throws YamlError with the line
  return out;
}
