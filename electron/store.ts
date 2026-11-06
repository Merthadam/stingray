import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stateSchema, type State } from '../src/shared';

export class Store {
  constructor(readonly directory: string) {}
  async load(): Promise<State> {
    try {
      const raw = await readFile(path.join(this.directory, 'workspaces.json'), 'utf8');
      return stateSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, repos: [], workspaces: [] };
      throw new Error('Workspace storage could not be read. Your saved file was not overwritten. Restore a valid workspaces.json to continue.');
    }
  }
  async save(state: State) {
    stateSchema.parse(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, 'workspaces.json');
    await writeFile(target + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(target + '.tmp', target);
  }
}
