import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { SchemaFiles } from '../../../core/db-schema';
import { walkFiles } from './walk';

const MAX_FILE_BYTES = 1024 * 1024;
export const nodeSchemaFiles: SchemaFiles = {
  list: (root, keep, onDirError) => walkFiles(root, { keep, skipDotDirs: true, maxEntries: 20_000, onDirError }),
  async read(root, rel) {
    // O_NONBLOCK keeps a FIFO swapped in after readdir from blocking a libuv thread.
    const handle = await open(path.join(root, rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { skipped: 'notFile' };
      if (stat.size > MAX_FILE_BYTES) return { skipped: 'tooLarge' };
      return { text: (await handle.readFile()).toString('utf8') };
    } finally { await handle.close(); }
  },
};
