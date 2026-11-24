// ELK in a web worker for the renderer. The prebuilt elk-worker script is loaded as a classic worker from its
// emitted asset URL, untouched by the bundler, so it also works from file:// in the packaged app.
import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { ElkLayouter } from './er-layout';

let elk: ElkLayouter | null = null;
export function sharedElk(): ElkLayouter {
  return elk ??= new ELK({ workerFactory: () => new Worker(elkWorkerUrl) });
}
