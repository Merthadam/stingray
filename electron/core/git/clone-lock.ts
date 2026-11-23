/** One clone at a time; the window close guard reads `busy`. */
export class CloneLock {
  private running = false;
  get busy() { return this.running; }
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.running) throw new Error('A clone is already in progress. Wait for it to finish.');
    this.running = true;
    try { return await action(); } finally { this.running = false; }
  }
}
