import type { SchemaFiles } from '../../electron/core/db-schema';

export function memorySchemaFiles(files: Record<string, string | 'tooLarge'>, unreadableDirs: string[] = []): SchemaFiles {
  return {
    async list(_root, keep, onDirError) {
      for (const dir of unreadableDirs) onDirError(dir, new Error('EACCES: permission denied'));
      const kept = Object.keys(files).filter(f => !unreadableDirs.some(d => f.startsWith(d + '/')) && keep(f)).sort();
      return { files: kept, truncated: false };
    },
    async read(_root, rel) { const v = files[rel]; return v === 'tooLarge' ? { skipped: 'tooLarge' } : { text: v }; },
  };
}
