import { app } from 'electron';
import { closeDatabase } from '../adapters/driven/sqlite/database';
import type { Services } from './compose';

/** Quit cleanup, same order as before: flush history → close terminals → dispose git state → close activity + views → close database. */
export function registerQuit(s: Services, dataDir: string) {
  app.on('window-all-closed', () => app.quit());
  let cleanedUp = false;
  app.on('will-quit', event => {
    if (cleanedUp) return;
    event.preventDefault(); s.activity.flushHistory(); s.terminals.closeAll(); s.gitState.dispose(); // flush first: closing terminals drops their entries
    void Promise.allSettled([s.activity.close(), s.views.dispose()]).finally(() => { closeDatabase(dataDir); cleanedUp = true; app.quit(); });
  });
}
