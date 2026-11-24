import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LinkTargets } from '../../../core/terminals';

export const nodeLinkTargets: LinkTargets = {
  resolveUrl: (input, workspace) => new URL(input, pathToFileURL(path.resolve(workspace) + path.sep)),
  async realTarget(url, workspace) {
    const root = await realpath(workspace), target = await realpath(fileURLToPath(url));
    const relative = path.relative(root, target);
    return { target, inside: !(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) };
  },
  async stat(target) { const info = await stat(target); return { isFile: info.isFile(), isDirectory: info.isDirectory(), mode: info.mode }; },
};
