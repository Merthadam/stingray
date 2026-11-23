import { stateSchema, type State } from '../../../shared/contracts/git';
import { database, readState, transaction, writeState } from '../../adapters/driven/sqlite/database';

/** Repositories and workspaces, in the `repos` and `workspaces` tables of the app database. */
export class Store {
  constructor(readonly directory: string) {}
  async load(): Promise<State> {
    return readState(database(this.directory));
  }
  async save(state: State) {
    const parsed = stateSchema.parse(state);
    const db = database(this.directory);
    transaction(db, () => writeState(db, parsed));
  }
}
