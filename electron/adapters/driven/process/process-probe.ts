import type { ProcessProbe } from '../../../core/activity';

export const nodeProcessProbe: ProcessProbe = {
  alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } },
};
