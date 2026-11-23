// Activity core + hook socket + real adapters under the names and signatures the rest of the app and the existing tests use.
import type { ActivitySnapshot } from '../../../shared/contracts/activity';
import { startActivitySocket, type ActivitySocket } from '../../adapters/driving/hooks/activity-socket';
import { nodeProcessProbe } from '../../adapters/driven/process/process-probe';
import { SqliteActivityHistory } from '../../adapters/driven/sqlite/activity-history-repository';
import { ActivityService as CoreActivityService } from '../../core/activity';

export { SqliteActivityHistory as ActivityHistory };
export { ActivityShell, shellQuote } from '../../adapters/driven/fs/activity-shell';
export { claudeHookEvents } from '../../core/activity';

export class ActivityService extends CoreActivityService {
  private socket?: ActivitySocket;
  constructor(publish: (snapshot: ActivitySnapshot) => void, leaseMs = 20000, hookWorkingMs = 15 * leaseMs, persistMs = 1000) {
    super(publish, { leaseMs, hookWorkingMs, persistMs, probe: nodeProcessProbe });
  }
  async start() {
    try {
      this.socket = await startActivitySocket(this, { leaseMs: this.leaseMs });
      this.directory = this.socket.directory; this.endpoint = this.socket.endpoint;
      this.startLiveness();
    } catch (error) { await this.close(); throw error; }
  }
  async close() { super.close(); await this.socket?.close(); this.socket = undefined; }
}
