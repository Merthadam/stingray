import type { State } from '../../../../shared/contracts/git';
import type { StateRepository } from '../../../core/git';
import { database, readState, transaction, writeState } from './database';

/** The `repos` and `workspaces` tables of the app database. */
export function sqliteStateRepository(directory: string): StateRepository {
  return {
    async load() { return readState(database(directory)); },
    async save(state: State) { const db = database(directory); transaction(db, () => writeState(db, state)); },
  };
}
