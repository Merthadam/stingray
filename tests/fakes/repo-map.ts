import type { RepoInventory, WorkingFiles } from '../../electron/core/repo-map';

/** Scripted inventory: answers by the first git argument; records every call. */
export function scriptedInventory(answers: { lsFiles?: string; numstat?: string; nameStatus?: string; mergeBase?: string | Error; grep?: string | Error; head?: 'born' | 'unborn' }) {
  const calls: string[][] = [];
  const inventory: RepoInventory = {
    async run(_root, args) {
      calls.push(args);
      if (args[0] === 'ls-files') return answers.lsFiles ?? '';
      if (args[0] === 'merge-base') { if (answers.mergeBase instanceof Error || answers.mergeBase === undefined) throw answers.mergeBase ?? new Error('no merge-base'); return answers.mergeBase; }
      if (args[0] === 'diff' && args[1] === '--name-status') return answers.nameStatus ?? '';
      if (args[0] === 'diff') return answers.numstat ?? '';
      if (args[0] === 'grep') { if (answers.grep instanceof Error) throw answers.grep; return answers.grep ?? ''; }
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
    async bytes(_root, args) { calls.push(args); return new Uint8Array(); },
    async head() { calls.push(['head']); return answers.head ?? 'born'; },
  };
  return { inventory, calls };
}
export function memoryFiles(contents: Record<string, string>): WorkingFiles {
  return {
    realpath: async p => p,
    read: async (_root, rel) => (rel in contents ? new TextEncoder().encode(contents[rel]) : null),
    probe: async (_root, rel) => (!(rel in contents) ? 'missing' : contents[rel] === '' ? 'emptyFile' : 'other'),
    stat: async (_root, rel) => (rel in contents ? { exists: true, size: contents[rel].length, mtimeMs: 1 } : { exists: false, size: 0, mtimeMs: 0 }),
  };
}
