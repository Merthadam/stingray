import type { SettingsRepository } from '../../../core/shared/ports';
import { database } from './database';

/** The app database's settings table (key → value). Used by stinggraph settings and, from plan 06, editor settings. */
export function sqliteSettingsRepository(directory: string): SettingsRepository {
  return {
    get: key => (database(directory).prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value,
    set: (key, value) => { database(directory).prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value); },
  };
}
