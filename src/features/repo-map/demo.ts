import type { Events, Invoke } from '../../../shared/contracts/define';
import type { repoMapContract } from '../../../shared/contracts/repo-map';
import type { DemoContext } from '../../shared/demo-context';

export function createRepoMapDemo(ctx: DemoContext): Invoke<typeof repoMapContract> & Events<typeof repoMapContract> {
  return {
    repoSnapshot: async id => ({
      lines: { kind: 'available' as const, added: id === ctx.mainId ? 8 : 124, deleted: id === ctx.mainId ? 2 : 36, binaryFiles: 0 },
      uncommitted: ctx.uncommitted, base: 'origin/main' as const,
      branch: ctx.state.workspaces.find(w => w.id === id)?.branch || 'unknown',
      changes: ctx.files.filter(file => file.status),
      files: ctx.files,
      statsNotice: 'Simulated demo counts, not a real repository. Desktop counts use Git.',
    }),
    inspectFile: async (_id, path) => {
      const file = ctx.files.find(file => file.path === path);
      if (!file) throw new Error('Demo file not found.');
      const content = file.status.includes('D') ? '// Previous version\n' : ctx.content(path);
      const { added, removed } = file.lines!;
      return { path, content, source: file.status.includes('D') ? 'HEAD' : 'working tree', staged: '',
        unstaged: file.status ? `--- ${removed ? 'a/' + path : '/dev/null'}\n+++ ${added ? 'b/' + path : '/dev/null'}\n@@ -${removed ? 1 : 0},${removed} +${added ? 1 : 0},${added} @@\n` + (removed ? '-// Previous version\n' : '') + (added ? content.trimEnd().split('\n').map(line => '+' + line).join('\n') + '\n' : '') : '',
        notice: file.status.includes('D') ? 'Deleted file · showing simulated HEAD contents.' : '',
        revision: 'demo-' + path,
      };
    },
  };
}
