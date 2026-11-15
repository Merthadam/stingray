// "Save as view…": writes a new `.stingray/views/<slug>.yaml` derived from the shown view (builtin database or a repo view).
// Repo views are copied through the YAML Document API so their comments and key order survive.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Document, isMap, isSeq, parseDocument } from 'yaml';
import type { SaveViewInput, SaveViewResult } from '../../src/views';
import { MAX_VIEW_FILE_BYTES, MAX_VIEW_FILES, VIEWS_DIR, VIEW_SLUG, readBounded } from './view-file';
import { parseViewYaml } from './rules/schema';

/** File slug for a view name: lowercase a-z/0-9 words joined by "-", at most 64 characters. */
export const viewSlug = (name: string) =>
  name.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').slice(0, 64).replace(/^-+|-+$/g, '');

/** Create each missing directory of VIEWS_DIR; existing ones must be real directories (not symlinks). */
async function viewsDir(root: string) {
  const parts = VIEWS_DIR.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const dir = path.join(root, ...parts.slice(0, i));
    try {
      if (!(await lstat(dir)).isDirectory()) throw new Error(`${parts.slice(0, i).join('/')} must be a real directory (symlinks are not followed)`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(dir);
    }
  }
}

async function baseDocument(root: string, basedOn: string): Promise<Document> {
  if (basedOn === 'database') return new Document({ version: 1, name: '', kind: 'tables', use: ['sqlalchemy'] });
  if (!VIEW_SLUG.test(basedOn)) throw new Error(`Unknown view: ${basedOn}`);
  const file = `${VIEWS_DIR}/${basedOn}.yaml`;
  let read;
  try { read = await readBounded(path.join(root, file), 'View file'); } catch { throw new Error(`Could not read ${file}`); }
  if ('error' in read) throw new Error(`${file}: ${read.error}`);
  parseViewYaml(read.text, file); // only valid views are copied (throws YamlError with the line)
  return parseDocument(read.text);
}

export async function saveViewAs(root: string, input: SaveViewInput): Promise<SaveViewResult> {
  const name = input.name.trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Use a name of 1-80 characters.');
  const slug = viewSlug(name);
  if (!slug) throw new Error('The name needs at least one letter or digit (a-z, 0-9).');
  if (slug === 'database') throw new Error('"database" is reserved for the builtin view; choose another name.');
  const file = `${VIEWS_DIR}/${slug}.yaml`;

  const doc = await baseDocument(root, input.basedOn);
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
  if (Buffer.byteLength(text) > MAX_VIEW_FILE_BYTES) throw new Error('The view would be larger than 64 KiB; save fewer positions or exclusions.');
  parseViewYaml(text, file);

  await viewsDir(root);
  // Only the first MAX_VIEW_FILES are listed; a view past that would be saved but never shown.
  const count = (await readdir(path.join(root, VIEWS_DIR))).filter(n => n.endsWith('.yaml')).length;
  if (count >= MAX_VIEW_FILES) throw new Error(`${VIEWS_DIR} already has ${count} views (the limit is ${MAX_VIEW_FILES}); remove one first.`);
  let handle;
  try {
    handle = await open(path.join(root, file), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${file} already exists; choose another name.`);
    throw error;
  }
  try { await handle.writeFile(text); } catch (error) {
    await handle.close(); await unlink(path.join(root, file)).catch(() => {}); // a partial file would block every retry
    throw error;
  }
  await handle.close();
  return { id: slug, file };
}
