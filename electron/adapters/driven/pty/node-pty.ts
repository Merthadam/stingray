import * as pty from 'node-pty';
import os from 'node:os';
import type { MirrorFactory, PtySpawner } from '../../../core/terminals';
import { TerminalMirror } from './terminal-mirror';

export const nodePtySpawner: PtySpawner = {
  shell: () => os.userInfo().shell || '/bin/zsh',
  env: () => process.env,
  spawn: (file, args, options) => pty.spawn(file, args, options),
};
export const headlessMirrors: MirrorFactory = (cols, rows) => new TerminalMirror(cols, rows);
