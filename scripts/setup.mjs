import { spawnSync } from 'node:child_process';
import { access, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
const result = spawnSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.platform === 'darwin') {
  const helper = 'node_modules/node-pty/prebuilds/darwin-' + process.arch + '/spawn-helper';
  await access(helper, constants.F_OK);
  await chmod(helper, 0o755);
}
console.log('Project-local Electron and PTY helper are ready.');
