import { stateSchema, type State } from '../../../shared/contracts/git';
import type { StateRepository } from './ports';

/** Repositories and workspaces. `directory` is the app data dir (managed worktrees live in <directory>/worktrees). */
export class Store {
  constructor(readonly directory: string, private readonly repository: StateRepository) {}
  load(): Promise<State> { return this.repository.load(); }
  async save(state: State) { await this.repository.save(stateSchema.parse(state)); }
}
