// "Save as view…": writes a new `.stingray/views/<slug>.yaml` derived from the shown view (builtin database or a repo view).
// Repo views are copied through the YAML Document API so their comments and key order survive.
import { Document, isMap, isSeq, parseDocument } from 'yaml';
import type { SaveViewInput, SaveViewResult } from '../../../shared/contracts/views';
import { MAX_VIEW_FILE_BYTES, MAX_VIEW_FILES, VIEWS_DIR, VIEW_SLUG } from './view-file';
import type { ViewFiles } from './ports';
import { parseViewYaml } from './rules/schema';

/** File slug for a view name: lowercase a-z/0-9 words joined by "-", at most 64 characters. */
export const viewSlug = (name: string) =>
  name.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').slice(0, 64).replace(/^-+|-+$/g, '');

/** Create each missing directory of VIEWS_DIR; existing ones must be real directories (not symlinks). */
async function viewsDir(files: ViewFiles, root: string) {
  const parts = VIEWS_DIR.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    try {
      if ((await files.kind(root, dir)) !== 'directory') throw new Error(`${dir} must be a real directory (symlinks are not followed)`);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      await files.mkdir(root, dir);
    }
  }
}

async function baseDocument(files: ViewFiles, root: string, basedOn: string): Promise<Document> {
  if (basedOn === 'database') return new Document({ version: 1, name: '', kind: 'tables', use: ['sqlalchemy', 'sql'] });
  if (basedOn === 'layers') return new Document({ version: 1, name: '', kind: 'graph', layers: { depth: 1 } });
  if (!VIEW_SLUG.test(basedOn)) throw new Error(`Unknown view: ${basedOn}`);
  const file = `${VIEWS_DIR}/${basedOn}.yaml`;
  let read;
  try { read = await files.readBounded(root, file, 'View file'); } catch { throw new Error(`Could not read ${file}`); }
  if ('error' in read) throw new Error(`${file}: ${read.error}`);
  parseViewYaml(read.text, file); // only valid views are copied (throws YamlError with the line)
  return parseDocument(read.text);
}

export async function saveViewAs(files: ViewFiles, root: string, input: SaveViewInput): Promise<SaveViewResult> {
  const name = input.name.trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Use a name of 1-80 characters.');
  const slug = viewSlug(name);
  if (!slug) throw new Error('The name needs at least one letter or digit (a-z, 0-9).');
  if (slug === 'database' || slug === 'layers') throw new Error(`"${slug}" is reserved for a builtin view; choose another name.`);
  const file = `${VIEWS_DIR}/${slug}.yaml`;

  const doc = await baseDocument(files, root, input.basedOn);
  doc.set('name', name);
  const exclude = doc.get('exclude');
  const existing = (doc.toJS() as { exclude?: string[] }).exclude ?? [];
  const added = [...new Set(input.exclude)].filter(label => !existing.includes(label));
  if (isSeq(exclude)) for (const label of added) exclude.add(doc.createNode(label));
  else if (added.length) doc.set('exclude', added);
  if (input.layout) {
    const positions = doc.createNode(input.layout.positions);
    if (isMap(positions)) for (const pair of positions.items) if (isMap(pair.value)) pair.value.flow = true; // one line per node
    doc.set('layout', doc.createNode({ positions }));
  }
  const text = doc.toString();
  if (new TextEncoder().encode(text).length > MAX_VIEW_FILE_BYTES) throw new Error('The view would be larger than 64 KiB; save fewer positions or exclusions.');
  parseViewYaml(text, file);

  await viewsDir(files, root);
  // Only the first MAX_VIEW_FILES are listed; a view past that would be saved but never shown.
  const count = (await files.list(root, VIEWS_DIR)).map(e => e.name).filter(n => n.endsWith('.yaml')).length;
  if (count >= MAX_VIEW_FILES) throw new Error(`${VIEWS_DIR} already has ${count} views (the limit is ${MAX_VIEW_FILES}); remove one first.`);
  try { await files.createExclusive(root, file, text); } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') throw new Error(`${file} already exists; choose another name.`);
    throw error;
  }
  return { id: slug, file };
}
