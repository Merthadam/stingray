// Per-user Views state (hidden nodes, positions, expansions) per worktree and view, in <userData>/view-state.json.
// Never written to the repo. Loaded once, then kept in memory; writes are serialized and atomic (tmp + rename).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ViewLocalState } from '../src/views';
import { positionsSchema } from './views/rules/schema';

const nodeIds = (max: number) => z.array(z.string().min(1).max(300)).max(max);
export const viewLocalStateSchema = z.strictObject({ hidden: nodeIds(2000), positions: positionsSchema, expanded: nodeIds(500) });
const fileSchema = z.strictObject({
  version: z.literal(1),
  views: z.record(z.string().max(400), z.strictObject({ updatedAt: z.number(), state: viewLocalStateSchema })),
});
type ViewStateFile = z.infer<typeof fileSchema>;

export const MAX_VIEW_STATES = 200, MAX_VIEW_STATE_BYTES = 5 * 1024 * 1024;
const key = (workspaceId: string, viewId: string) => `${workspaceId}:${viewId}`;

export class ViewStateStore {
  private data: Promise<ViewStateFile> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  readonly file: string;
  constructor(readonly directory: string) { this.file = path.join(directory, 'view-state.json'); }

  async get(workspaceId: string, viewId: string): Promise<ViewLocalState | null> {
    await this.writes.catch(() => {}); // a save sent just before (flush on view switch) must be visible
    return (await this.load()).views[key(workspaceId, viewId)]?.state ?? null;
  }

  async set(workspaceId: string, viewId: string, state: ViewLocalState): Promise<void> {
    const parsed = viewLocalStateSchema.parse(state);
    return this.update(data => { data.views[key(workspaceId, viewId)] = { updatedAt: Date.now(), state: parsed }; });
  }

  /** Drop all views of a removed workspace. */
  forget(workspaceId: string): Promise<void> {
    return this.update(data => { for (const k of Object.keys(data.views)) if (k.startsWith(workspaceId + ':')) delete data.views[k]; });
  }

  private load(): Promise<ViewStateFile> {
    this.data ??= this.read().catch(error => { this.data = null; throw error; }); // retry after e.g. EACCES
    return this.data;
  }

  private async read(): Promise<ViewStateFile> {
    let raw;
    try { raw = await readFile(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, views: {} };
      throw error;
    }
    try { return fileSchema.parse(JSON.parse(raw)); } catch {
      // Invalid JSON or schema mismatch: keep the file aside for inspection and start empty.
      await rename(this.file, this.file + '.corrupt').catch(() => {});
      return { version: 1, views: {} };
    }
  }

  private update(change: (data: ViewStateFile) => void): Promise<void> {
    const run = this.writes.then(async () => {
      const data = await this.load();
      change(data);
      await this.write(data);
    });
    this.writes = run.catch(() => {});
    return run;
  }

  private async write(data: ViewStateFile) {
    // Least recently updated views go first when over the count or size cap.
    const byAge = Object.entries(data.views).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    while (byAge.length > MAX_VIEW_STATES) delete data.views[byAge.shift()![0]];
    let text = JSON.stringify(data);
    while (Buffer.byteLength(text) > MAX_VIEW_STATE_BYTES && byAge.length) { delete data.views[byAge.shift()![0]]; text = JSON.stringify(data); }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.file + '.tmp', text, { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
  }
}
