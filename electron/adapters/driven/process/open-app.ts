import { execFile } from 'node:child_process';
import type { AppOpener } from '../../../core/runtime';

export const openApp: AppOpener = (app, url) => new Promise(resolve => execFile('/usr/bin/open', ['-a', app, url], { timeout: 5000 }, error => resolve(!error)));
