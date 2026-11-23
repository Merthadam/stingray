// Workspace create/remove side effects of other features (back-edges as listeners, not imports). Listeners of a phase
// run independently (Promise.allSettled); only safety-critical beforeRemove listeners are blocking (rule 3).
type Listener = (workspaceId: string) => void | Promise<void>;
type Entry = { name: string; run: Listener; blocking: boolean };

export class WorkspaceLifecycle {
  private readonly created: Entry[] = [];
  private readonly before: Entry[] = [];
  private readonly after: Entry[] = [];
  private readonly failed: Entry[] = [];
  constructor(private readonly log: (message: string, error: unknown) => void = (message, error) => console.error(message, error)) {}

  onCreated(name: string, run: Listener) { this.created.push({ name, run, blocking: false }); }
  /** blocking: a rejection aborts the removal (after every beforeRemove listener ran). */
  onBeforeRemove(name: string, run: Listener, options: { blocking?: boolean } = {}) { this.before.push({ name, run, blocking: options.blocking ?? false }); }
  onAfterRemove(name: string, run: Listener) { this.after.push({ name, run, blocking: false }); }
  onRemoveFailed(name: string, run: Listener) { this.failed.push({ name, run, blocking: false }); }

  async runCreated(id: string) { await this.run(this.created, id, 'created'); }
  async runBeforeRemove(id: string) { const blocking = await this.run(this.before, id, 'beforeRemove'); if (blocking) throw blocking.error; }
  async runAfterRemove(id: string) { await this.run(this.after, id, 'afterRemove'); }
  async runRemoveFailed(id: string) { await this.run(this.failed, id, 'removeFailed'); }

  private async run(entries: Entry[], id: string, phase: string): Promise<{ error: unknown } | undefined> {
    const results = await Promise.allSettled(entries.map(entry => Promise.resolve().then(() => entry.run(id))));
    let blocking: { error: unknown } | undefined;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') return;
      this.log(`Workspace ${phase} listener "${entries[i].name}" failed:`, result.reason);
      if (entries[i].blocking && !blocking) blocking = { error: result.reason };
    });
    return blocking;
  }
}
