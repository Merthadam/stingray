// When the code-graph worker may be (re)started: backoff 1 s, 2 s, 4 s after quick crashes (each within 30 s of its
// start); after more than 3 quick crashes it stays down until an open() 30 s after the last crash (audit 5).
const QUICK_MS = 30_000, MAX_QUICK = 3;
export class RestartPolicy {
  private crashes = 0; private startedAt = 0; private lastCrashAt = 0; private pending = false;
  private readonly now: () => number;
  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }
  started() { this.startedAt = this.now(); }
  /** A crash (not a deliberate kill). Returns the restart delay, or null when no automatic restart follows. */
  crashed(hasActiveGraphs: boolean): number | null {
    this.crashes = this.now() - this.startedAt < QUICK_MS ? this.crashes + 1 : 1;
    this.lastCrashAt = this.now();
    if (this.crashes > MAX_QUICK || !hasActiveGraphs) return null;
    this.pending = true;
    return 1000 * 2 ** (this.crashes - 1);
  }
  timerFired() { this.pending = false; }
  /** open() with no worker running. */
  mayRespawnOnOpen(): boolean {
    if (this.pending) return false;
    return !(this.crashes > MAX_QUICK && this.now() - this.lastCrashAt < QUICK_MS);
  }
}
