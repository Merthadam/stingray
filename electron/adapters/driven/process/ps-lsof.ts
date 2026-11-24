import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scanError, type PortScanner } from '../../../core/runtime';

const exec = promisify(execFile);
export const psLsof: PortScanner = async (file, args) => {
  try { return (await exec(file, args, { timeout: 3000, maxBuffer: 1024 * 1024 })).stdout; }
  catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    // lsof exits 1 for an empty selection. Diagnostics or timeouts are NOT empty success.
    if (file === '/usr/sbin/lsof' && e.code === 1 && !e.killed && !e.stdout?.trim() && !e.stderr?.trim()) return '';
    throw new Error(scanError);
  }
};
