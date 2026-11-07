// Sidebar rows share a small concurrency budget instead of launching one process
// per row at once. Callers still coalesce repeated reads for the same workspace.
export function createReadQueue(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid read concurrency');
  let running = 0;
  const waiting: (() => void)[] = [];
  return function enqueue<T>(read: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        running++;
        void Promise.resolve().then(read).then(resolve, reject).finally(() => {
          running--;
          waiting.shift()?.();
        });
      };
      if (running < limit) start(); else waiting.push(start);
    });
  };
}
export const queueWorkspaceRead = createReadQueue(3);
